import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { assertRuntimeCommandAllowed } from "@chubes4/wp-codebox-core"
import { normalizeBlueprint, playgroundBlueprint, preferredVersionsForEnvironment } from "./blueprint.js"
import { abilityInputFromArgs, abilityPhpCode, argValue, cleanWpCliOutput, isSafeEnvName, normalizePhpCode, phpBody, shellArgv, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
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

interface CapturedMountFile {
  mountIndex: number
  source: string
  target: string
  relativePath: string
  artifactPath: string
  size: number
  sha256: string
  contentType: string
  replayable: boolean
  replayContents?: string
}

interface SkippedMountFile {
  mountIndex: number
  source: string
  target: string
  relativePath: string
  reason: string
}

interface CapturedMountFiles {
  files: CapturedMountFile[]
  skipped: SkippedMountFile[]
  limits: {
    maxFiles: number
    maxFileBytes: number
    skippedDirectories: string[]
  }
}

interface MountDiff {
  mountIndex: number
  source: string
  target: string
  baselineSource: string
  artifactPath: string
  changed: boolean
}

const MAX_CAPTURED_MOUNT_FILES = 200
const MAX_CAPTURED_MOUNT_FILE_BYTES = 1024 * 1024
const SKIPPED_CAPTURE_DIRECTORIES = new Set([".git", "node_modules"])

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

    const bundleId = id("artifact-bundle")
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

    this.recordEvent("runtime.artifacts.collected", {
      id: bundleId,
      directory: this.artifactRoot,
      createdAt,
      spec,
    })

    const runtime = await this.info()
    const metadata = {
      id: bundleId,
      createdAt,
      runtime,
      mounts: this.mounts,
      policy: this.spec.policy,
      context: this.spec.metadata ?? {},
      spec,
    }
    const capturedMounts = await this.captureMountedFiles(filesDirectory)
    const mountDiffs = await this.captureMountDiffs(filesDirectory)
    const blueprintAfter = this.buildBlueprintAfter(capturedMounts)
    const blueprintAfterNotes = this.buildBlueprintAfterNotes(createdAt, capturedMounts)

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
      ...mountDiffs.map((diff) => fileEntry(join(this.artifactRoot, diff.artifactPath), "diff", "text/x-diff")),
      ...capturedMounts.files.map((file) =>
        fileEntry(join(this.artifactRoot, file.artifactPath), "file", file.contentType),
      ),
    ]

    const manifest: ArtifactManifest = {
      id: bundleId,
      createdAt,
      runtime,
      files: manifestFiles.map((file) => ({
        ...file,
        path: relative(this.artifactRoot, file.path),
      })),
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
    )
    await writeFile(blueprintAfterPath, `${JSON.stringify(blueprintAfter, null, 2)}\n`)
    await writeFile(blueprintAfterNotesPath, `${JSON.stringify(blueprintAfterNotes, null, 2)}\n`)
    await writeJsonLines(eventsPath, this.events)
    await writeJsonLines(commandsPath, this.commands)
    await writeJsonLines(observationsPath, this.observations)
    await writeFile(runtimeLogPath, this.formatRuntimeLog())
    await writeFile(commandsLogPath, this.formatCommandsLog())
    await writeFile(mountsPath, `${JSON.stringify(this.mounts, null, 2)}\n`)
    await writeFile(capturedMountsPath, `${JSON.stringify(serializeCapturedMountFiles(capturedMounts), null, 2)}\n`)
    await writeFile(diffsPath, `${JSON.stringify(mountDiffs, null, 2)}\n`)

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
      createdAt,
    }
  }

  private buildBlueprintAfter(capturedMounts: CapturedMountFiles): Record<string, unknown> {
    const baseBlueprint = normalizeBlueprint(this.spec.environment.blueprint)
    const preferredVersions = preferredVersionsForEnvironment(this.spec.environment.version, baseBlueprint)
    const replaySteps = capturedMounts.files
      .filter((file) => file.replayable && typeof file.replayContents === "string")
      .map((file) => ({
        step: "writeFile",
        path: file.target,
        data: {
          resource: "literal",
          name: basename(file.target),
          contents: file.replayContents,
        },
      }))

    return {
      $schema: "https://playground.wordpress.net/blueprint-schema.json",
      ...(baseBlueprint.extraLibraries ? { extraLibraries: baseBlueprint.extraLibraries } : {}),
      ...(preferredVersions ? { preferredVersions } : {}),
      landingPage: baseBlueprint.landingPage ?? "/",
      steps: [...baseBlueprint.steps, ...replaySteps],
    }
  }

  private buildBlueprintAfterNotes(createdAt: string, capturedMounts: CapturedMountFiles): Record<string, unknown> {
    const replayableFileCount = capturedMounts.files.filter((file) => file.replayable).length

    return {
      createdAt,
      runtime: {
        id: this.runtimeId,
        backend: "wordpress-playground",
        environment: this.spec.environment,
      },
      replayStatus: "partial",
      blueprintPath: "blueprint.after.json",
      mounts: this.mounts,
      capturedFilesPath: "files/mounted-files.json",
      capturedFileCount: capturedMounts.files.length,
      replayableFileCount,
      skippedFileCount: capturedMounts.skipped.length,
      limitations: [
        "Text files from readwrite mounts are embedded in blueprint.after.json as writeFile steps; binary files are copied into artifacts but not replayed yet.",
        "Database exports, option diffs, uploaded media, active theme/plugin state, and screenshots are not captured yet.",
      ],
      nextCaptureTargets: ["database-export", "active-theme", "active-plugins", "uploads", "binary-file-replay"],
    }
  }

  private async captureMountedFiles(filesDirectory: string): Promise<CapturedMountFiles> {
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
        await this.captureMountedDirectory(filesDirectory, captured, mount, mountIndex, mount.source, "")
        continue
      }

      if (mountStats.isFile()) {
        await this.captureMountedFile(filesDirectory, captured, mount, mountIndex, mount.source, basename(mount.source))
      }
    }

    return captured
  }

  private async captureMountDiffs(filesDirectory: string): Promise<MountDiff[]> {
    const diffsDirectory = join(filesDirectory, "diffs")
    await mkdir(diffsDirectory, { recursive: true })
    const diffs: MountDiff[] = []

    for (const [mountIndex, mount] of this.mounts.entries()) {
      const baselineSource = typeof mount.metadata?.baselineSource === "string" ? mount.metadata.baselineSource : ""
      if (mount.mode !== "readwrite" || !baselineSource) {
        continue
      }

      const patch = await directoryDiff(baselineSource, mount.source, mount.target)
      const artifactPath = `files/diffs/mount-${mountIndex}.patch`
      await writeFile(join(this.artifactRoot, artifactPath), patch)
      diffs.push({
        mountIndex,
        source: mount.source,
        target: mount.target,
        baselineSource,
        artifactPath,
        changed: patch.trim().length > 0,
      })
    }

    return diffs
  }

  private async captureMountedDirectory(
    filesDirectory: string,
    captured: CapturedMountFiles,
    mount: MountSpec,
    mountIndex: number,
    directory: string,
    relativeDirectory: string,
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

        await this.captureMountedDirectory(filesDirectory, captured, mount, mountIndex, sourcePath, relativePath)
        continue
      }

      if (entry.isFile()) {
        await this.captureMountedFile(filesDirectory, captured, mount, mountIndex, sourcePath, relativePath)
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
    await copyFile(sourcePath, artifactPath)

    const buffer = await readFile(sourcePath)
    const text = buffer.toString("utf8")
    const replayable = isReplayableText(buffer, text)

    captured.files.push({
      mountIndex,
      source: sourcePath,
      target,
      relativePath,
      artifactPath: `files/${artifactRelativePath}`,
      size: fileStats.size,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      contentType: replayable ? "text/plain; charset=utf-8" : "application/octet-stream",
      replayable,
      ...(replayable ? { replayContents: text } : {}),
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

function fileEntry(path: string, kind: ArtifactManifestFile["kind"], contentType: string): ArtifactManifestFile {
  return { path, kind, contentType }
}

function mountTargetPath(mount: MountSpec, relativePath: string): string {
  return `${mount.target.replace(/\/+$/, "")}/${relativePath}`
}

function isReplayableText(buffer: Buffer, text: string): boolean {
  if (buffer.includes(0)) {
    return false
  }

  return !text.includes("\uFFFD")
}

function serializeCapturedMountFiles(captured: CapturedMountFiles): CapturedMountFiles {
  return {
    ...captured,
    files: captured.files.map(({ replayContents, ...file }) => file),
  }
}

async function writeJsonLines(path: string, records: unknown[]): Promise<void> {
  await writeFile(path, records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "")
}

async function directoryDiff(baselineDirectory: string, currentDirectory: string, targetPrefix: string): Promise<string> {
  const [baselineFiles, currentFiles] = await Promise.all([
    listTextFiles(baselineDirectory),
    listTextFiles(currentDirectory),
  ])
  const paths = [...new Set([...baselineFiles.keys(), ...currentFiles.keys()])].sort()
  const patches: string[] = []

  for (const relativePath of paths) {
    const before = baselineFiles.get(relativePath)
    const after = currentFiles.get(relativePath)
    if (before === after) {
      continue
    }

    patches.push(fileDiff(`${targetPrefix}/${relativePath}`, before ?? "", after ?? "", before === undefined, after === undefined))
  }

  return patches.join("\n")
}

async function listTextFiles(directory: string, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_CAPTURE_DIRECTORIES.has(entry.name)) {
      continue
    }

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const [path, contents] of await listTextFiles(fullPath, relativePath)) {
        files.set(path, contents)
      }
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const buffer = await readFile(fullPath)
    const text = buffer.toString("utf8")
    if (isReplayableText(buffer, text)) {
      files.set(relativePath, text)
    }
  }

  return files
}

function fileDiff(path: string, before: string, after: string, isAdded: boolean, isDeleted: boolean): string {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const oldPath = isAdded ? "/dev/null" : `a${path}`
  const newPath = isDeleted ? "/dev/null" : `b${path}`
  const lines = [
    `diff --git ${oldPath} ${newPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ]

  return `${lines.join("\n")}\n`
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return []
  }

  return text.replace(/\n$/, "").split("\n")
}
