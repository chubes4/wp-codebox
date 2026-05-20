import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { assertRuntimeCommandAllowed } from "@chubes4/wp-codebox-core"
import {
  MAX_CAPTURED_MOUNT_FILE_BYTES,
  MAX_CAPTURED_MOUNT_FILES,
  SKIPPED_CAPTURE_DIRECTORIES,
  ArtifactRedactor,
  artifactContentDigest,
  buildArtifactProvenance,
  buildArtifactReview,
  buildBlueprintAfter,
  buildBlueprintAfterNotes,
  buildTestResults,
  directoryDiff,
  fileEntry,
  isReplayableText,
  mountTargetPath,
  serializeCapturedMountFiles,
  type CapturedMountFiles,
  type ChangedFile,
  type MountDiff,
  type MountDiffsResult,
} from "./artifacts.js"
import { playgroundBlueprint } from "./blueprint.js"
import { abilityInputFromArgs, abilityPhpCode, argValue, benchRunCode, cleanWpCliOutput, isSafeEnvName, normalizePhpCode, phpBody, positiveIntegerArg, shellArgv, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
import type {
  ArtifactBundle,
  ArtifactManifest,
  ArtifactManifestFile,
  ArtifactSpec,
  ExecutionResult,
  ExecutionSpec,
  LifecycleEvent,
  MountSpec,
  ObservationResult,
  ObservationSpec,
  Runtime,
  RuntimeBackend,
  RuntimeCreateSpec,
  RuntimeInfo,
  Snapshot,
} from "@chubes4/wp-codebox-core"

function now(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface PlaygroundRunResponse {
  exitCode?: number
  errors?: string
  text: string
}

interface PlaygroundCliServer {
  playground: {
    run(options: { code: string } | { scriptPath: string }): Promise<PlaygroundRunResponse>
    writeFile?(path: string, contents: string): Promise<void>
  }
  [Symbol.asyncDispose](): Promise<void>
}

interface PlaygroundCliModule {
  runCLI(options: {
    command: "server"
    port: number
    quiet: boolean
    skipBrowser: boolean
    mount: Array<{ hostPath: string; vfsPath: string }>
    blueprint?: unknown
    wp?: string
  }): Promise<PlaygroundCliServer>
}

export class PlaygroundRuntimeBackend implements RuntimeBackend {
  readonly kind = "wordpress-playground" as const

  async create(spec: RuntimeCreateSpec): Promise<Runtime> {
    return PlaygroundRuntime.create(spec)
  }
}

class PlaygroundRuntime implements Runtime {
  private status: RuntimeInfo["status"] = "created"
  private readonly runtimeId = id("runtime")
  private readonly createdAt = now()
  private readonly mounts: MountSpec[] = []
  private readonly commands: ExecutionResult[] = []
  private readonly observations: ObservationResult[] = []
  private readonly events: LifecycleEvent[] = []
  private readonly artifactRoot: string
  private cliServerPromise?: Promise<PlaygroundCliServer>

  private constructor(private readonly spec: RuntimeCreateSpec) {
    this.artifactRoot = resolve(spec.artifactsDirectory ?? "artifacts", this.runtimeId)
  }

  static async create(spec: RuntimeCreateSpec): Promise<PlaygroundRuntime> {
    const runtime = new PlaygroundRuntime(spec)
    await mkdir(runtime.artifactRoot, { recursive: true })
    runtime.recordEvent("runtime.created", {
      backend: "wordpress-playground",
      environment: spec.environment,
      policy: spec.policy,
    })
    return runtime
  }

  async info(): Promise<RuntimeInfo> {
    return {
      id: this.runtimeId,
      backend: "wordpress-playground",
      environment: this.spec.environment,
      createdAt: this.createdAt,
      status: this.status,
    }
  }

  async mount(spec: MountSpec): Promise<void> {
    if (this.status === "destroyed") {
      throw new Error("Cannot mount into a destroyed runtime")
    }

    const mount = {
      ...spec,
      source: await realpath(spec.source),
    }

    this.mounts.push(mount)
    this.recordEvent("runtime.mounted", { mount })
  }

  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    assertRuntimeCommandAllowed(spec.command, this.spec.policy)

    const startedAt = now()
    const commandId = id("command")
    this.recordEvent("runtime.command.started", {
      id: commandId,
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? null,
      timeoutMs: spec.timeoutMs ?? null,
    })
    const result: ExecutionResult = {
      id: commandId,
      command: spec.command,
      args: spec.args ?? [],
      exitCode: 0,
      stdout: await this.executePlaygroundCommand(spec),
      stderr: "",
      startedAt,
      finishedAt: now(),
    }

    this.commands.push(result)
    this.recordEvent("runtime.command.finished", {
      id: result.id,
      command: result.command,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    })
    return result
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    const observation: ObservationResult = {
      type: spec.type,
      data: await this.observeStub(spec),
      observedAt: now(),
    }

    this.observations.push(observation)
    this.recordEvent("runtime.observed", {
      type: observation.type,
      observedAt: observation.observedAt,
    })
    return observation
  }

  async snapshot(): Promise<Snapshot> {
    const snapshot = {
      id: id("snapshot"),
      createdAt: now(),
      metadata: {
        runtime: await this.info(),
        mounts: this.mounts,
      },
    }

    this.recordEvent("runtime.snapshot.created", {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
    })

    return snapshot
  }

  async collectArtifacts(spec: ArtifactSpec = {}): Promise<ArtifactBundle> {
    await mkdir(this.artifactRoot, { recursive: true })
    const logsDirectory = join(this.artifactRoot, "logs")
    const filesDirectory = join(this.artifactRoot, "files")
    await mkdir(logsDirectory, { recursive: true })
    await mkdir(filesDirectory, { recursive: true })

    const createdAt = now()
    const manifestPath = join(this.artifactRoot, "manifest.json")
    const metadataPath = join(this.artifactRoot, "metadata.json")
    const blueprintAfterPath = join(this.artifactRoot, "blueprint.after.json")
    const blueprintAfterNotesPath = join(this.artifactRoot, "blueprint.after-notes.json")
    const eventsPath = join(this.artifactRoot, "events.jsonl")
    const commandsPath = join(this.artifactRoot, "commands.jsonl")
    const observationsPath = join(this.artifactRoot, "observations.jsonl")
    const runtimeLogPath = join(logsDirectory, "runtime.log")
    const commandsLogPath = join(logsDirectory, "commands.log")
    const mountsPath = join(filesDirectory, "mounts.json")
    const capturedMountsPath = join(filesDirectory, "mounted-files.json")
    const diffsPath = join(filesDirectory, "diffs.json")
    const changedFilesPath = join(filesDirectory, "changed-files.json")
    const patchPath = join(filesDirectory, "patch.diff")
    const testResultsPath = join(filesDirectory, "test-results.json")
    const reviewPath = join(filesDirectory, "review.json")
    const redactor = new ArtifactRedactor(this.spec.secretEnv)

    const runtime = await this.info()
    const capturedMounts = await this.captureMountedFiles(filesDirectory, redactor)
    const { mountDiffs, changedFiles, patch } = await this.captureMountDiffs(filesDirectory, redactor)
    const changedFilesJson = redactor.redact("files/changed-files.json", `${JSON.stringify(changedFiles, null, 2)}\n`)
    const redactedPatch = redactor.redact("files/patch.diff", patch)
    const contentDigest = artifactContentDigest(changedFilesJson, redactedPatch)
    const bundleId = `artifact-bundle-sha256-${contentDigest}`
    const contentDigestMetadata = {
      algorithm: "sha256",
      inputs: ["files/changed-files.json", "files/patch.diff"],
      value: contentDigest,
    }
    const provenance = buildArtifactProvenance({
      runtime,
      context: this.spec.metadata ?? {},
      mounts: this.mounts,
    })
    const metadata: Record<string, unknown> = {
      id: bundleId,
      contentDigest: contentDigestMetadata,
      createdAt,
      runtime,
      provenance,
      mounts: this.mounts,
      policy: this.spec.policy,
      context: this.spec.metadata ?? {},
      spec,
    }
    this.recordEvent("runtime.artifacts.collected", {
      id: bundleId,
      directory: this.artifactRoot,
      createdAt,
      spec,
    })
    const testResults = buildTestResults()
    const review = buildArtifactReview({
      artifactId: bundleId,
      createdAt,
      provenance,
      changedFiles,
      patch: redactedPatch,
      contentDigest,
      runtimeCreatedAt: this.createdAt,
      mounts: this.mounts,
    })
    const artifactFiles = {
      changedFiles: relative(this.artifactRoot, changedFilesPath),
      patch: relative(this.artifactRoot, patchPath),
      testResults: relative(this.artifactRoot, testResultsPath),
      review: relative(this.artifactRoot, reviewPath),
      mountDiffs: relative(this.artifactRoot, diffsPath),
    }
    metadata.artifacts = artifactFiles
    const blueprintAfter = buildBlueprintAfter({
      environment: this.spec.environment,
      capturedMounts,
    })
    const blueprintAfterNotes = buildBlueprintAfterNotes({
      createdAt,
      runtimeId: this.runtimeId,
      environment: this.spec.environment,
      mounts: this.mounts,
      capturedMounts,
    })

    const manifestFiles: ArtifactManifestFile[] = [
      fileEntry(manifestPath, "manifest", "application/json"),
      fileEntry(metadataPath, "metadata", "application/json"),
      fileEntry(blueprintAfterPath, "blueprint-after", "application/json"),
      fileEntry(blueprintAfterNotesPath, "blueprint-after-notes", "application/json"),
      fileEntry(eventsPath, "events", "application/x-ndjson"),
      fileEntry(commandsPath, "commands", "application/x-ndjson"),
      fileEntry(observationsPath, "observations", "application/x-ndjson"),
      fileEntry(runtimeLogPath, "log", "text/plain"),
      fileEntry(commandsLogPath, "log", "text/plain"),
      fileEntry(mountsPath, "mounts", "application/json"),
      fileEntry(capturedMountsPath, "mounted-files", "application/json"),
      fileEntry(diffsPath, "mount-diffs", "application/json"),
      fileEntry(changedFilesPath, "changed-files", "application/json"),
      fileEntry(patchPath, "patch", "text/x-diff"),
      fileEntry(testResultsPath, "test-results", "application/json"),
      fileEntry(reviewPath, "review", "application/json"),
      ...mountDiffs.map((diff) => fileEntry(join(this.artifactRoot, diff.artifactPath), "diff", "text/x-diff")),
      ...capturedMounts.files.map((file) =>
        fileEntry(join(this.artifactRoot, file.artifactPath), "file", file.contentType),
      ),
    ]

    const manifest: ArtifactManifest = {
      id: bundleId,
      contentDigest: {
        algorithm: "sha256",
        inputs: ["files/changed-files.json", "files/patch.diff"],
        value: contentDigest,
      },
      createdAt,
      runtime,
      files: manifestFiles.map((file) => ({
        ...file,
        path: relative(this.artifactRoot, file.path),
      })),
    }

    await writeRedactedArtifact(redactor, manifestPath, this.artifactRoot, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeRedactedArtifact(redactor, blueprintAfterPath, this.artifactRoot, `${JSON.stringify(blueprintAfter, null, 2)}\n`)
    await writeRedactedArtifact(redactor, blueprintAfterNotesPath, this.artifactRoot, `${JSON.stringify(blueprintAfterNotes, null, 2)}\n`)
    await writeJsonLines(eventsPath, this.events, redactor, this.artifactRoot)
    await writeJsonLines(commandsPath, this.commands, redactor, this.artifactRoot)
    await writeJsonLines(observationsPath, this.observations, redactor, this.artifactRoot)
    await writeRedactedArtifact(redactor, runtimeLogPath, this.artifactRoot, this.formatRuntimeLog())
    await writeRedactedArtifact(redactor, commandsLogPath, this.artifactRoot, this.formatCommandsLog())
    await writeRedactedArtifact(redactor, mountsPath, this.artifactRoot, `${JSON.stringify(this.mounts, null, 2)}\n`)
    await writeRedactedArtifact(redactor, capturedMountsPath, this.artifactRoot, `${JSON.stringify(serializeCapturedMountFiles(capturedMounts), null, 2)}\n`)
    await writeRedactedArtifact(redactor, diffsPath, this.artifactRoot, `${JSON.stringify(mountDiffs, null, 2)}\n`)
    await writeFile(changedFilesPath, changedFilesJson)
    await writeFile(patchPath, redactedPatch)
    await writeRedactedArtifact(redactor, testResultsPath, this.artifactRoot, `${JSON.stringify(testResults, null, 2)}\n`)
    const redaction = redactor.summary()
    if (redaction.total > 0) {
      review.redaction = redaction
      review.riskFlags.push("secrets-redacted")
    }
    await writeRedactedArtifact(redactor, reviewPath, this.artifactRoot, `${JSON.stringify(review, null, 2)}\n`)
    metadata.redaction = redactor.summary()
    await writeRedactedArtifact(redactor, metadataPath, this.artifactRoot, `${JSON.stringify(metadata, null, 2)}\n`)

    return {
      id: bundleId,
      directory: this.artifactRoot,
      manifestPath,
      metadataPath,
      blueprintAfterPath,
      blueprintAfterNotesPath,
      eventsPath,
      commandsPath,
      observationsPath,
      runtimeLogPath,
      commandsLogPath,
      mountsPath,
      capturedMountsPath,
      diffsPath,
      changedFilesPath,
      patchPath,
      testResultsPath,
      reviewPath,
      contentDigest,
      createdAt,
    }
  }

  private async captureMountedFiles(filesDirectory: string, redactor: ArtifactRedactor): Promise<CapturedMountFiles> {
    const captured: CapturedMountFiles = {
      files: [],
      skipped: [],
      limits: {
        maxFiles: MAX_CAPTURED_MOUNT_FILES,
        maxFileBytes: MAX_CAPTURED_MOUNT_FILE_BYTES,
        skippedDirectories: [...SKIPPED_CAPTURE_DIRECTORIES].sort(),
      },
    }

    for (const [mountIndex, mount] of this.mounts.entries()) {
      if (mount.mode !== "readwrite") {
        continue
      }

      const mountStats = await stat(mount.source)
      if (mountStats.isDirectory()) {
        await this.captureMountedDirectory(filesDirectory, captured, mount, mountIndex, mount.source, "", redactor)
        continue
      }

      if (mountStats.isFile()) {
        await this.captureMountedFile(filesDirectory, captured, mount, mountIndex, mount.source, basename(mount.source), redactor)
      }
    }

    return captured
  }

  private async captureMountDiffs(filesDirectory: string, redactor: ArtifactRedactor): Promise<MountDiffsResult> {
    const diffsDirectory = join(filesDirectory, "diffs")
    await mkdir(diffsDirectory, { recursive: true })
    const diffs: MountDiff[] = []
    const changedFiles: ChangedFile[] = []
    const patches: string[] = []

    for (const [mountIndex, mount] of this.mounts.entries()) {
      const baselineSource = typeof mount.metadata?.baselineSource === "string" ? mount.metadata.baselineSource : ""
      if (mount.mode !== "readwrite" || !baselineSource) {
        continue
      }

      const diff = await directoryDiff(baselineSource, mount.source, mount.target)
      const artifactPath = `files/diffs/mount-${mountIndex}.patch`
      await writeFile(join(this.artifactRoot, artifactPath), redactor.redact(artifactPath, diff.patch))
      diffs.push({
        mountIndex,
        source: mount.source,
        target: mount.target,
        baselineSource,
        artifactPath,
        changed: diff.patch.trim().length > 0,
      })
      patches.push(diff.patch)
      changedFiles.push(
        ...diff.files.map((file) => ({
          ...file,
          mountIndex,
          mountTarget: mount.target,
          patchPath: artifactPath,
        })),
      )
    }

    return {
      mountDiffs: diffs,
      changedFiles: {
        schema: "wp-codebox/changed-files/v1",
        files: changedFiles,
      },
      patch: patches.filter((patch) => patch.length > 0).join("\n"),
    }
  }

  private async captureMountedDirectory(
    filesDirectory: string,
    captured: CapturedMountFiles,
    mount: MountSpec,
    mountIndex: number,
    directory: string,
    relativeDirectory: string,
    redactor: ArtifactRedactor,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const sourcePath = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (SKIPPED_CAPTURE_DIRECTORIES.has(entry.name)) {
          captured.skipped.push({
            mountIndex,
            source: sourcePath,
            target: mountTargetPath(mount, relativePath),
            relativePath,
            reason: "directory-skipped",
          })
          continue
        }

        await this.captureMountedDirectory(filesDirectory, captured, mount, mountIndex, sourcePath, relativePath, redactor)
        continue
      }

      if (entry.isFile()) {
        await this.captureMountedFile(filesDirectory, captured, mount, mountIndex, sourcePath, relativePath, redactor)
      }
    }
  }

  private async captureMountedFile(
    filesDirectory: string,
    captured: CapturedMountFiles,
    mount: MountSpec,
    mountIndex: number,
    sourcePath: string,
    relativePath: string,
    redactor: ArtifactRedactor,
  ): Promise<void> {
    const target = mount.type === "file" ? mount.target : mountTargetPath(mount, relativePath)

    if (captured.files.length >= MAX_CAPTURED_MOUNT_FILES) {
      captured.skipped.push({ mountIndex, source: sourcePath, target, relativePath, reason: "max-files-exceeded" })
      return
    }

    const fileStats = await stat(sourcePath)
    if (fileStats.size > MAX_CAPTURED_MOUNT_FILE_BYTES) {
      captured.skipped.push({ mountIndex, source: sourcePath, target, relativePath, reason: "max-file-bytes-exceeded" })
      return
    }

    const artifactRelativePath = `mounts/${mountIndex}/${relativePath}`
    const artifactPath = join(filesDirectory, artifactRelativePath)
    await mkdir(dirname(artifactPath), { recursive: true })

    const buffer = await readFile(sourcePath)
    const text = buffer.toString("utf8")
    const replayable = isReplayableText(buffer, text)
    const artifactBundlePath = `files/${artifactRelativePath}`
    const artifactContents = replayable ? redactor.redact(artifactBundlePath, text) : buffer
    if (typeof artifactContents === "string") {
      await writeFile(artifactPath, artifactContents)
    } else {
      await copyFile(sourcePath, artifactPath)
    }
    const artifactBuffer = typeof artifactContents === "string" ? Buffer.from(artifactContents, "utf8") : buffer

    captured.files.push({
      mountIndex,
      source: sourcePath,
      target,
      relativePath,
      artifactPath: artifactBundlePath,
      size: artifactBuffer.byteLength,
      sha256: createHash("sha256").update(artifactBuffer).digest("hex"),
      contentType: replayable ? "text/plain; charset=utf-8" : "application/octet-stream",
      replayable,
      ...(replayable ? { replayContents: artifactContents as string } : {}),
    })
  }

  async destroy(): Promise<void> {
    const cliServer = await this.cliServerPromise
    await cliServer?.[Symbol.asyncDispose]()
    this.status = "destroyed"
    this.recordEvent("runtime.destroyed", { runtimeId: this.runtimeId })
  }

  private recordEvent(type: LifecycleEvent["type"], data?: Record<string, unknown>): LifecycleEvent {
    const event: LifecycleEvent = {
      id: id("event"),
      type,
      timestamp: now(),
      ...(data ? { data } : {}),
    }

    this.events.push(event)
    return event
  }

  private formatRuntimeLog(): string {
    return this.events.map((event) => `[${event.timestamp}] ${event.type} ${JSON.stringify(event.data ?? {})}`).join("\n") + "\n"
  }

  private formatCommandsLog(): string {
    return (
      this.commands
        .map((command) => {
          const header = `[${command.startedAt}] ${command.command} ${command.args.join(" ")}`.trim()
          const output = [command.stdout, command.stderr].filter(Boolean).join("\n")
          return `${header}\nexitCode=${command.exitCode}\n${output}`
        })
        .join("\n---\n") + "\n"
    )
  }

  private async executePlaygroundCommand(spec: ExecutionSpec): Promise<string> {
    if (spec.command === "inspect-mounted-inputs") {
      return this.inspectMountedInputs()
    }

    if (spec.command === "wordpress.run-php") {
      return this.runPhp(spec)
    }

    if (spec.command === "wordpress.wp-cli") {
      return this.runWpCli(spec)
    }

    if (spec.command === "wordpress.ability") {
      return this.runAbility(spec)
    }

    if (spec.command === "wordpress.bench") {
      return this.runBench(spec)
    }

    throw new Error(`No Playground command handler is registered for: ${spec.command}`)
  }

  private async runPhp(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const code = await this.phpCodeFromArgs(spec.args ?? [])
    const response = await server.playground.run({ code: this.bootstrapPhpCode(code, spec.args ?? []) })

    return response.text
  }

  private async runWpCli(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const command = wpCliCommandFromArgs(spec.args ?? [])
    const argv = shellArgv(command)
    if (argv[0] === "wp") {
      argv.shift()
    }

    if (argv.length === 0) {
      throw new Error("wordpress.wp-cli requires a non-empty command")
    }

    if (!server.playground.writeFile) {
      throw new Error("wordpress.wp-cli requires a Playground backend with writeFile support")
    }

    const scriptPath = `/tmp/wp-codebox-wp-cli-${this.commands.length}.php`
    await server.playground.writeFile(scriptPath, wpCliPhpScript(argv))
    const response = await server.playground.run({ scriptPath })
    if (typeof response.exitCode === "number" && response.exitCode !== 0) {
      throw new Error(response.errors || `wordpress.wp-cli failed with exit code ${response.exitCode}`)
    }

    return cleanWpCliOutput(response.text)
  }

  private async runAbility(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const name = argValue(spec.args ?? [], "name")?.trim()
    if (!name) {
      throw new Error("wordpress.ability requires name=<ability-name>")
    }

    const input = abilityInputFromArgs(spec.args ?? [])
    const response = await server.playground.run({ code: this.bootstrapAbilityPhpCode(abilityPhpCode(name, input)) })
    return response.text
  }

  private async runBench(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const pluginSlug = argValue(args, "plugin-slug")?.trim()
    if (!pluginSlug) {
      throw new Error("wordpress.bench requires plugin-slug=<slug>")
    }

    const componentId = argValue(args, "component-id")?.trim() || pluginSlug
    const iterations = positiveIntegerArg(args, "iterations", 3)
    const warmupIterations = positiveIntegerArg(args, "warmup", 1)
    const response = await server.playground.run({
      code: this.bootstrapPhpCode(benchRunCode({ componentId, pluginSlug, iterations, warmupIterations }), []),
    })

    return response.text
  }

  private bootstrapAbilityPhpCode(code: string): string {
    return `<?php
$_SERVER['REQUEST_URI'] = '/wp-json/wp-codebox/ability';
require_once '/wordpress/wp-load.php';
${this.secretEnvPhp()}
${phpBody(code)}`
  }

  private bootstrapPhpCode(code: string, args: string[]): string {
    if (argValue(args, "bootstrap") === "none") {
      return code
    }

    return `<?php
require_once '/wordpress/wp-load.php';
${this.secretEnvPhp()}
${phpBody(code)}`
  }

  private secretEnvPhp(): string {
    const entries = Object.entries(this.spec.secretEnv ?? {}).filter(([name]) => isSafeEnvName(name))
    if (entries.length === 0) {
      return ""
    }

    return `${entries
      .map(([name, value]) => `putenv(${JSON.stringify(`${name}=${value}`)});`)
      .join("\n")}\n`
  }

  private async phpCodeFromArgs(args: string[]): Promise<string> {
    const inlineCode = argValue(args, "code")
    if (inlineCode) {
      return normalizePhpCode(inlineCode)
    }

    const codeFile = argValue(args, "code-file")
    if (codeFile) {
      return normalizePhpCode(await readFile(resolve(codeFile), "utf8"))
    }

    throw new Error("wordpress.run-php requires code=<php> or code-file=<path>")
  }

  private async inspectMountedInputs(): Promise<string> {
    const server = await this.bootPlayground()
    const response = await server.playground.run({
      code: `<?php
$mounts = ${JSON.stringify(JSON.stringify(this.mounts))};
$inspected = array_map(function ($mount) {
    $target = $mount['target'];
    $entries = is_dir($target) ? array_values(array_diff(scandir($target), array('.', '..'))) : array(basename($target));
    sort($entries);

    return array(
        'target' => $target,
        'source' => $mount['source'],
        'entries' => $entries,
        'exists' => file_exists($target),
    );
}, json_decode($mounts, true));

echo json_encode(array('command' => 'inspect-mounted-inputs', 'mounts' => $inspected), JSON_PRETTY_PRINT);
`,
    })

    return response.text
  }

  private async bootPlayground(): Promise<PlaygroundCliServer> {
    if (!this.cliServerPromise) {
      this.cliServerPromise = this.startPlayground()
    }

    return this.cliServerPromise
  }

  private async startPlayground(): Promise<PlaygroundCliServer> {
    const { runCLI } = (await import("@wp-playground/cli")) as unknown as PlaygroundCliModule

    return runCLI({
      command: "server",
      port: 0,
      quiet: true,
      skipBrowser: true,
      mount: this.mounts.map((mount) => ({
        hostPath: mount.source,
        vfsPath: mount.target,
      })),
      wp: this.spec.environment.version,
      blueprint: playgroundBlueprint(this.spec.environment.blueprint, this.spec.policy),
    })
  }

  private async observeStub(spec: ObservationSpec): Promise<unknown> {
    if (spec.type === "runtime-info") {
      return this.info()
    }

    if (spec.type === "mounts") {
      return this.mounts
    }

    return { type: spec.type, path: spec.path ?? null }
  }
}

export function createPlaygroundRuntimeBackend(): RuntimeBackend {
  return new PlaygroundRuntimeBackend()
}

async function writeJsonLines(path: string, records: unknown[], redactor: ArtifactRedactor, artifactRoot: string): Promise<void> {
  await writeRedactedArtifact(redactor, path, artifactRoot, records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "")
}

async function writeRedactedArtifact(redactor: ArtifactRedactor, path: string, artifactRoot: string, contents: string): Promise<void> {
  await writeFile(path, redactor.redact(relative(artifactRoot, path), contents))
}
