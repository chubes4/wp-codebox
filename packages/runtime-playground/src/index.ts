import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { RUNTIME_EPISODE_OBSERVATION_SCHEMA, RUNTIME_EPISODE_SNAPSHOT_SCHEMA, assertRuntimeCommandAllowed, runtimeEpisodeDigest } from "@chubes4/wp-codebox-core"
import {
  ArtifactRedactor,
  fileEntry,
} from "./artifacts.js"
import { ArtifactBundleBuilder } from "./artifact-bundle-builder.js"
import { browserManifestFiles as browserArtifactManifestFiles, browserRedactionPaths, browserReviewSummary as browserArtifactReviewSummary, type BrowserProbeArtifact } from "./browser-artifacts.js"
import { runBrowserActionsCommand, runBrowserProbeCommand } from "./browser-command-runners.js"
import { pluginCheckManifestFiles, redactPluginCheckArtifacts, redactThemeCheckArtifacts, themeCheckManifestFiles, type PluginCheckArtifact, type ThemeCheckArtifact } from "./check-artifacts.js"
import { executePlaygroundCommand, playgroundRuntimeCommandIds } from "./command-router.js"
export { playgroundRuntimeCommandIds } from "./command-router.js"
import { cleanWpCliOutput, shellArgv, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { captureMountedFiles, captureMountDiffs } from "./mounted-artifact-capture.js"
import { observeHttpResponse as observeHttpResponseArtifact, observeWordPressState as observeWordPressStateArtifact } from "./observation-artifacts.js"
import { PlaygroundCommandCrashError, assertPlaygroundResponseOk, errorMessage, type PlaygroundRunResponse } from "./playground-command-errors.js"
import { startPlaygroundCliServer } from "./playground-cli-runner.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { runAbilityCommand, runBenchCommand, runCorePhpunitCommand, runPhpCommand, runPhpunitCommand, runPluginCheckCommand, runThemeCheckCommand } from "./wordpress-command-runners.js"
import { PlaygroundSnapshotRestoreError, contentDigest, mountsFromSnapshot, runtimeSnapshotExportPhp, runtimeSnapshotPayload, runtimeSnapshotRestorePhp, runtimeSpecFromSnapshot, snapshotDigest, type RuntimeSnapshotArtifact } from "./runtime-snapshot.js"
import { createRuntimeWpCliBridge, type RuntimeWpCliBridge } from "./runtime-wp-cli-bridge.js"
import type {
  ArtifactBundle,
  ArtifactManifestFile,
  ArtifactPreview,
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
  RuntimeRestoreSpec,
  RuntimeEpisodeTraceRef,
  RuntimeInfo,
  Snapshot,
} from "@chubes4/wp-codebox-core"
function now(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class PlaygroundRuntimeBackend implements RuntimeBackend {
  readonly kind = "wordpress-playground" as const

  async create(spec: RuntimeCreateSpec): Promise<Runtime> {
    return PlaygroundRuntime.create(spec)
  }

  async restore(snapshot: Snapshot, spec: RuntimeRestoreSpec = {}): Promise<Runtime> {
    return PlaygroundRuntime.restore(snapshot, spec)
  }
}

class PlaygroundRuntime implements Runtime {
  private status: RuntimeInfo["status"] = "created"
  private readonly runtimeId = id("runtime")
  private readonly createdAt = now()
  private readonly mounts: MountSpec[] = []
  private readonly commands: ExecutionResult[] = []
  private readonly observations: ObservationResult[] = []
  private readonly snapshots: Snapshot[] = []
  private readonly events: LifecycleEvent[] = []
  private readonly browserProbes: BrowserProbeArtifact[] = []
  private readonly pluginChecks: PluginCheckArtifact[] = []
  private readonly themeChecks: ThemeCheckArtifact[] = []
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

  static async restore(snapshot: Snapshot, spec: RuntimeRestoreSpec = {}): Promise<PlaygroundRuntime> {
    const payload = await runtimeSnapshotPayload(snapshot)
    if (payload.compatibility.backend !== "wordpress-playground") {
      throw new PlaygroundSnapshotRestoreError(`Snapshot backend is not compatible with WordPress Playground: ${payload.compatibility.backend}`)
    }

    const runtimeSpec = spec.runtime ?? runtimeSpecFromSnapshot(snapshot)
    const runtime = await PlaygroundRuntime.create(runtimeSpec)
    for (const mount of spec.mounts ?? mountsFromSnapshot(snapshot)) {
      await runtime.mount(mount)
    }

    await runtime.restoreSnapshotPayload(payload)
    runtime.recordEvent("runtime.snapshot.restored", {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      snapshotSchema: snapshot.schema ?? null,
    })
    return runtime
  }

  async info(): Promise<RuntimeInfo> {
    const previewUrl = await this.currentPreviewUrl()
    return {
      id: this.runtimeId,
      backend: "wordpress-playground",
      environment: this.spec.environment,
      createdAt: this.createdAt,
      status: this.status,
      ...(previewUrl ? { previewUrl } : {}),
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
    try {
      const result: ExecutionResult = {
        id: commandId,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: 0,
        stdout: await executePlaygroundCommand(this, spec),
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
    } catch (error) {
      const result: ExecutionResult = {
        id: commandId,
        command: spec.command,
        args: spec.args ?? [],
        exitCode: 1,
        stdout: "",
        stderr: errorMessage(error),
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
      throw error
    }
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    const observationId = id("observation")
    const observedAt = now()
    const observed = await this.observeData(spec, observationId)
    const observation: ObservationResult = {
      schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
      id: observationId,
      type: spec.type,
      data: observed.data,
      observedAt,
      ...(observed.artifactRefs.length > 0 ? { artifactRefs: observed.artifactRefs } : {}),
    }
    observation.digest = runtimeEpisodeDigest({
      schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
      type: observation.type,
      data: observation.data,
      observedAt: observation.observedAt,
      artifactRefs: observation.artifactRefs ?? [],
    })

    this.observations.push(observation)
    this.recordEvent("runtime.observed", {
      type: observation.type,
      observedAt: observation.observedAt,
    })
    return observation
  }

  async snapshot(): Promise<Snapshot> {
    const snapshotId = id("snapshot")
    const createdAt = now()
    const payload = await this.captureRuntimeSnapshotArtifact(snapshotId, createdAt)
    const artifactPath = `files/runtime-snapshots/${snapshotId}.json`
    const absoluteArtifactPath = join(this.artifactRoot, artifactPath)
    const artifactJson = `${JSON.stringify(payload, null, 2)}\n`
    await mkdir(dirname(absoluteArtifactPath), { recursive: true })
    await writeFile(absoluteArtifactPath, artifactJson)
    const artifactDigest = { algorithm: "sha256" as const, value: sha256(Buffer.from(artifactJson, "utf8")) }
    const snapshot: Snapshot = {
      schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
      id: snapshotId,
      createdAt,
      semantics: "runtime-state-artifact",
      metadata: {
        runtime: await this.info(),
        mounts: this.mounts,
        compatibility: payload.compatibility,
        artifact: {
          schema: payload.schema,
          path: artifactPath,
          absolutePath: absoluteArtifactPath,
          digest: artifactDigest,
        },
        hashes: payload.hashes,
        summary: {
          databaseTables: payload.database.tables.length,
          wpContentFiles: payload.files.length,
        },
        payload,
      },
      artifactRefs: [
        {
          kind: "runtime-snapshot-artifact",
          id: snapshotId,
          path: artifactPath,
          digest: artifactDigest,
        },
      ],
    }
    snapshot.digest = snapshotDigest(snapshot)

    this.recordEvent("runtime.snapshot.created", {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      artifactPath,
    })

    this.snapshots.push(snapshot)

    return snapshot
  }

  private async captureRuntimeSnapshotArtifact(snapshotId: string, createdAt: string): Promise<RuntimeSnapshotArtifact> {
    const response = await this.runPlaygroundCommand("runtime.snapshot", await this.bootPlayground(), {
      code: bootstrapPhpCode(this.spec, runtimeSnapshotExportPhp(), []),
    })
    assertPlaygroundResponseOk("runtime.snapshot", response)
    const captured = JSON.parse(response.text || "{}") as Omit<RuntimeSnapshotArtifact, "schema" | "version" | "id" | "createdAt" | "hashes">
    const databaseDigest = contentDigest(captured.database)
    const filesDigest = contentDigest(captured.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })))

    return {
      schema: "wp-codebox/wordpress-runtime-snapshot/v1",
      version: 1,
      id: snapshotId,
      createdAt,
      ...captured,
      metadata: {
        ...captured.metadata,
        runtime: await this.info(),
        mounts: this.mounts,
        mountedInputs: this.mounts.map((mount) => ({ source: mount.source, target: mount.target, mode: mount.mode, type: mount.type })),
      },
      hashes: {
        database: databaseDigest,
        files: filesDigest,
      },
    }
  }

  private async restoreSnapshotPayload(payload: RuntimeSnapshotArtifact): Promise<void> {
    const runtime = await this.info()
    if (runtime.backend !== payload.compatibility.backend) {
      throw new PlaygroundSnapshotRestoreError(`Snapshot backend ${payload.compatibility.backend} cannot be restored into ${runtime.backend}.`)
    }

    const response = await this.runPlaygroundCommand("runtime.snapshot.restore", await this.bootPlayground(), {
      code: bootstrapPhpCode(this.spec, runtimeSnapshotRestorePhp(payload), []),
    })
    assertPlaygroundResponseOk("runtime.snapshot.restore", response)
  }

  async collectArtifacts(spec: ArtifactSpec = {}): Promise<ArtifactBundle> {
    return new ArtifactBundleBuilder({
      artifactRoot: this.artifactRoot,
      runtimeId: this.runtimeId,
      runtimeCreatedAt: this.createdAt,
      spec: this.spec,
      mounts: this.mounts,
      commands: this.commands,
      observations: this.observations,
      snapshots: this.snapshots,
      events: this.events,
      info: () => this.info(),
      previewInfo: (createdAt, previewHoldSeconds) => this.previewInfo(createdAt, previewHoldSeconds),
      browserReviewSummary: () => this.browserReviewSummary(),
      captureMountedFiles: (filesDirectory, redactor) => captureMountedFiles(filesDirectory, this.mounts, redactor),
      captureMountDiffs: (filesDirectory, redactor) => captureMountDiffs(this.artifactRoot, filesDirectory, this.mounts, redactor),
      redactBrowserArtifacts: (redactor) => this.redactBrowserArtifacts(redactor),
      redactPluginCheckArtifacts: (redactor) => redactPluginCheckArtifacts(this.artifactRoot, this.pluginChecks, redactor),
      redactThemeCheckArtifacts: (redactor) => redactThemeCheckArtifacts(this.artifactRoot, this.themeChecks, redactor),
      browserManifestFiles: () => this.browserManifestFiles(),
      pluginCheckArtifactPaths: () => this.pluginChecks.map((check) => check.files.normalized),
      themeCheckArtifactPaths: () => this.themeChecks.map((check) => check.files.normalized),
      observationManifestFiles: () => this.observationManifestFiles(),
      pluginCheckManifestFiles: () => pluginCheckManifestFiles(this.artifactRoot, this.pluginChecks),
      themeCheckManifestFiles: () => themeCheckManifestFiles(this.artifactRoot, this.themeChecks),
      formatRuntimeLog: () => this.formatRuntimeLog(),
      formatCommandsLog: () => this.formatCommandsLog(),
      recordArtifactsCollected: (bundleId, createdAt, artifactSpec) => this.recordEvent("runtime.artifacts.collected", {
        id: bundleId,
        directory: this.artifactRoot,
        createdAt,
        spec: artifactSpec,
      }),
    }).build(spec)
  }

  async destroy(): Promise<void> {
    const cliServer = await this.cliServerPromise
    await cliServer?.[Symbol.asyncDispose]()
    this.status = "destroyed"
    this.recordEvent("runtime.destroyed", { runtimeId: this.runtimeId })
  }

  private async currentPreviewUrl(): Promise<string | undefined> {
    if (this.status === "destroyed") {
      return undefined
    }

    if (!this.cliServerPromise) {
      return undefined
    }

    const server = await this.cliServerPromise
    return this.spec.preview?.publicUrl ?? server.serverUrl
  }

  private async previewInfo(createdAt: string, holdSeconds = 0): Promise<ArtifactPreview> {
    const server = await this.bootPlayground()
    const normalizedHoldSeconds = Math.max(0, Math.floor(holdSeconds))
    const expiresAt = normalizedHoldSeconds > 0 ? new Date(Date.now() + normalizedHoldSeconds * 1000).toISOString() : undefined
    const publicUrl = this.spec.preview?.publicUrl
    const siteUrl = this.spec.preview?.siteUrl

    return {
      url: publicUrl ?? server.serverUrl,
      ...(publicUrl ? { publicUrl, localUrl: server.serverUrl } : {}),
      ...(siteUrl ? { siteUrl } : {}),
      status: normalizedHoldSeconds > 0 ? "available" : "expired-on-completion",
      lifecycle: normalizedHoldSeconds > 0 ? "held-after-run" : "destroyed-on-completion",
      source: publicUrl ? "public-url-override" : "live-playground",
      createdAt,
      ...(expiresAt ? { expiresAt, holdSeconds: normalizedHoldSeconds } : {}),
    }
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

  async runBrowserProbe(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const result = await runBrowserProbeCommand({ artifactRoot: this.artifactRoot, server, spec })
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runBrowserActions(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const result = await runBrowserActionsCommand({ artifactRoot: this.artifactRoot, runtimeSpec: this.spec, server, spec })
    this.browserProbes.push(result.artifact)
    return result.output
  }

  async runPhp(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runPhpCommand({
      createRuntimeWpCliBridge: (targetServer) => this.createRuntimeWpCliBridge(targetServer),
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runWpCli(spec: ExecutionSpec): Promise<string> {
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
    const response = await this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
    assertPlaygroundResponseOk("wordpress.wp-cli", response)

    return cleanWpCliOutput(response.text)
  }

  async runPluginCheck(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const result = await runPluginCheckCommand({
      artifactRoot: this.artifactRoot,
      runWpCliCommand: (targetServer, argv) => this.runWpCliCommand(targetServer, argv),
      server,
      spec,
    })
    this.pluginChecks.push(result.artifact)
    return result.output
  }

  async runThemeCheck(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const result = await runThemeCheckCommand({
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runWpCliArgv: (targetServer, argv) => this.runWpCliArgv(targetServer, argv),
      runtimeSpec: this.spec,
      server,
      spec,
    })
    this.themeChecks.push(result.artifact)
    return result.output
  }

  private async runWpCliCommand(server: PlaygroundCliServer, argv: string[]): Promise<PlaygroundRunResponse> {
    if (!server.playground.writeFile) {
      throw new Error("WP-CLI commands require a Playground backend with writeFile support")
    }

    const scriptPath = `/tmp/wp-codebox-wp-cli-${this.commands.length}-${Date.now().toString(36)}.php`
    await server.playground.writeFile(scriptPath, wpCliPhpScript(argv))
    return this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
  }

  private async createRuntimeWpCliBridge(server: PlaygroundCliServer): Promise<RuntimeWpCliBridge> {
    return createRuntimeWpCliBridge((argv) => this.runWpCliCommand(server, argv))
  }

  async runAbility(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runAbilityCommand({
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runBench(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runBenchCommand({
      browserProbes: this.browserProbes,
      createRuntimeWpCliBridge: (targetServer) => this.createRuntimeWpCliBridge(targetServer),
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      runtimeSpec: this.spec,
      server,
      spec,
    })
  }

  async runPhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runPhpunitCommand({
      mounts: this.mounts,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      server,
      spec,
    })
  }

  async runCorePhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    return runCorePhpunitCommand({
      artifactRoot: this.artifactRoot,
      runPlaygroundCommand: (command, targetServer, options) => this.runPlaygroundCommand(command, targetServer, options),
      server,
      spec,
    })
  }

  private async runWpCliArgv(server: PlaygroundCliServer, argv: string[]): Promise<PlaygroundRunResponse> {
    if (!server.playground.writeFile) {
      throw new Error("WP-CLI commands require a Playground backend with writeFile support")
    }

    const scriptPath = `/tmp/wp-codebox-wp-cli-${this.commands.length}-${Date.now().toString(36)}.php`
    await server.playground.writeFile(scriptPath, wpCliPhpScript(argv))
    return this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
  }

  private async runPlaygroundCommand(command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }): Promise<PlaygroundRunResponse> {
    try {
      return await server.playground.run(options)
    } catch (error) {
      throw new PlaygroundCommandCrashError(command, error)
    }
  }

  async inspectMountedInputs(): Promise<string> {
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
    return startPlaygroundCliServer(this.spec, this.mounts)
  }

  private async observeData(spec: ObservationSpec, observationId: string): Promise<{ data: unknown; artifactRefs: RuntimeEpisodeTraceRef[] }> {
    const artifactRefs: RuntimeEpisodeTraceRef[] = []

    if (spec.type === "command-result") {
      const command = spec.commandId ? this.commands.find((candidate) => candidate.id === spec.commandId) : this.commands.at(-1)
      return {
        data: command
          ? {
              id: command.id,
              command: command.command,
              args: command.args,
              exitCode: command.exitCode,
              stdout: command.stdout,
              stderr: command.stderr,
              startedAt: command.startedAt,
              finishedAt: command.finishedAt,
            }
          : { commandId: spec.commandId ?? null, found: false },
        artifactRefs,
      }
    }

    if (spec.type === "wordpress-state") {
      return observeWordPressStateArtifact({ artifactRoot: this.artifactRoot, observationId, server: await this.bootPlayground(), spec, runtimeSpec: this.spec })
    }

    if (spec.type === "http-response") {
      return observeHttpResponseArtifact({ artifactRoot: this.artifactRoot, observationId, spec, url: await this.resolveObservationUrl(spec.url ?? spec.path ?? "/") })
    }

    if (spec.type === "browser-result") {
      return { data: this.browserReviewSummary() ?? { probes: [] }, artifactRefs }
    }

    if (spec.type === "runtime-events" || spec.type === "runtime-logs") {
      return { data: this.events, artifactRefs }
    }

    return { data: await this.observeStub(spec), artifactRefs }
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

  private async resolveObservationUrl(url: string): Promise<string> {
    if (/^https?:\/\//.test(url)) {
      return url
    }

    const previewUrl = await this.currentPreviewUrl()
    const baseUrl = previewUrl ?? (await this.bootPlayground()).serverUrl
    return new URL(url, baseUrl).toString()
  }

  private browserReviewSummary() {
    return browserArtifactReviewSummary(this.browserProbes)
  }

  private browserManifestFiles(): ArtifactManifestFile[] {
    return browserArtifactManifestFiles(this.artifactRoot, this.browserProbes)
  }

  private observationManifestFiles(): ArtifactManifestFile[] {
    return this.observations.flatMap((observation) =>
      (observation.artifactRefs ?? [])
        .filter((ref): ref is RuntimeEpisodeTraceRef & { path: string } => typeof ref.path === "string" && ref.path.length > 0)
        .map((ref) => fileEntry(join(this.artifactRoot, ref.path), ref.kind, ref.path.endsWith(".json") ? "application/json" : "text/plain")),
    )
  }

  private async redactBrowserArtifacts(redactor: ArtifactRedactor): Promise<void> {
    for (const probe of this.browserProbes) {
      for (const path of browserRedactionPaths(probe)) {
        const absolutePath = join(this.artifactRoot, path)
        try {
          await writeFile(absolutePath, redactor.redact(path, await readFile(absolutePath, "utf8")))
        } catch {
          // Browser capture is best-effort; preserve artifact collection if a file vanished.
        }
      }
    }
  }

}

export function createPlaygroundRuntimeBackend(): RuntimeBackend {
  return new PlaygroundRuntimeBackend()
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}
