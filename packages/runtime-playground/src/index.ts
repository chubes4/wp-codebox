import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { RUNTIME_EPISODE_OBSERVATION_SCHEMA, RUNTIME_EPISODE_SNAPSHOT_SCHEMA, assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, runtimeEpisodeDigest, type BrowserInteractionStep } from "@chubes4/wp-codebox-core"
import {
  MAX_CAPTURED_MOUNT_FILE_BYTES,
  MAX_CAPTURED_MOUNT_FILES,
  SKIPPED_CAPTURE_DIRECTORIES,
  ArtifactRedactor,
  directoryDiff,
  fileEntry,
  isReplayableText,
  mountTargetPath,
  type CapturedMountFiles,
  type ChangedFile,
  type MountDiff,
  type MountDiffsResult,
} from "./artifacts.js"
import { ArtifactBundleBuilder } from "./artifact-bundle-builder.js"
import { browserInteractionStepsFromArgs } from "./browser-actions.js"
import { browserManifestFiles as browserArtifactManifestFiles, browserRedactionPaths, browserReviewSummary as browserArtifactReviewSummary, type BrowserProbeArtifact, type BrowserProbeCheckpointRecord, type BrowserProbeErrorRecord, type BrowserProbeMemoryArtifact, type BrowserProbeNetworkRecord, type BrowserProbePerformanceArtifact, type BrowserProbeViewport, type BrowserStepRecord } from "./browser-artifacts.js"
import { browserAssertionsSummary, browserStepRecord, executeBrowserInteractionStep } from "./browser-interactions.js"
import { BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeReplayability, browserProbeViewport, navigateBrowserProbe } from "./browser-probe.js"
import { browserProbeBenchMetrics, jsonLines, promoteBrowserMetricsToBenchResults, serializeBrowserConsoleMessage, serializeBrowserError, serializeBrowserFinishedRequest, serializeBrowserRequestFailure } from "./browser-metrics.js"
import { executePlaygroundCommand, playgroundRuntimeCommandIds } from "./command-router.js"
export { playgroundRuntimeCommandIds } from "./command-router.js"
import { abilityInputFromArgs, abilityPhpCode, argValue, benchRunCode, booleanArg, cleanWpCliOutput, commaListArg, CORE_PHPUNIT_RESULT_FILE, corePhpunitRunCode, jsonArrayArg, jsonObjectArg, nonNegativeIntegerArg, normalizePhpCode, normalizePluginCheckOutput, normalizeThemeCheckOutput, phpunitRunCode, positiveIntegerArg, shellArgv, themeCheckRunCode, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
import { bootstrapAbilityPhpCode, bootstrapPhpCode, phpCodeFromArgs } from "./php-bootstrap.js"
import { PlaygroundCommandCrashError, assertPlaygroundResponseOk, errorMessage, type PlaygroundRunResponse } from "./playground-command-errors.js"
import { startPlaygroundCliServer } from "./playground-cli-runner.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { persistCorePhpunitResult, persistVfsDiagnosticFile, readCorePhpunitDiagnostic } from "./runtime-diagnostics.js"
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
import type { Page } from "playwright"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000

function now(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function benchWorkloadsUseWpCli(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(benchWorkloadsUseWpCli)
  }
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as { type?: unknown; run?: unknown }
  return record.type === "wp-cli" || benchWorkloadsUseWpCli(record.run)
}

interface PluginCheckArtifact {
  targetPlugin: string
  files: {
    raw: string
    normalized: string
  }
  summary: {
    total: number
    errors: number
    warnings: number
    notices: number
    info: number
    unknown: number
  }
}

interface ThemeCheckArtifact {
  theme: string
  files: {
    raw: string
    normalized: string
  }
  summary: ReturnType<typeof normalizeThemeCheckOutput>["summary"]
  status: ReturnType<typeof normalizeThemeCheckOutput>["status"]
  exitCode: number
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
      captureMountedFiles: (filesDirectory, redactor) => this.captureMountedFiles(filesDirectory, redactor),
      captureMountDiffs: (filesDirectory, redactor) => this.captureMountDiffs(filesDirectory, redactor),
      redactBrowserArtifacts: (redactor) => this.redactBrowserArtifacts(redactor),
      redactPluginCheckArtifacts: (redactor) => this.redactPluginCheckArtifacts(redactor),
      redactThemeCheckArtifacts: (redactor) => this.redactThemeCheckArtifacts(redactor),
      browserManifestFiles: () => this.browserManifestFiles(),
      pluginCheckArtifactPaths: () => this.pluginChecks.map((check) => check.files.normalized),
      themeCheckArtifactPaths: () => this.themeChecks.map((check) => check.files.normalized),
      observationManifestFiles: () => this.observationManifestFiles(),
      pluginCheckManifestFiles: () => this.pluginCheckManifestFiles(),
      themeCheckManifestFiles: () => this.themeCheckManifestFiles(),
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
    const args = spec.args ?? []
    const urlArg = argValue(args, "url")?.trim()
    if (!urlArg) {
      throw new Error("wordpress.browser-probe requires url=<path-or-url>")
    }

    const capture = new Set(commaListArg(args, "capture"))
    if (capture.size === 0) {
      capture.add("console")
      capture.add("errors")
      capture.add("html")
      capture.add("network")
      capture.add("screenshot")
    }

    for (const item of capture) {
      if (!(BROWSER_PROBE_CAPTURE_VALUES as readonly string[]).includes(item)) {
        throw new Error(`wordpress.browser-probe capture supports ${BROWSER_PROBE_CAPTURE_VALUES.join(", ")}: ${item}`)
      }
    }

    const waitFor = argValue(args, "wait-for")?.trim() || "domcontentloaded"
    const durationMs = durationArg(args, "duration", 0)
    const script = argValue(args, "script")
    const capturesBrowserMetrics = capture.has("performance") || capture.has("memory")
    const targetUrl = resolveBrowserProbeUrl(urlArg, server.serverUrl)
    const browserDirectory = join(this.artifactRoot, "files", "browser")
    await mkdir(browserDirectory, { recursive: true })

    const consoleMessages: Record<string, unknown>[] = []
    const errors: BrowserProbeErrorRecord[] = []
    const network: BrowserProbeNetworkRecord[] = []
    const networkTasks: Array<Promise<void>> = []
    const checkpoints: BrowserProbeCheckpointRecord[] = []
    const consolePath = join(browserDirectory, "console.jsonl")
    const checkpointsPath = join(browserDirectory, "checkpoints.jsonl")
    const errorsPath = join(browserDirectory, "errors.jsonl")
    const htmlPath = join(browserDirectory, "snapshot.html")
    const memoryPath = join(browserDirectory, "memory.json")
    const networkPath = join(browserDirectory, "network.jsonl")
    const performancePath = join(browserDirectory, "performance.json")
    const screenshotPath = join(browserDirectory, "screenshot.png")
    const summaryPath = join(browserDirectory, "summary.json")
    const startedAt = now()
    const { chromium } = await import("playwright")
    const browser = await chromium.launch()
    let finalUrl = targetUrl
    let htmlSha256: string | undefined
    let screenshotSha256: string | undefined
    let viewport: BrowserProbeViewport | null = null
    let scriptResult: unknown
    let memoryArtifact: BrowserProbeMemoryArtifact | undefined
    let performanceArtifact: BrowserProbePerformanceArtifact | undefined
    let page: Page | null = null

    try {
      page = await browser.newPage()
      if (capturesBrowserMetrics) {
        await page.addInitScript(BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT)
      }
      viewport = await browserProbeViewport(page)
      if (capture.has("console")) {
        page.on("console", (message) => consoleMessages.push(serializeBrowserConsoleMessage(message)))
      }
      if (capture.has("errors")) {
        page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
      }
      if (capture.has("network")) {
        page.on("requestfinished", (request) => {
          const task = serializeBrowserFinishedRequest(request).then((record) => {
            network.push(record)
          }).catch(() => undefined)
          networkTasks.push(task)
        })
        page.on("requestfailed", (request) => network.push(serializeBrowserRequestFailure(request)))
      }

      await navigateBrowserProbe(page, targetUrl, waitFor, durationMs)
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "after-navigation"))
      }
      if (script) {
        scriptResult = await page.evaluate(async (source) => {
          const run = new Function(`return (async () => {\n${source}\n})()`)
          return run()
        }, script)
        if (capturesBrowserMetrics) {
          checkpoints.push(...await browserProbePendingCheckpoints(page))
          checkpoints.push(await browserProbeCheckpoint(page, "after-script"))
        }
      }
      if (durationMs > 0 && waitFor !== "duration") {
        await page.waitForTimeout(durationMs)
        if (capturesBrowserMetrics) {
          checkpoints.push(await browserProbeCheckpoint(page, "after-duration"))
        }
      }
      finalUrl = page.url()
    } catch (error) {
      errors.push(serializeBrowserError("probe-error", error))
      throw error
    } finally {
      if (page) {
        finalUrl = page.url()
        if (capturesBrowserMetrics) {
          checkpoints.push(await browserProbeCheckpoint(page, "final"))
          if (capture.has("memory")) {
            memoryArtifact = browserProbeMemoryArtifact(checkpoints)
          }
          if (capture.has("performance")) {
            performanceArtifact = browserProbePerformanceArtifact(checkpoints)
          }
        }

        if (capture.has("html")) {
          const html = await page.content()
          await writeFile(htmlPath, html)
          htmlSha256 = sha256(Buffer.from(html, "utf8"))
        }

        if (capture.has("screenshot")) {
          await page.screenshot({ path: screenshotPath, fullPage: true })
          screenshotSha256 = await fileSha256(screenshotPath)
        }
      }
      if (networkTasks.length > 0) {
        await Promise.all(networkTasks)
      }
      await browser.close()
      if (capture.has("console")) {
        await writeFile(consolePath, jsonLines(consoleMessages))
      }
      if (capture.has("errors")) {
        await writeFile(errorsPath, jsonLines(errors))
      }
      if (capture.has("network")) {
        await writeFile(networkPath, jsonLines(network))
      }
      if (checkpoints.length > 0) {
        await writeFile(checkpointsPath, jsonLines(checkpoints))
      }
      if (memoryArtifact) {
        await writeFile(memoryPath, `${JSON.stringify(memoryArtifact, null, 2)}\n`)
      }
      if (performanceArtifact) {
        await writeFile(performancePath, `${JSON.stringify(performanceArtifact, null, 2)}\n`)
      }

      const artifact: BrowserProbeArtifact = {
        requestedUrl: targetUrl,
        url: targetUrl,
        files: {
          ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
          ...(checkpoints.length > 0 ? { checkpoints: "files/browser/checkpoints.jsonl" } : {}),
          ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
          ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
          ...(memoryArtifact ? { memory: "files/browser/memory.json" } : {}),
          ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
          ...(performanceArtifact ? { performance: "files/browser/performance.json" } : {}),
          ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
          summary: "files/browser/summary.json",
        },
        summary: {
          consoleMessages: consoleMessages.length,
          errors: errors.length,
          finalUrl,
          htmlSnapshot: capture.has("html"),
          ...(memoryArtifact ? { memory: memoryArtifact.peak } : {}),
          ...(memoryArtifact || performanceArtifact ? { metrics: browserProbeBenchMetrics(memoryArtifact, performanceArtifact) } : {}),
          networkEvents: network.length,
          ...(performanceArtifact ? { performance: performanceArtifact.peak } : {}),
          replayability: browserProbeReplayability(capture),
          screenshot: capture.has("screenshot"),
          ...(typeof scriptResult !== "undefined" ? { scriptResult } : {}),
          viewport,
        },
      }
      this.browserProbes.push(artifact)
      await writeFile(summaryPath, `${JSON.stringify({
        schema: "wp-codebox/browser-probe/v1",
        requestedUrl: targetUrl,
        finalUrl,
        waitFor,
        durationMs,
        capture: [...capture].sort(),
        startedAt,
        finishedAt: now(),
        files: artifact.files,
        hashes: {
          ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
          ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
        },
        viewport,
        summary: artifact.summary,
      }, null, 2)}\n`)
    }

    return `${JSON.stringify({
      command: "wordpress.browser-probe",
      requestedUrl: targetUrl,
      finalUrl: this.browserProbes.at(-1)?.summary.finalUrl ?? targetUrl,
      files: this.browserProbes.at(-1)?.files,
      summary: this.browserProbes.at(-1)?.summary,
    }, null, 2)}\n`
  }

  async runBrowserActions(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const steps = await browserInteractionStepsFromArgs(args)
    const initialUrl = argValue(args, "url")?.trim()
    if (steps.length === 0 && !initialUrl) {
      throw new Error("wordpress.browser-actions requires steps-json=<array> (or actions-json=<array>) or url=<path-or-url>")
    }

    if (initialUrl && steps[0]?.kind !== "navigate") {
      steps.unshift({ kind: "navigate", url: initialUrl })
    }

    // evaluate (arbitrary page JS) is gated by a dedicated policy capability,
    // mirroring how wordpress.run-php is gated. Non-JS interaction steps are
    // allowed whenever wordpress.browser-actions itself is allowed.
    if (browserInteractionScriptUsesEvaluate(steps)) {
      assertRuntimeCommandAllowed("wordpress.browser-actions.evaluate", this.spec.policy)
    }

    const capture = new Set(commaListArg(args, "capture"))
    if (capture.size === 0) {
      capture.add("steps")
      capture.add("console")
      capture.add("errors")
      capture.add("network")
      capture.add("html")
      capture.add("screenshot")
    }
    // Back-compat: "actions" remains an alias for the per-step timeline capture.
    if (capture.has("actions")) {
      capture.delete("actions")
      capture.add("steps")
    }

    for (const item of capture) {
      if (!["steps", "console", "errors", "html", "network", "screenshot"].includes(item)) {
        throw new Error(`wordpress.browser-actions capture supports steps, console, errors, html, network, screenshot: ${item}`)
      }
    }

    const stepTimeoutMs = durationArg(args, "step-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
    const totalTimeoutMs = durationArg(args, "timeout", BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS)

    const browserDirectory = join(this.artifactRoot, "files", "browser")
    await mkdir(browserDirectory, { recursive: true })

    const stepRecords: BrowserStepRecord[] = []
    const consoleMessages: Record<string, unknown>[] = []
    const errors: BrowserProbeErrorRecord[] = []
    const network: BrowserProbeNetworkRecord[] = []
    const networkTasks: Array<Promise<void>> = []
    const stepsPath = join(browserDirectory, "steps.jsonl")
    const consolePath = join(browserDirectory, "console.jsonl")
    const errorsPath = join(browserDirectory, "errors.jsonl")
    const htmlPath = join(browserDirectory, "snapshot.html")
    const networkPath = join(browserDirectory, "network.jsonl")
    const screenshotPath = join(browserDirectory, "screenshot.png")
    const summaryPath = join(browserDirectory, "action-summary.json")
    const startedAt = now()
    const startedAtMs = Date.now()
    const { chromium } = await import("playwright")
    const browser = await chromium.launch()
    let requestedUrl = initialUrl ? resolveBrowserProbeUrl(initialUrl, server.serverUrl) : server.serverUrl
    let finalUrl = requestedUrl
    let htmlSha256: string | undefined
    let screenshotSha256: string | undefined
    let viewport: BrowserProbeViewport | null = null
    let pendingError: Error | undefined

    try {
      const page = await browser.newPage()
      viewport = await browserProbeViewport(page)
      if (capture.has("console")) {
        page.on("console", (message) => consoleMessages.push(serializeBrowserConsoleMessage(message)))
      }
      if (capture.has("errors")) {
        page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
      }
      if (capture.has("network")) {
        page.on("requestfinished", (request) => {
          const task = serializeBrowserFinishedRequest(request).then((record) => {
            network.push(record)
          }).catch(() => undefined)
          networkTasks.push(task)
        })
        page.on("requestfailed", (request) => network.push(serializeBrowserRequestFailure(request)))
      }

      for (const [index, step] of steps.entries()) {
        const recordStartedAt = now()
        const recordStartedAtMs = Date.now()
        // Total-script timeout: stop before starting a step that would exceed the budget.
        if (totalTimeoutMs > 0 && recordStartedAtMs - startedAtMs >= totalTimeoutMs) {
          const timeoutError = new Error(`wordpress.browser-actions exceeded total timeout of ${totalTimeoutMs}ms before step ${index} (${step.kind})`)
          const serialized = serializeBrowserError("probe-error", timeoutError)
          errors.push(serialized)
          stepRecords.push(browserStepRecord(index, step, "failed", recordStartedAt, recordStartedAtMs, page.url(), { error: serialized }))
          pendingError = timeoutError
          break
        }
        try {
          const outcome = await executeBrowserInteractionStep(page, step, server.serverUrl, stepTimeoutMs, screenshotPath, browserDirectory)
          finalUrl = page.url()
          if (step.kind === "navigate") {
            requestedUrl = resolveBrowserProbeUrl((step.url ?? "").trim(), server.serverUrl)
          }
          if (outcome.screenshot && capture.has("screenshot") && outcome.screenshotIsDefault) {
            screenshotSha256 = await fileSha256(screenshotPath)
          }
          stepRecords.push(browserStepRecord(index, step, "ok", recordStartedAt, recordStartedAtMs, finalUrl, outcome))
          // A failed expect/evaluate assertion is a clean step failure: no silent partial success.
          if (outcome.assertion && !outcome.assertion.passed) {
            pendingError = new Error(`wordpress.browser-actions ${step.kind} assertion failed at step ${index}`)
            break
          }
        } catch (error) {
          const serialized = serializeBrowserError("probe-error", error)
          errors.push(serialized)
          stepRecords.push(browserStepRecord(index, step, "failed", recordStartedAt, recordStartedAtMs, page.url(), { error: serialized }))
          pendingError = error instanceof Error ? error : new Error(String(error))
          break
        }
      }

      if (capture.has("html")) {
        const html = await page.content()
        await writeFile(htmlPath, html)
        htmlSha256 = sha256(Buffer.from(html, "utf8"))
      }

      if (capture.has("screenshot")) {
        await page.screenshot({ path: screenshotPath, fullPage: true })
        screenshotSha256 = await fileSha256(screenshotPath)
      }
    } finally {
      if (networkTasks.length > 0) {
        await Promise.all(networkTasks)
      }
      await browser.close()
      if (capture.has("steps")) {
        await writeFile(stepsPath, jsonLines(stepRecords))
      }
      if (capture.has("console")) {
        await writeFile(consolePath, jsonLines(consoleMessages))
      }
      if (capture.has("errors")) {
        await writeFile(errorsPath, jsonLines(errors))
      }
      if (capture.has("network")) {
        await writeFile(networkPath, jsonLines(network))
      }

      const assertions = browserAssertionsSummary(stepRecords)
      const artifact: BrowserProbeArtifact = {
        requestedUrl,
        url: requestedUrl,
        files: {
          ...(capture.has("steps") ? { steps: "files/browser/steps.jsonl" } : {}),
          ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
          ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
          ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
          ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
          ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
          summary: "files/browser/action-summary.json",
        },
        summary: {
          actions: stepRecords.length,
          steps: stepRecords.length,
          ...(assertions.total > 0 ? { assertions } : {}),
          consoleMessages: consoleMessages.length,
          errors: errors.length,
          finalUrl,
          htmlSnapshot: capture.has("html"),
          networkEvents: network.length,
          replayability: browserProbeReplayability(capture),
          screenshot: capture.has("screenshot"),
          viewport,
        },
      }
      this.browserProbes.push(artifact)
      await writeFile(summaryPath, `${JSON.stringify({
        schema: "wp-codebox/browser-actions/v1",
        requestedUrl,
        finalUrl,
        capture: [...capture].sort(),
        stepTimeoutMs,
        totalTimeoutMs,
        steps: stepRecords,
        ...(assertions.total > 0 ? { assertions } : {}),
        startedAt,
        finishedAt: now(),
        files: artifact.files,
        hashes: {
          ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
          ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
        },
        viewport,
        summary: artifact.summary,
      }, null, 2)}\n`)
    }

    if (pendingError) {
      throw new Error(`wordpress.browser-actions failed after ${stepRecords.length} step(s): ${pendingError.message}`)
    }

    return `${JSON.stringify({
      command: "wordpress.browser-actions",
      requestedUrl,
      finalUrl: this.browserProbes.at(-1)?.summary.finalUrl ?? finalUrl,
      files: this.browserProbes.at(-1)?.files,
      summary: this.browserProbes.at(-1)?.summary,
      steps: stepRecords,
    }, null, 2)}\n`
  }

  async runPhp(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const code = await phpCodeFromArgs(spec.args ?? [])
    const bridge = argValue(spec.args ?? [], "wp-cli-bridge") === "1" ? await this.createRuntimeWpCliBridge(server) : undefined
    let response: PlaygroundRunResponse
    try {
      response = await this.runPlaygroundCommand("wordpress.run-php", server, { code: bootstrapPhpCode(this.spec, code, spec.args ?? [], bridge) })
      assertPlaygroundResponseOk("wordpress.run-php", response)
    } finally {
      if (bridge) {
        await bridge.close()
      }
    }

    return response.text
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
    const args = spec.args ?? []
    const pluginSlug = argValue(args, "plugin-slug")?.trim()
    if (!pluginSlug) {
      throw new Error("wordpress.plugin-check requires plugin-slug=<slug>")
    }

    if (!/^[a-z0-9][a-z0-9_-]*$/.test(pluginSlug)) {
      throw new Error("wordpress.plugin-check plugin-slug must be a WordPress plugin slug")
    }
    const checkSlugs = commaListArg(args, "checks")

    if (!server.playground.writeFile) {
      throw new Error("wordpress.plugin-check requires a Playground backend with writeFile support")
    }

    const pluginPath = `/wordpress/wp-content/plugins/${pluginSlug}`
    const existsResponse = await this.runWpCliCommand(server, ["plugin", "path", pluginSlug])
    if (existsResponse.exitCode !== 0) {
      throw new Error(`wordpress.plugin-check target plugin is not installed or mounted at ${pluginPath}`)
    }

    const rawResponse = await this.runWpCliCommand(server, [
      "plugin",
      "check",
      pluginSlug,
      "--format=strict-json",
      "--fields=file,line,column,type,code,message,docs",
      "--mode=new",
      ...(checkSlugs.length > 0 ? [`--checks=${checkSlugs.join(",")}`] : []),
    ])
    const rawOutput = cleanWpCliOutput(rawResponse.text)
    const normalized = normalizePluginCheckOutput(rawOutput, rawResponse.exitCode ?? 0, pluginSlug)
    const pluginCheckDirectory = join(this.artifactRoot, "files", "plugin-check")
    await mkdir(pluginCheckDirectory, { recursive: true })
    const safeSlug = pluginSlug.replace(/[^a-z0-9_-]/gi, "-")
    const rawPath = join(pluginCheckDirectory, `${safeSlug}.raw.json`)
    const normalizedPath = join(pluginCheckDirectory, `${safeSlug}.json`)
    await writeFile(rawPath, rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`)
    await writeFile(normalizedPath, `${JSON.stringify(normalized, null, 2)}\n`)
    this.pluginChecks.push({
      targetPlugin: pluginSlug,
      files: {
        raw: relative(this.artifactRoot, rawPath),
        normalized: relative(this.artifactRoot, normalizedPath),
      },
      summary: normalized.summary,
    })

    return `${JSON.stringify(normalized, null, 2)}\n`
  }

  async runThemeCheck(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const theme = argValue(args, "theme")?.trim()
    if (!theme) {
      throw new Error("wordpress.theme-check requires theme=<slug>")
    }

    if (!server.playground.writeFile) {
      throw new Error("wordpress.theme-check requires a Playground backend with writeFile support")
    }

    if (!await this.themeCheckPluginInstalled(server)) {
      const install = await this.runWpCliArgv(server, ["plugin", "install", "theme-check"])
      assertPlaygroundResponseOk("wordpress.theme-check", install)
    }

    const response = await this.runPlaygroundCommand("wordpress.theme-check", server, { code: bootstrapPhpCode(this.spec, themeCheckRunCode(theme), []) })
    assertPlaygroundResponseOk("wordpress.theme-check", response)
    const raw = cleanWpCliOutput(response.text)
    const normalized = normalizeThemeCheckOutput(raw, response.exitCode ?? 0, theme)
    await this.writeThemeCheckArtifacts(theme, raw, normalized)

    return `${JSON.stringify(normalized, null, 2)}\n`
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
    const name = argValue(spec.args ?? [], "name")?.trim()
    if (!name) {
      throw new Error("wordpress.ability requires name=<ability-name>")
    }

    const input = abilityInputFromArgs(spec.args ?? [])
    const response = await this.runPlaygroundCommand("wordpress.ability", server, { code: bootstrapAbilityPhpCode(this.spec, abilityPhpCode(name, input)) })
    assertPlaygroundResponseOk("wordpress.ability", response)
    return response.text
  }

  async runBench(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const pluginSlug = argValue(args, "plugin-slug")?.trim()
    if (!pluginSlug) {
      throw new Error("wordpress.bench requires plugin-slug=<slug>")
    }

    const componentId = argValue(args, "component-id")?.trim() || pluginSlug
    const iterations = positiveIntegerArg(args, "iterations", 3)
    const warmupIterations = nonNegativeIntegerArg(args, "warmup", 1)
    const dependencySlugs = commaListArg(args, "dependency-slugs")
    const env = jsonObjectArg(args, "env-json")
    const workloads = jsonArrayArg(args, "workloads-json")
    const bridge = benchWorkloadsUseWpCli(workloads) ? await this.createRuntimeWpCliBridge(server) : undefined
    let response: PlaygroundRunResponse
    try {
      response = await this.runPlaygroundCommand("wordpress.bench", server, {
        code: bootstrapPhpCode(this.spec, benchRunCode({ componentId, pluginSlug, iterations, warmupIterations, dependencySlugs, env, workloads, wpCliBridge: bridge }), []),
      })
      assertPlaygroundResponseOk("wordpress.bench", response)
    } finally {
      if (bridge) {
        await bridge.close()
      }
    }

    return promoteBrowserMetricsToBenchResults(response.text, this.browserProbes)
  }

  async runPhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const explicitCode = argValue(args, "code") || argValue(args, "code-file")
    const pluginSlug = argValue(args, "plugin-slug")?.trim() || ""
    const code = explicitCode ? await phpCodeFromArgs(args, "wordpress.phpunit") : normalizePhpCode(phpunitRunCode({
      pluginSlug,
      autoloadFile: argValue(args, "autoload-file")?.trim() || "/wp-codebox-vendor/autoload.php",
      testsDir: argValue(args, "tests-dir")?.trim() || "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
      phpunitXml: argValue(args, "phpunit-xml")?.trim() || `/wordpress/wp-content/plugins/${pluginSlug}/phpunit.xml.dist`,
      selectedTestFile: argValue(args, "test-file")?.trim() || "",
      changedTestFiles: jsonArrayArg(args, "changed-tests-json"),
      env: jsonObjectArg(args, "env-json"),
      wpConfigDefines: jsonObjectArg(args, "wp-config-defines-json"),
      dependencyMounts: commaListArg(args, "dependency-mounts"),
      multisite: booleanArg(args, "multisite"),
    }))
    if (!explicitCode && !pluginSlug) {
      throw new Error("wordpress.phpunit requires plugin-slug=<slug> when code/code-file is not provided")
    }
    const response = await this.runPlaygroundCommand("wordpress.phpunit", server, { code })
    await persistVfsDiagnosticFile(server, `/wordpress/wp-content/plugins/${pluginSlug}/.pg-test-result.txt`, this.mounts)
    assertPlaygroundResponseOk("wordpress.phpunit", response)

    return response.text
  }

  async runCorePhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const explicitCode = argValue(args, "code") || argValue(args, "code-file")
    // Write structured diagnostics to a sandbox-internal /tmp path rather than inside
    // the (often read-only) core mount, so the result survives read-only mounts and a
    // mid-require die() in core's bootstrap.php and can be read back from the VFS (#314).
    const resultFile = CORE_PHPUNIT_RESULT_FILE
    const code = explicitCode ? await phpCodeFromArgs(args, "wordpress.core-phpunit") : normalizePhpCode(corePhpunitRunCode({
      coreRoot: argValue(args, "core-root")?.trim() || "/wordpress",
      testsDir: argValue(args, "tests-dir")?.trim() || "/wordpress/tests/phpunit",
      phpunitXml: argValue(args, "phpunit-xml")?.trim() || "/wordpress/tests/phpunit/phpunit.xml.dist",
      selectedTestFile: argValue(args, "test-file")?.trim() || "",
      changedTestFiles: jsonArrayArg(args, "changed-tests-json"),
      autoloadFile: argValue(args, "autoload-file")?.trim() || "/wordpress/vendor/autoload.php",
      wpConfigDefines: jsonObjectArg(args, "wp-config-defines-json"),
      multisite: booleanArg(args, "multisite"),
      resultFile,
    }))

    let response: PlaygroundRunResponse
    try {
      response = await this.runPlaygroundCommand("wordpress.core-phpunit", server, { code })
    } catch (error) {
      // Core's bootstrap can die() mid-require when the Composer test toolchain is
      // absent, which surfaces here as a PlaygroundCommandCrashError with empty
      // output. Recover the structured diagnostics the PHP shutdown handler flushed
      // to the result file and re-throw a clear, actionable error instead (#314).
      await persistCorePhpunitResult(server, resultFile, this.artifactRoot)
      const structured = await readCorePhpunitDiagnostic(server, resultFile)
      if (structured) {
        throw new Error(`wordpress.core-phpunit could not run: ${structured}`)
      }
      throw error
    }

    await persistCorePhpunitResult(server, resultFile, this.artifactRoot)
    assertPlaygroundResponseOk("wordpress.core-phpunit", response)

    return response.text
  }

  private async runWpCliArgv(server: PlaygroundCliServer, argv: string[]): Promise<PlaygroundRunResponse> {
    if (!server.playground.writeFile) {
      throw new Error("WP-CLI commands require a Playground backend with writeFile support")
    }

    const scriptPath = `/tmp/wp-codebox-wp-cli-${this.commands.length}-${Date.now().toString(36)}.php`
    await server.playground.writeFile(scriptPath, wpCliPhpScript(argv))
    return this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
  }

  private async themeCheckPluginInstalled(server: PlaygroundCliServer): Promise<boolean> {
    const response = await this.runPlaygroundCommand("wordpress.theme-check", server, {
      code: "<?php echo file_exists('/wordpress/wp-content/plugins/theme-check/theme-check.php') ? 'yes' : 'no';",
    })

    return response.text.trim() === "yes"
  }

  private async writeThemeCheckArtifacts(theme: string, raw: string, normalized: ReturnType<typeof normalizeThemeCheckOutput>): Promise<void> {
    const safeTheme = theme.replace(/[^a-z0-9_-]/gi, "-") || "theme"
    const directory = join(this.artifactRoot, "files", "theme-check")
    await mkdir(directory, { recursive: true })
    const rawPath = join(directory, `${safeTheme}.raw.txt`)
    const normalizedPath = join(directory, `${safeTheme}.normalized.json`)
    await writeFile(rawPath, raw.endsWith("\n") ? raw : `${raw}\n`)
    await writeFile(normalizedPath, `${JSON.stringify(normalized, null, 2)}\n`)
    this.themeChecks.push({
      theme,
      files: {
        raw: relative(this.artifactRoot, rawPath),
        normalized: relative(this.artifactRoot, normalizedPath),
      },
      summary: normalized.summary,
      status: normalized.status,
      exitCode: normalized.exitCode,
    })
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
      return this.observeWordPressState(spec, observationId)
    }

    if (spec.type === "http-response") {
      return this.observeHttpResponse(spec, observationId)
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

  private async observeWordPressState(spec: ObservationSpec, observationId: string): Promise<{ data: unknown; artifactRefs: RuntimeEpisodeTraceRef[] }> {
    const cliServer = await this.bootPlayground()
    const config = {
      sections: spec.sections,
      redaction: spec.redaction ?? "safe",
      includeContent: spec.includeContent === true,
      optionNames: spec.optionNames,
      userFields: spec.userFields,
    }
    const response = await cliServer.playground.run({ code: bootstrapPhpCode(this.spec, `
$config = json_decode( ${JSON.stringify(JSON.stringify(config))}, true );
$requested_sections = isset( $config['sections'] ) && is_array( $config['sections'] ) ? array_values( array_unique( array_map( 'strval', $config['sections'] ) ) ) : array( 'summary' );
$redaction = isset( $config['redaction'] ) ? (string) $config['redaction'] : 'safe';
$include_content = ! empty( $config['includeContent'] );
$option_names = isset( $config['optionNames'] ) && is_array( $config['optionNames'] ) ? array_values( array_unique( array_map( 'strval', $config['optionNames'] ) ) ) : array();
$user_fields = isset( $config['userFields'] ) && is_array( $config['userFields'] ) ? array_values( array_unique( array_map( 'strval', $config['userFields'] ) ) ) : array();
$allowed_sections = array( 'summary', 'posts', 'terms', 'menus', 'templates', 'media', 'options', 'users', 'rest-routes', 'abilities' );
$sections = array_values( array_intersect( $requested_sections, $allowed_sections ) );
if ( empty( $sections ) ) {
    $sections = array( 'summary' );
}

$hash_value = function ( $value ) {
    return hash( 'sha256', wp_json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) );
};

$post_counts = array();
foreach ( get_post_types( array(), 'names' ) as $post_type ) {
    $counts = wp_count_posts( $post_type );
    $post_counts[ $post_type ] = array();
    foreach ( get_object_vars( $counts ) as $status => $count ) {
        $post_counts[ $post_type ][ $status ] = (int) $count;
    }
}

$exports = array();
$exports['summary'] = array(
    'siteUrl'           => get_site_url(),
    'homeUrl'           => get_home_url(),
    'wordpressVersion'  => get_bloginfo( 'version' ),
    'activeTheme'       => wp_get_theme()->get_stylesheet(),
    'activePlugins'     => array_values( (array) get_option( 'active_plugins', array() ) ),
    'postCounts'        => $post_counts,
);

if ( in_array( 'posts', $sections, true ) ) {
    $post_types = get_post_types( array( 'public' => true ), 'names' );
    $posts = get_posts( array(
        'post_type'      => array_values( $post_types ),
        'post_status'    => 'any',
        'posts_per_page' => 200,
        'orderby'        => 'ID',
        'order'          => 'ASC',
    ) );
    $exports['posts'] = array_map( function ( $post ) use ( $include_content, $hash_value ) {
        $entry = array(
            'id'          => (int) $post->ID,
            'type'        => $post->post_type,
            'slug'        => $post->post_name,
            'status'      => $post->post_status,
            'title'       => get_the_title( $post ),
            'contentHash' => $hash_value( (string) $post->post_content ),
            'modifiedGmt' => $post->post_modified_gmt,
        );
        if ( $include_content ) {
            $entry['content'] = (string) $post->post_content;
        }
        return $entry;
    }, $posts );
}

if ( in_array( 'terms', $sections, true ) ) {
    $terms = get_terms( array( 'hide_empty' => false ) );
    $exports['terms'] = is_wp_error( $terms ) ? array() : array_map( function ( $term ) {
        return array(
            'id'       => (int) $term->term_id,
            'taxonomy' => $term->taxonomy,
            'slug'     => $term->slug,
            'name'     => $term->name,
            'parent'   => (int) $term->parent,
            'count'    => (int) $term->count,
        );
    }, $terms );
}

if ( in_array( 'menus', $sections, true ) ) {
    $menus = wp_get_nav_menus();
    $exports['menus'] = array_map( function ( $menu ) {
        $items = wp_get_nav_menu_items( $menu->term_id );
        return array(
            'id'    => (int) $menu->term_id,
            'slug'  => $menu->slug,
            'name'  => $menu->name,
            'items' => is_array( $items ) ? array_map( function ( $item ) {
                return array(
                    'id'       => (int) $item->ID,
                    'title'    => $item->title,
                    'url'      => $item->url,
                    'parentId' => (int) $item->menu_item_parent,
                    'object'   => $item->object,
                    'type'     => $item->type,
                );
            }, $items ) : array(),
        );
    }, $menus );
}

if ( in_array( 'templates', $sections, true ) ) {
    $exports['templates'] = array(
        'theme'         => wp_get_theme()->get_stylesheet(),
        'templates'     => function_exists( 'get_block_templates' ) ? array_map( function ( $template ) use ( $hash_value ) {
            return array(
                'id'          => $template->id ?? '',
                'slug'        => $template->slug ?? '',
                'theme'       => $template->theme ?? '',
                'type'        => $template->type ?? '',
                'source'      => $template->source ?? '',
                'contentHash' => $hash_value( (string) ( $template->content ?? '' ) ),
            );
        }, get_block_templates( array(), 'wp_template' ) ) : array(),
        'templateParts' => function_exists( 'get_block_templates' ) ? array_map( function ( $template ) use ( $hash_value ) {
            return array(
                'id'          => $template->id ?? '',
                'slug'        => $template->slug ?? '',
                'theme'       => $template->theme ?? '',
                'area'        => $template->area ?? '',
                'source'      => $template->source ?? '',
                'contentHash' => $hash_value( (string) ( $template->content ?? '' ) ),
            );
        }, get_block_templates( array(), 'wp_template_part' ) ) : array(),
        'globalStyles'  => function_exists( 'wp_get_global_stylesheet' ) ? array( 'stylesheetHash' => $hash_value( wp_get_global_stylesheet() ) ) : null,
    );
}

if ( in_array( 'media', $sections, true ) ) {
    $attachments = get_posts( array(
        'post_type'      => 'attachment',
        'post_status'    => 'any',
        'posts_per_page' => 200,
        'orderby'        => 'ID',
        'order'          => 'ASC',
    ) );
    $exports['media'] = array_map( function ( $attachment ) {
        return array(
            'id'       => (int) $attachment->ID,
            'slug'     => $attachment->post_name,
            'title'    => get_the_title( $attachment ),
            'mimeType' => $attachment->post_mime_type,
            'metadata' => wp_get_attachment_metadata( $attachment->ID ),
        );
    }, $attachments );
}

if ( in_array( 'options', $sections, true ) ) {
    $exports['options'] = array();
    foreach ( $option_names as $option_name ) {
        $exports['options'][ $option_name ] = get_option( $option_name, null );
    }
}

if ( in_array( 'users', $sections, true ) ) {
    $allowed_user_fields = array_intersect( $user_fields, array( 'ID', 'user_login', 'display_name', 'roles', 'caps' ) );
    $users = get_users( array( 'orderby' => 'ID', 'order' => 'ASC' ) );
    $exports['users'] = array_map( function ( $user ) use ( $allowed_user_fields, $redaction ) {
        $entry = array( 'id' => (int) $user->ID, 'redacted' => 'none' !== $redaction );
        foreach ( $allowed_user_fields as $field ) {
            if ( 'ID' === $field ) {
                $entry['ID'] = (int) $user->ID;
            } elseif ( 'roles' === $field ) {
                $entry['roles'] = array_values( (array) $user->roles );
            } elseif ( 'caps' === $field ) {
                $entry['caps'] = array_keys( array_filter( (array) $user->allcaps ) );
            } elseif ( 'none' === $redaction ) {
                $entry[ $field ] = (string) $user->{$field};
            }
        }
        return $entry;
    }, $users );
}

if ( in_array( 'rest-routes', $sections, true ) ) {
    $routes = rest_get_server()->get_routes();
    $exports['rest-routes'] = array_map( function ( $route, $handlers ) {
        return array(
            'route'   => $route,
            'methods' => array_values( array_unique( array_reduce( $handlers, function ( $methods, $handler ) {
                foreach ( (array) ( $handler['methods'] ?? array() ) as $method => $enabled ) {
                    if ( $enabled ) {
                        $methods[] = is_string( $method ) ? $method : (string) $enabled;
                    }
                }
                return $methods;
            }, array() ) ) ),
        );
    }, array_keys( $routes ), $routes );
}

if ( in_array( 'abilities', $sections, true ) ) {
    $abilities = array();
    if ( function_exists( 'wp_get_abilities' ) ) {
        $registered = wp_get_abilities();
        if ( is_array( $registered ) ) {
            foreach ( $registered as $name => $ability ) {
                $abilities[] = array(
                    'name'        => (string) $name,
                    'description' => is_array( $ability ) ? (string) ( $ability['description'] ?? '' ) : '',
                    'category'    => is_array( $ability ) ? (string) ( $ability['category'] ?? '' ) : '',
                );
            }
        }
    }
    $exports['abilities'] = $abilities;
}

echo wp_json_encode( array(
    'schema'    => 'wp-codebox/wordpress-state-export/v1',
    'version'   => 1,
    'generatedAt' => gmdate( 'c' ),
    'config'    => array(
        'sections'       => $sections,
        'redaction'      => $redaction,
        'includeContent' => $include_content,
        'optionNames'    => $option_names,
        'userFields'     => $user_fields,
    ),
    'sections'  => $exports,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
`, []) })
    assertPlaygroundResponseOk("observe.wordpress-state", response)
    const stateExport = JSON.parse(response.text || "{}") as {
      schema?: string
      version?: number
      generatedAt?: string
      config?: Record<string, unknown>
      sections?: Record<string, unknown>
    }
    const sectionArtifacts: Record<string, { artifact: string; sha256: string; bytes: number }> = {}
    const artifactRefs: RuntimeEpisodeTraceRef[] = []
    const sections = stateExport.sections ?? {}

    for (const [section, contents] of Object.entries(sections)) {
      const serialized = `${JSON.stringify({ schema: "wp-codebox/wordpress-state-section/v1", section, data: contents }, null, 2)}\n`
      const digest = createHash("sha256").update(serialized).digest("hex")
      const relativePath = `files/observations/${observationId}-wordpress-state-${safeArtifactSegment(section)}.json`
      await mkdir(dirname(join(this.artifactRoot, relativePath)), { recursive: true })
      await writeFile(join(this.artifactRoot, relativePath), serialized)
      sectionArtifacts[section] = { artifact: relativePath, sha256: digest, bytes: Buffer.byteLength(serialized) }
      artifactRefs.push({
        kind: "wordpress-state-section",
        id: `${observationId}:${section}`,
        path: relativePath,
        digest: { algorithm: "sha256", value: digest },
      })
    }

    return {
      data: {
        schema: stateExport.schema ?? "wp-codebox/wordpress-state-export/v1",
        version: stateExport.version ?? 1,
        generatedAt: stateExport.generatedAt,
        config: stateExport.config,
        sections: Object.fromEntries(Object.entries(sections).map(([section, contents]) => [section, summarizeWordPressStateSection(section, contents)])),
        artifacts: sectionArtifacts,
      },
      artifactRefs,
    }
  }

  private async observeHttpResponse(spec: ObservationSpec, observationId: string): Promise<{ data: unknown; artifactRefs: RuntimeEpisodeTraceRef[] }> {
    const url = await this.resolveObservationUrl(spec.url ?? spec.path ?? "/")
    const response = await fetch(url, {
      method: spec.method ?? "GET",
      headers: spec.headers,
      body: spec.body,
    })
    const body = await response.text()
    const bodyDigest = createHash("sha256").update(body).digest("hex")
    const artifactRefs: RuntimeEpisodeTraceRef[] = []
    const data: Record<string, unknown> = {
      url,
      method: spec.method ?? "GET",
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      bodySha256: bodyDigest,
      bodyBytes: Buffer.byteLength(body),
    }

    if (spec.includeBody === true && body.length <= 4096) {
      data.body = body
    } else if (body.length > 0) {
      const relativePath = `files/observations/${observationId}-body.txt`
      await mkdir(dirname(join(this.artifactRoot, relativePath)), { recursive: true })
      await writeFile(join(this.artifactRoot, relativePath), body)
      artifactRefs.push({
        kind: "observation-artifact",
        id: `${observationId}:body`,
        path: relativePath,
        digest: { algorithm: "sha256", value: bodyDigest },
      })
    }

    return { data, artifactRefs }
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

  private pluginCheckManifestFiles(): ArtifactManifestFile[] {
    return this.pluginChecks.flatMap((check) => [
      fileEntry(join(this.artifactRoot, check.files.raw), "plugin-check-raw", "application/json"),
      fileEntry(join(this.artifactRoot, check.files.normalized), "plugin-check", "application/json"),
    ])
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

  private async redactPluginCheckArtifacts(redactor: ArtifactRedactor): Promise<void> {
    for (const check of this.pluginChecks) {
      for (const path of [check.files.raw, check.files.normalized]) {
        const absolutePath = join(this.artifactRoot, path)
        try {
          await writeFile(absolutePath, redactor.redact(path, await readFile(absolutePath, "utf8")))
        } catch {
          // Plugin Check artifacts are generated before bundle collection; tolerate missing files.
        }
      }
    }
  }

  private themeCheckManifestFiles(): ArtifactManifestFile[] {
    if (this.themeChecks.length === 0) {
      return []
    }

    const files = new Map<string, { kind: string; contentType: string }>()
    for (const check of this.themeChecks) {
      files.set(check.files.raw, { kind: "theme-check-raw", contentType: "text/plain" })
      files.set(check.files.normalized, { kind: "theme-check-normalized", contentType: "application/json" })
    }

    return [...files.entries()].map(([path, entry]) => fileEntry(join(this.artifactRoot, path), entry.kind, entry.contentType))
  }

  private async redactThemeCheckArtifacts(redactor: ArtifactRedactor): Promise<void> {
    for (const check of this.themeChecks) {
      for (const path of [check.files.raw, check.files.normalized]) {
        const absolutePath = join(this.artifactRoot, path)
        try {
          await writeFile(absolutePath, redactor.redact(path, await readFile(absolutePath, "utf8")))
        } catch {
          // Theme Check capture is best-effort; preserve artifact collection if a file vanished.
        }
      }
    }
  }
}

export function createPlaygroundRuntimeBackend(): RuntimeBackend {
  return new PlaygroundRuntimeBackend()
}

function safeArtifactSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "section"
}

function summarizeWordPressStateSection(section: string, contents: unknown): unknown {
  if (section === "summary") {
    return contents
  }

  if (Array.isArray(contents)) {
    return { count: contents.length }
  }

  if (contents && typeof contents === "object") {
    const entries = Object.entries(contents as Record<string, unknown>)
    return {
      count: entries.length,
      keys: entries.map(([key]) => key),
    }
  }

  return { count: contents == null ? 0 : 1 }
}

function resolveBrowserProbeUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return new URL(pathOrUrl).toString()
  } catch {
    return new URL(pathOrUrl, baseUrl).toString()
  }
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path))
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

function durationArg(args: string[], name: string, fallbackMs: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return fallbackMs
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) {
    throw new Error(`${name} must be a duration like 500ms or 2s`)
  }

  const value = Number.parseFloat(match[1])
  return Math.max(0, Math.round(match[2] === "ms" ? value : value * 1000))
}
