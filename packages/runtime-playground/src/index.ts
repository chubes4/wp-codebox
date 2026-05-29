import { createHash, randomBytes } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { basename, dirname, join, relative, resolve } from "node:path"
import { RUNTIME_EPISODE_OBSERVATION_SCHEMA, assertRuntimeCommandAllowed, getCommandDefinition, runtimeEpisodeDigest, type PlaygroundRuntimeCommandId } from "@chubes4/wp-codebox-core"
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
import { playgroundBlueprint } from "./blueprint.js"
import { abilityInputFromArgs, abilityPhpCode, argValue, benchRunCode, booleanArg, cleanWpCliOutput, commaListArg, corePhpunitRunCode, isSafeEnvName, jsonArrayArg, jsonObjectArg, nonNegativeIntegerArg, normalizePhpCode, normalizePluginCheckOutput, normalizeThemeCheckOutput, phpBody, phpunitRunCode, positiveIntegerArg, shellArgv, themeCheckRunCode, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
import type {
  ArtifactBundle,
  ArtifactManifestFile,
  ArtifactPreview,
  ArtifactReviewBrowserSummary,
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
  RuntimeEpisodeTraceRef,
  RuntimeInfo,
  Snapshot,
} from "@chubes4/wp-codebox-core"
import type { ConsoleMessage, Page, Request, Response } from "playwright"

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

interface RuntimeWpCliBridge {
  url: string
  token: string
  close: () => Promise<void>
}

interface RuntimeWpCliCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runtimeWpCliCommandArgv(command: string): string[][] {
  const tokens = shellArgv(command)
  const commands: string[][] = []
  let current: string[] = []

  for (const token of tokens) {
    if (token === "&&" || token === ";" || token === "||") {
      if (current.length > 0) {
        commands.push(runtimeWpCliNormalizeArgv(current))
        current = []
      }
      if (token === "||") {
        break
      }
      continue
    }

    if (token === "|") {
      break
    }

    current.push(token)
  }

  if (current.length > 0) {
    commands.push(runtimeWpCliNormalizeArgv(current))
  }

  return commands.filter((argv) => argv.length > 0)
}

function runtimeWpCliNormalizeArgv(argv: string[]): string[] {
  return argv[0] === "wp" ? argv.slice(1) : argv
}

class PlaygroundCommandError extends Error {
  readonly code = "wp-codebox-playground-command-failed"

  constructor(readonly command: string, readonly response: PlaygroundRunResponse) {
    super(playgroundFailureMessage(command, response))
    this.name = "PlaygroundCommandError"
  }
}

class PlaygroundCommandCrashError extends Error {
  readonly code = "wp-codebox-playground-command-crashed"

  constructor(readonly command: string, readonly cause: unknown) {
    super(`${command} crashed before producing a structured response\n\n${errorMessage(cause)}`)
    this.name = "PlaygroundCommandCrashError"
  }
}

class PlaygroundCliExitError extends Error {
  readonly code = "wp-codebox-playground-cli-exited"

  constructor(readonly exitCode: number) {
    super(`WordPress Playground CLI exited while booting the runtime with exit code ${exitCode}.`)
    this.name = "PlaygroundCliExitError"
  }
}

class PlaygroundPreviewPortUnavailableError extends Error {
  readonly code = "wp-codebox-preview-port-in-use"

  constructor(readonly port: number, readonly cause: unknown) {
    super(`--preview-port ${port} is unavailable: EADDRINUSE. Choose another port or stop the process currently using it.`)
    this.name = "PlaygroundPreviewPortUnavailableError"
  }
}

function assertPlaygroundResponseOk(command: string, response: PlaygroundRunResponse): void {
  if (typeof response.exitCode === "number" && response.exitCode !== 0) {
    throw new PlaygroundCommandError(command, response)
  }
}

function playgroundFailureMessage(command: string, response: PlaygroundRunResponse): string {
  const lines = [`${command} failed with exit code ${response.exitCode ?? "unknown"}`]
  const errors = response.errors?.trim()
  const text = response.text?.trim()

  if (errors) {
    lines.push("", "--- Playground errors ---", errors)
  }

  if (text) {
    lines.push("", "--- Playground output ---", text)
  }

  return lines.join("\n")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runPlaygroundCliWithoutProcessExit<T>(callback: () => Promise<T>): Promise<T> {
  const exit = process.exit
  process.exit = ((code?: string | number | null | undefined): never => {
    const exitCode = typeof code === "number" ? code : 1
    throw new PlaygroundCliExitError(exitCode)
  }) as typeof process.exit

  try {
    return await callback()
  } finally {
    process.exit = exit
  }
}

interface PlaygroundCliServer {
  playground: {
    run(options: { code: string } | { scriptPath: string }): Promise<PlaygroundRunResponse>
    readFileAsText?(path: string): string | Promise<string>
    writeFile?(path: string, contents: string): Promise<void>
  }
  serverUrl: string
  [Symbol.asyncDispose](): Promise<void>
}

interface PlaygroundPreviewProxy {
  serverUrl: string
  dispose(): Promise<void>
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
    "site-url"?: string
  }): Promise<PlaygroundCliServer>
}

interface BrowserProbeArtifact {
  requestedUrl: string
  url: string
  files: {
    actions?: string
    console?: string
    errors?: string
    html?: string
    network?: string
    screenshot?: string
    summary: string
  }
  summary: {
    actions?: number
    consoleMessages: number
    errors: number
    finalUrl: string
    htmlSnapshot: boolean
    networkEvents: number
    replayability: BrowserProbeReplayability
    screenshot: boolean
    viewport: BrowserProbeViewport | null
  }
}

interface BrowserProbeViewport {
  width: number
  height: number
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  userAgent: string
}

type BrowserProbeReplayability = "artifact-backed" | "partial" | "diagnostic-only"

interface BrowserActionRecord {
  index: number
  type: string
  status: "ok" | "failed"
  startedAt: string
  finishedAt: string
  url?: string
  selector?: string
  text?: string
  key?: string
  waitFor?: string
  duration?: string
  finalUrl?: string
  error?: BrowserProbeErrorRecord
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

interface BrowserProbeErrorRecord {
  type: "pageerror" | "probe-error"
  name: string
  message: string
  stack?: string
  timestamp: string
}

interface BrowserProbeNetworkRecord {
  type: "response" | "requestfailed"
  url: string
  method: string
  resourceType: string
  timestamp: string
  status?: number
  statusText?: string
  ok?: boolean
  contentType?: string | null
  failure?: ReturnType<Request["failure"]>
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
}

export function playgroundRuntimeCommandIds(): string[] {
  return Object.keys(PlaygroundRuntime.commandHandlers)
}

class PlaygroundRuntime implements Runtime {
  static readonly commandHandlers = {
    "inspect-mounted-inputs": (runtime) => runtime.inspectMountedInputs(),
    "wordpress.run-php": (runtime, spec) => runtime.runPhp(spec),
    "wordpress.wp-cli": (runtime, spec) => runtime.runWpCli(spec),
    "wordpress.ability": (runtime, spec) => runtime.runAbility(spec),
    "wordpress.bench": (runtime, spec) => runtime.runBench(spec),
    "wordpress.phpunit": (runtime, spec) => runtime.runPhpunit(spec),
    "wordpress.plugin-check": (runtime, spec) => runtime.runPluginCheck(spec),
    "wordpress.core-phpunit": (runtime, spec) => runtime.runCorePhpunit(spec),
    "wordpress.theme-check": (runtime, spec) => runtime.runThemeCheck(spec),
    "wordpress.browser-probe": (runtime, spec) => runtime.runBrowserProbe(spec),
    "wordpress.browser-actions": (runtime, spec) => runtime.runBrowserActions(spec),
  } satisfies Record<PlaygroundRuntimeCommandId, (runtime: PlaygroundRuntime, spec: ExecutionSpec) => Promise<string> | string>

  private status: RuntimeInfo["status"] = "created"
  private readonly runtimeId = id("runtime")
  private readonly createdAt = now()
  private readonly mounts: MountSpec[] = []
  private readonly commands: ExecutionResult[] = []
  private readonly observations: ObservationResult[] = []
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
    const snapshot = {
      id: id("snapshot"),
      createdAt: now(),
      semantics: "metadata-only" as const,
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
    return new ArtifactBundleBuilder({
      artifactRoot: this.artifactRoot,
      runtimeId: this.runtimeId,
      runtimeCreatedAt: this.createdAt,
      spec: this.spec,
      mounts: this.mounts,
      commands: this.commands,
      observations: this.observations,
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

  private async executePlaygroundCommand(spec: ExecutionSpec): Promise<string> {
    const definition = getCommandDefinition(spec.command)
    if (definition?.handler.kind === "playground") {
      const handler = PlaygroundRuntime.commandHandlers[definition.id as PlaygroundRuntimeCommandId]
      if (!handler) {
        throw new Error(`No Playground command handler is registered for: ${spec.command}`)
      }
      return handler(this, spec)
    }

    throw new Error(`No Playground command handler is registered for: ${spec.command}`)
  }

  private async runBrowserProbe(spec: ExecutionSpec): Promise<string> {
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
      if (!["console", "errors", "html", "network", "screenshot"].includes(item)) {
        throw new Error(`wordpress.browser-probe capture supports console, errors, html, network, screenshot: ${item}`)
      }
    }

    const waitFor = argValue(args, "wait-for")?.trim() || "domcontentloaded"
    const durationMs = durationArg(args, "duration", 0)
    const targetUrl = resolveBrowserProbeUrl(urlArg, server.serverUrl)
    const browserDirectory = join(this.artifactRoot, "files", "browser")
    await mkdir(browserDirectory, { recursive: true })

    const consoleMessages: Record<string, unknown>[] = []
    const errors: BrowserProbeErrorRecord[] = []
    const network: BrowserProbeNetworkRecord[] = []
    const consolePath = join(browserDirectory, "console.jsonl")
    const errorsPath = join(browserDirectory, "errors.jsonl")
    const htmlPath = join(browserDirectory, "snapshot.html")
    const networkPath = join(browserDirectory, "network.jsonl")
    const screenshotPath = join(browserDirectory, "screenshot.png")
    const summaryPath = join(browserDirectory, "summary.json")
    const startedAt = now()
    const { chromium } = await import("playwright")
    const browser = await chromium.launch()
    let finalUrl = targetUrl
    let htmlSha256: string | undefined
    let screenshotSha256: string | undefined
    let viewport: BrowserProbeViewport | null = null

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
        page.on("response", (response) => network.push(serializeBrowserResponse(response)))
        page.on("requestfailed", (request) => network.push(serializeBrowserRequestFailure(request)))
      }

      await navigateBrowserProbe(page, targetUrl, waitFor, durationMs)
      if (durationMs > 0 && waitFor !== "duration") {
        await page.waitForTimeout(durationMs)
      }
      finalUrl = page.url()

      if (capture.has("html")) {
        const html = await page.content()
        await writeFile(htmlPath, html)
        htmlSha256 = sha256(Buffer.from(html, "utf8"))
      }

      if (capture.has("screenshot")) {
        await page.screenshot({ path: screenshotPath, fullPage: true })
        screenshotSha256 = await fileSha256(screenshotPath)
      }
    } catch (error) {
      errors.push(serializeBrowserError("probe-error", error))
      throw error
    } finally {
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

      const artifact: BrowserProbeArtifact = {
        requestedUrl: targetUrl,
        url: targetUrl,
        files: {
          ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
          ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
          ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
          ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
          ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
          summary: "files/browser/summary.json",
        },
        summary: {
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

  private async runBrowserActions(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const actions = browserActionsFromArgs(args)
    const initialUrl = argValue(args, "url")?.trim()
    if (actions.length === 0 && !initialUrl) {
      throw new Error("wordpress.browser-actions requires actions-json=<array> or url=<path-or-url>")
    }

    if (initialUrl && actions[0]?.type !== "navigate") {
      actions.unshift({ type: "navigate", url: initialUrl })
    }

    const capture = new Set(commaListArg(args, "capture"))
    if (capture.size === 0) {
      capture.add("actions")
      capture.add("console")
      capture.add("errors")
      capture.add("network")
      capture.add("html")
      capture.add("screenshot")
    }

    for (const item of capture) {
      if (!["actions", "console", "errors", "html", "network", "screenshot"].includes(item)) {
        throw new Error(`wordpress.browser-actions capture supports actions, console, errors, html, network, screenshot: ${item}`)
      }
    }

    const browserDirectory = join(this.artifactRoot, "files", "browser")
    await mkdir(browserDirectory, { recursive: true })

    const actionRecords: BrowserActionRecord[] = []
    const consoleMessages: Record<string, unknown>[] = []
    const errors: BrowserProbeErrorRecord[] = []
    const network: BrowserProbeNetworkRecord[] = []
    const actionsPath = join(browserDirectory, "actions.jsonl")
    const consolePath = join(browserDirectory, "console.jsonl")
    const errorsPath = join(browserDirectory, "errors.jsonl")
    const htmlPath = join(browserDirectory, "snapshot.html")
    const networkPath = join(browserDirectory, "network.jsonl")
    const screenshotPath = join(browserDirectory, "screenshot.png")
    const summaryPath = join(browserDirectory, "action-summary.json")
    const startedAt = now()
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
        page.on("response", (response) => network.push(serializeBrowserResponse(response)))
        page.on("requestfailed", (request) => network.push(serializeBrowserRequestFailure(request)))
      }

      for (const [index, action] of actions.entries()) {
        const recordStartedAt = now()
        try {
          await executeBrowserAction(page, action, server.serverUrl)
          finalUrl = page.url()
          if (action.type === "navigate") {
            requestedUrl = resolveBrowserActionUrl(action, server.serverUrl)
          }
          actionRecords.push(browserActionRecord(index, action, "ok", recordStartedAt, finalUrl))
        } catch (error) {
          const serialized = serializeBrowserError("probe-error", error)
          errors.push(serialized)
          actionRecords.push(browserActionRecord(index, action, "failed", recordStartedAt, page.url(), serialized))
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
      await browser.close()
      if (capture.has("actions")) {
        await writeFile(actionsPath, jsonLines(actionRecords))
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

      const artifact: BrowserProbeArtifact = {
        requestedUrl,
        url: requestedUrl,
        files: {
          ...(capture.has("actions") ? { actions: "files/browser/actions.jsonl" } : {}),
          ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
          ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
          ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
          ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
          ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
          summary: "files/browser/action-summary.json",
        },
        summary: {
          actions: actionRecords.length,
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
        actions: actionRecords,
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
      throw new Error(`wordpress.browser-actions failed after ${actionRecords.length} action(s): ${pendingError.message}`)
    }

    return `${JSON.stringify({
      command: "wordpress.browser-actions",
      requestedUrl,
      finalUrl: this.browserProbes.at(-1)?.summary.finalUrl ?? finalUrl,
      files: this.browserProbes.at(-1)?.files,
      summary: this.browserProbes.at(-1)?.summary,
      actions: actionRecords,
    }, null, 2)}\n`
  }

  private async runPhp(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const code = await this.phpCodeFromArgs(spec.args ?? [])
    const bridge = argValue(spec.args ?? [], "wp-cli-bridge") === "1" ? await this.createRuntimeWpCliBridge(server) : undefined
    let response: PlaygroundRunResponse
    try {
      response = await this.runPlaygroundCommand("wordpress.run-php", server, { code: this.bootstrapPhpCode(code, spec.args ?? [], bridge) })
      assertPlaygroundResponseOk("wordpress.run-php", response)
    } finally {
      if (bridge) {
        await bridge.close()
      }
    }

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
    const response = await this.runPlaygroundCommand("wordpress.wp-cli", server, { scriptPath })
    assertPlaygroundResponseOk("wordpress.wp-cli", response)

    return cleanWpCliOutput(response.text)
  }

  private async runPluginCheck(spec: ExecutionSpec): Promise<string> {
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

  private async runThemeCheck(spec: ExecutionSpec): Promise<string> {
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

    const response = await this.runPlaygroundCommand("wordpress.theme-check", server, { code: this.bootstrapPhpCode(themeCheckRunCode(theme), []) })
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

  private async runRuntimeWpCliBridgeCommand(server: PlaygroundCliServer, command: string): Promise<RuntimeWpCliCommandResult> {
    const commands = runtimeWpCliCommandArgv(command)
    if (commands.length === 0) {
      throw new Error("wp_cli command is required")
    }

    let stdout = ""
    let stderr = ""
    let exitCode = 0
    for (const argv of commands) {
      const result = await this.runWpCliCommand(server, argv)
      exitCode = result.exitCode ?? 0
      stdout += cleanWpCliOutput(result.text)
      stderr += result.errors ?? ""
      if (exitCode !== 0) {
        break
      }
    }

    return { exitCode, stdout, stderr }
  }

  private async createRuntimeWpCliBridge(server: PlaygroundCliServer): Promise<RuntimeWpCliBridge> {
    const token = randomBytes(24).toString("base64url")
    const bridge = createHttpServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/execute") {
          writeBridgeJson(response, 404, { success: false, error: "not_found" })
          return
        }

        if (request.headers.authorization !== `Bearer ${token}`) {
          writeBridgeJson(response, 403, { success: false, error: "forbidden" })
          return
        }

        const action = await readBridgeJson(request)
        const type = typeof action.type === "string" ? action.type.trim() : ""
        const command = typeof action.command === "string" ? action.command.trim() : ""
        if (type !== "wp_cli" || command === "") {
          writeBridgeJson(response, 400, { success: false, error: "wp_cli command is required" })
          return
        }

        const started = Date.now()
        const result = await this.runRuntimeWpCliBridgeCommand(server, command)
        const exitCode = result.exitCode
        writeBridgeJson(response, 200, {
          type,
          command: command.startsWith("wp ") ? command : `wp ${command}`,
          exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          success: exitCode === 0,
          timedOut: false,
          durationMs: Date.now() - started,
          error: exitCode === 0 ? "" : (result.stderr.trim() || result.stdout.trim() || "WP-CLI command failed"),
        })
      } catch (error) {
        writeBridgeJson(response, 500, { success: false, error: errorMessage(error) })
      }
    })

    const url = await listenLocalHttpServer(bridge)
    return {
      url,
      token,
      close: () => closeHttpServer(bridge),
    }
  }

  private async runAbility(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const name = argValue(spec.args ?? [], "name")?.trim()
    if (!name) {
      throw new Error("wordpress.ability requires name=<ability-name>")
    }

    const input = abilityInputFromArgs(spec.args ?? [])
    const response = await this.runPlaygroundCommand("wordpress.ability", server, { code: this.bootstrapAbilityPhpCode(abilityPhpCode(name, input)) })
    assertPlaygroundResponseOk("wordpress.ability", response)
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
    const warmupIterations = nonNegativeIntegerArg(args, "warmup", 1)
    const dependencySlugs = commaListArg(args, "dependency-slugs")
    const env = jsonObjectArg(args, "env-json")
    const workloads = jsonArrayArg(args, "workloads-json")
    const response = await this.runPlaygroundCommand("wordpress.bench", server, {
      code: this.bootstrapPhpCode(benchRunCode({ componentId, pluginSlug, iterations, warmupIterations, dependencySlugs, env, workloads }), []),
    })
    assertPlaygroundResponseOk("wordpress.bench", response)

    return response.text
  }

  private async runPhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const explicitCode = argValue(args, "code") || argValue(args, "code-file")
    const pluginSlug = argValue(args, "plugin-slug")?.trim() || ""
    const code = explicitCode ? await this.phpCodeFromArgs(args, "wordpress.phpunit") : normalizePhpCode(phpunitRunCode({
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
    await this.persistVfsDiagnosticFile(server, `/wordpress/wp-content/plugins/${pluginSlug}/.pg-test-result.txt`)
    assertPlaygroundResponseOk("wordpress.phpunit", response)

    return response.text
  }

  private async runCorePhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const explicitCode = argValue(args, "code") || argValue(args, "code-file")
    const code = explicitCode ? await this.phpCodeFromArgs(args, "wordpress.core-phpunit") : normalizePhpCode(corePhpunitRunCode({
      coreRoot: argValue(args, "core-root")?.trim() || "/wordpress",
      testsDir: argValue(args, "tests-dir")?.trim() || "/wordpress/tests/phpunit",
      phpunitXml: argValue(args, "phpunit-xml")?.trim() || "/wordpress/tests/phpunit/phpunit.xml.dist",
      selectedTestFile: argValue(args, "test-file")?.trim() || "",
      changedTestFiles: jsonArrayArg(args, "changed-tests-json"),
      autoloadFile: argValue(args, "autoload-file")?.trim() || "/wordpress/vendor/autoload.php",
      wpConfigDefines: jsonObjectArg(args, "wp-config-defines-json"),
      multisite: booleanArg(args, "multisite"),
    }))
    const response = await this.runPlaygroundCommand("wordpress.core-phpunit", server, { code })
    await this.persistVfsDiagnosticFile(server, `${argValue(args, "core-root")?.trim() || "/wordpress"}/.pg-test-result.txt`)
    assertPlaygroundResponseOk("wordpress.core-phpunit", response)

    return response.text
  }

  private async persistVfsDiagnosticFile(server: PlaygroundCliServer, vfsPath: string): Promise<void> {
    if (!server.playground.readFileAsText) {
      return
    }

    const hostPath = this.hostPathForVfsPath(vfsPath)
    if (!hostPath) {
      return
    }

    try {
      const contents = await server.playground.readFileAsText(vfsPath)
      await mkdir(dirname(hostPath), { recursive: true })
      await writeFile(hostPath, contents)
    } catch {
      // The structured result is best-effort; preserve the command failure if copying fails.
    }
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

  private hostPathForVfsPath(vfsPath: string): string | undefined {
    for (const mount of this.mounts) {
      if (mount.mode !== "readwrite") {
        continue
      }

      const target = mount.target.replace(/\/+$/, "")
      if (vfsPath !== target && !vfsPath.startsWith(`${target}/`)) {
        continue
      }

      const relativePath = vfsPath === target ? "" : vfsPath.slice(target.length + 1)
      if (relativePath.split("/").includes("..")) {
        continue
      }

      return join(mount.source, relativePath)
    }

    return undefined
  }

  private async runPlaygroundCommand(command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }): Promise<PlaygroundRunResponse> {
    try {
      return await server.playground.run(options)
    } catch (error) {
      throw new PlaygroundCommandCrashError(command, error)
    }
  }

  private bootstrapAbilityPhpCode(code: string): string {
    return `<?php
define( 'REST_REQUEST', true );
$_SERVER['REQUEST_URI'] = '/wp-json/wp-codebox/ability';
require_once '/wordpress/wp-load.php';
${this.secretEnvPhp()}
${phpBody(code)}`
  }

  private bootstrapPhpCode(code: string, args: string[], wpCliBridge?: RuntimeWpCliBridge): string {
    if (argValue(args, "bootstrap") === "none") {
      return code
    }

    return `<?php
require_once '/wordpress/wp-load.php';
${this.secretEnvPhp()}
${wpCliBridge ? `putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_URL=${wpCliBridge.url}`)});
putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_TOKEN=${wpCliBridge.token}`)});
` : ""}
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

  private async phpCodeFromArgs(args: string[], command = "wordpress.run-php"): Promise<string> {
    const inlineCode = argValue(args, "code")
    if (inlineCode) {
      return normalizePhpCode(inlineCode)
    }

    const codeFile = argValue(args, "code-file")
    if (codeFile) {
      return normalizePhpCode(await readFile(resolve(codeFile), "utf8"))
    }

    throw new Error(`${command} requires code=<php> or code-file=<path>`)
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
    if (this.spec.preview?.port) {
      await assertPreviewPortAvailable(this.spec.preview.port)
    }

    try {
      const server = await runPlaygroundCliWithoutProcessExit(() => runCLI({
        command: "server",
        port: 0,
        quiet: true,
        skipBrowser: true,
        mount: this.mounts.map((mount) => ({
          hostPath: mount.source,
          vfsPath: mount.target,
        })),
        wp: this.spec.environment.version,
        "site-url": this.spec.preview?.siteUrl,
        blueprint: playgroundBlueprint(this.spec.environment.blueprint, this.spec.policy, this.spec.preview?.siteUrl),
      }))

      if (!this.spec.preview?.port) {
        return server
      }

      return await withPreviewProxy(server, this.spec.preview.port, this.spec.preview.bind)
    } catch (error) {
      if (this.spec.preview?.port && errorHasCode(error, "EADDRINUSE")) {
        throw new PlaygroundPreviewPortUnavailableError(this.spec.preview.port, error)
      }

      throw error
    }
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
      return { data: await this.observeWordPressState(), artifactRefs }
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

  private async observeWordPressState(): Promise<unknown> {
    const cliServer = await this.bootPlayground()
    const response = await cliServer.playground.run({ code: this.bootstrapPhpCode(`
$post_counts = array();
foreach ( get_post_types( array(), 'names' ) as $post_type ) {
    $counts = wp_count_posts( $post_type );
    $post_counts[ $post_type ] = array();
    foreach ( get_object_vars( $counts ) as $status => $count ) {
        $post_counts[ $post_type ][ $status ] = (int) $count;
    }
}

echo wp_json_encode( array(
    'siteUrl' => get_site_url(),
    'homeUrl' => get_home_url(),
    'wordpressVersion' => get_bloginfo( 'version' ),
    'activeTheme' => wp_get_theme()->get_stylesheet(),
    'activePlugins' => array_values( (array) get_option( 'active_plugins', array() ) ),
    'postCounts' => $post_counts,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
`, []) })
    assertPlaygroundResponseOk("observe.wordpress-state", response)
    return JSON.parse(response.text || "{}")
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

  private browserReviewSummary(): ArtifactReviewBrowserSummary | undefined {
    if (this.browserProbes.length === 0) {
      return undefined
    }

    const consoleMessages = this.browserProbes.reduce((total, probe) => total + probe.summary.consoleMessages, 0)
    const errors = this.browserProbes.reduce((total, probe) => total + probe.summary.errors, 0)
    const screenshots = this.browserProbes.filter((probe) => probe.summary.screenshot).length
    const actions = this.browserProbes.reduce((total, probe) => total + (probe.summary.actions ?? 0), 0)
    return {
      summary: `Browser evidence captured ${actions} action${actions === 1 ? "" : "s"}, ${consoleMessages} console message${consoleMessages === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}, and ${screenshots} screenshot${screenshots === 1 ? "" : "s"}.`,
      probes: this.browserProbes.map((probe) => ({
        url: probe.url,
        requestedUrl: probe.requestedUrl,
        finalUrl: probe.summary.finalUrl,
        viewport: probe.summary.viewport,
        replayability: probe.summary.replayability,
        consoleMessages: probe.summary.consoleMessages,
        errors: probe.summary.errors,
        html: probe.files.html,
        network: probe.files.network,
        networkEvents: probe.summary.networkEvents,
        screenshot: probe.files.screenshot,
        console: probe.files.console,
        errorsFile: probe.files.errors,
        actions: probe.files.actions,
        actionCount: probe.summary.actions,
        summaryFile: probe.files.summary,
      })),
    }
  }

  private browserManifestFiles(): ArtifactManifestFile[] {
    if (this.browserProbes.length === 0) {
      return []
    }

    const files = new Map<string, { kind: string; contentType: string }>()
    for (const probe of this.browserProbes) {
      if (probe.files.actions) {
        files.set(probe.files.actions, { kind: "browser-actions", contentType: "application/x-ndjson" })
      }
      if (probe.files.console) {
        files.set(probe.files.console, { kind: "browser-console", contentType: "application/x-ndjson" })
      }
      if (probe.files.errors) {
        files.set(probe.files.errors, { kind: "browser-errors", contentType: "application/x-ndjson" })
      }
      if (probe.files.html) {
        files.set(probe.files.html, { kind: "browser-html-snapshot", contentType: "text/html; charset=utf-8" })
      }
      if (probe.files.network) {
        files.set(probe.files.network, { kind: "browser-network", contentType: "application/x-ndjson" })
      }
      if (probe.files.screenshot) {
        files.set(probe.files.screenshot, { kind: "browser-screenshot", contentType: "image/png" })
      }
      files.set(probe.files.summary, { kind: "browser-summary", contentType: "application/json" })
    }

    return [...files.entries()].map(([path, entry]) => fileEntry(join(this.artifactRoot, path), entry.kind, entry.contentType))
  }

  private observationManifestFiles(): ArtifactManifestFile[] {
    return this.observations.flatMap((observation) =>
      (observation.artifactRefs ?? [])
        .filter((ref): ref is RuntimeEpisodeTraceRef & { path: string } => typeof ref.path === "string" && ref.path.length > 0)
        .map((ref) => fileEntry(join(this.artifactRoot, ref.path), "observation-artifact", "text/plain")),
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
      for (const path of [probe.files.actions, probe.files.console, probe.files.errors, probe.files.html, probe.files.network, probe.files.summary]) {
        if (!path) {
          continue
        }

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

async function navigateBrowserProbe(page: Page, url: string, waitFor: string, durationMs: number): Promise<void> {
  if (["domcontentloaded", "load", "networkidle"].includes(waitFor)) {
    await page.goto(url, { waitUntil: waitFor as "domcontentloaded" | "load" | "networkidle", timeout: 30_000 })
    return
  }

  if (waitFor.startsWith("selector:")) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    const selector = waitFor.slice("selector:".length).trim()
    if (!selector) {
      throw new Error("wordpress.browser-probe wait-for=selector:<selector> requires a selector")
    }
    await page.locator(selector).first().waitFor({ timeout: 30_000 })
    return
  }

  if (waitFor === "duration") {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForTimeout(durationMs > 0 ? durationMs : 1000)
    return
  }

  throw new Error(`wordpress.browser-probe wait-for supports domcontentloaded, load, networkidle, selector:<selector>, duration: ${waitFor}`)
}

type BrowserActionInput = Record<string, unknown> & { type: string }

function browserActionsFromArgs(args: string[]): BrowserActionInput[] {
  return jsonArrayArg(args, "actions-json").map((action, index) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`wordpress.browser-actions actions-json[${index}] must be an object`)
    }
    const typedAction = action as BrowserActionInput
    if (typeof typedAction.type !== "string" || typedAction.type.length === 0) {
      throw new Error(`wordpress.browser-actions actions-json[${index}].type is required`)
    }
    return typedAction
  })
}

async function executeBrowserAction(page: Page, action: BrowserActionInput, baseUrl: string): Promise<void> {
  if (action.type === "navigate") {
    await page.goto(resolveBrowserActionUrl(action, baseUrl), { waitUntil: browserActionLoadState(action.waitFor) })
    return
  }

  if (action.type === "click") {
    if (typeof action.selector === "string" && action.selector.length > 0) {
      await page.click(action.selector)
      return
    }
    if (typeof action.text === "string" && action.text.length > 0) {
      await page.getByText(action.text).click()
      return
    }
    throw new Error("wordpress.browser-actions click requires selector or text")
  }

  if (action.type === "fill") {
    if (typeof action.selector !== "string" || action.selector.length === 0) {
      throw new Error("wordpress.browser-actions fill requires selector")
    }
    if (typeof action.value !== "string") {
      throw new Error("wordpress.browser-actions fill requires value")
    }
    await page.fill(action.selector, action.value)
    return
  }

  if (action.type === "press") {
    if (typeof action.key !== "string" || action.key.length === 0) {
      throw new Error("wordpress.browser-actions press requires key")
    }
    if (typeof action.selector === "string" && action.selector.length > 0) {
      await page.press(action.selector, action.key)
      return
    }
    await page.keyboard.press(action.key)
    return
  }

  if (action.type === "wait") {
    await waitForBrowserAction(page, action)
    return
  }

  if (action.type === "capture") {
    return
  }

  throw new Error(`wordpress.browser-actions action type is not supported: ${action.type}`)
}

function resolveBrowserActionUrl(action: BrowserActionInput, baseUrl: string): string {
  if (typeof action.url !== "string" || action.url.trim().length === 0) {
    throw new Error("wordpress.browser-actions navigate requires url")
  }
  return resolveBrowserProbeUrl(action.url.trim(), baseUrl)
}

function browserActionLoadState(waitFor: unknown): "domcontentloaded" | "load" | "networkidle" {
  if (waitFor === undefined || waitFor === null || waitFor === "") {
    return "domcontentloaded"
  }
  if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    return waitFor
  }
  throw new Error(`wordpress.browser-actions navigate waitFor supports domcontentloaded, load, networkidle: ${waitFor}`)
}

async function waitForBrowserAction(page: Page, action: BrowserActionInput): Promise<void> {
  if (typeof action.selector === "string" && action.selector.length > 0) {
    await page.waitForSelector(action.selector)
    return
  }

  const waitFor = typeof action.waitFor === "string" ? action.waitFor : "load"
  if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    await page.waitForLoadState(waitFor)
    return
  }
  if (waitFor === "duration") {
    await page.waitForTimeout(browserActionDurationMs(action))
    return
  }

  throw new Error(`wordpress.browser-actions wait supports selector, domcontentloaded, load, networkidle, duration: ${waitFor}`)
}

function browserActionDurationMs(action: BrowserActionInput): number {
  const raw = typeof action.duration === "string" ? action.duration : "0ms"
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) {
    throw new Error("wordpress.browser-actions duration must be a duration like 500ms or 2s")
  }
  const value = Number.parseFloat(match[1])
  return Math.max(0, Math.round(match[2] === "ms" ? value : value * 1000))
}

function browserActionRecord(
  index: number,
  action: BrowserActionInput,
  status: BrowserActionRecord["status"],
  startedAt: string,
  finalUrl: string,
  error?: BrowserProbeErrorRecord,
): BrowserActionRecord {
  return {
    index,
    type: action.type,
    status,
    startedAt,
    finishedAt: now(),
    ...(typeof action.url === "string" ? { url: action.url } : {}),
    ...(typeof action.selector === "string" ? { selector: action.selector } : {}),
    ...(typeof action.text === "string" ? { text: action.text } : {}),
    ...(typeof action.key === "string" ? { key: action.key } : {}),
    ...(typeof action.waitFor === "string" ? { waitFor: action.waitFor } : {}),
    ...(typeof action.duration === "string" ? { duration: action.duration } : {}),
    finalUrl,
    ...(error ? { error } : {}),
  }
}

function resolveBrowserProbeUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return new URL(pathOrUrl).toString()
  } catch {
    return new URL(pathOrUrl, baseUrl).toString()
  }
}

async function browserProbeViewport(page: Page): Promise<BrowserProbeViewport> {
  const viewport = page.viewportSize()
  const device = await page.evaluate(() => ({
    deviceScaleFactor: window.devicePixelRatio,
    hasTouch: navigator.maxTouchPoints > 0,
    userAgent: navigator.userAgent,
  }))

  return {
    width: viewport?.width ?? 0,
    height: viewport?.height ?? 0,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: /Mobile|Android|iPhone|iPad/i.test(device.userAgent),
    hasTouch: device.hasTouch,
    userAgent: device.userAgent,
  }
}

function browserProbeReplayability(capture: Set<string>): BrowserProbeReplayability {
  if (capture.has("html") && capture.has("screenshot")) {
    return "artifact-backed"
  }

  if (capture.has("html") || capture.has("screenshot") || capture.has("network")) {
    return "partial"
  }

  return "diagnostic-only"
}

function serializeBrowserResponse(response: Response): BrowserProbeNetworkRecord {
  const request = response.request()
  return {
    type: "response",
    url: response.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    statusText: response.statusText(),
    ok: response.ok(),
    contentType: response.headers()["content-type"] ?? null,
    timestamp: now(),
  }
}

function serializeBrowserRequestFailure(request: Request): BrowserProbeNetworkRecord {
  return {
    type: "requestfailed",
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    failure: request.failure(),
    timestamp: now(),
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

function serializeBrowserConsoleMessage(message: ConsoleMessage): Record<string, unknown> {
  return {
    type: message.type(),
    text: message.text(),
    location: message.location(),
    timestamp: now(),
  }
}

function serializeBrowserError(type: BrowserProbeErrorRecord["type"], error: unknown): BrowserProbeErrorRecord {
  if (error instanceof Error) {
    return { type, name: error.name, message: error.message, stack: error.stack, timestamp: now() }
  }

  return { type, name: "Error", message: String(error), timestamp: now() }
}

function jsonLines(records: unknown[]): string {
  return records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : ""
}

async function withPreviewProxy(server: PlaygroundCliServer, port: number, bind = "127.0.0.1"): Promise<PlaygroundCliServer> {
  let proxy: PlaygroundPreviewProxy | undefined
  try {
    proxy = await startPreviewProxy(server.serverUrl, port, bind)
  } catch (error) {
    await server[Symbol.asyncDispose]()
    throw error
  }

  return {
    ...server,
    serverUrl: proxy.serverUrl,
    async [Symbol.asyncDispose]() {
      await proxy.dispose()
      await server[Symbol.asyncDispose]()
    },
  }
}

async function startPreviewProxy(targetUrl: string, port: number, bind: string): Promise<PlaygroundPreviewProxy> {
  const target = new URL(targetUrl)
  const proxy = createHttpServer((incoming, outgoing) => {
    const targetRequest = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url ?? "/",
        headers: proxyRequestHeaders(incoming.headers, target),
      },
      (targetResponse) => {
        outgoing.writeHead(targetResponse.statusCode ?? 502, targetResponse.statusMessage, proxyResponseHeaders(targetResponse.headers))
        targetResponse.on("error", (error) => outgoing.destroy(error))
        targetResponse.pipe(outgoing)
      },
    )

    targetRequest.on("error", (error) => writeProxyError(outgoing, error))
    incoming.on("error", () => targetRequest.destroy())
    incoming.pipe(targetRequest)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    proxy.once("error", rejectListen)
    proxy.listen(port, bind, () => resolveListen())
  })

  const address = proxy.address()
  const resolvedPort = address && typeof address === "object" ? address.port : port
  const reportedHost = bind === "0.0.0.0" ? "127.0.0.1" : bind

  return {
    serverUrl: `http://${formatPreviewHost(reportedHost)}:${resolvedPort}`,
    async dispose() {
      if (!proxy.listening) {
        return
      }

      await new Promise<void>((resolveClose, rejectClose) => {
        proxy.close((error) => error ? rejectClose(error) : resolveClose())
      })
    },
  }
}

function formatPreviewHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

function proxyRequestHeaders(headers: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded.connection
  delete forwarded.host
  delete forwarded["transfer-encoding"]

  return {
    ...forwarded,
    host: target.host,
  }
}

function proxyResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers }
  delete forwarded.connection
  delete forwarded["transfer-encoding"]

  return forwarded
}

function writeProxyError(outgoing: ServerResponse, error: Error): void {
  if (outgoing.headersSent) {
    outgoing.destroy(error)
    return
  }

  const body = Buffer.from(`Preview proxy failed: ${error.message}\n`, "utf8")
  outgoing.writeHead(502, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.byteLength),
  })
  outgoing.end(body)
}

function errorHasCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  if ("code" in error && error.code === code) {
    return true
  }

  if ("cause" in error && errorHasCode(error.cause, code)) {
    return true
  }

  return error instanceof Error && error.message.includes(code)
}

async function assertPreviewPortAvailable(port: number): Promise<void> {
  const server = createNetServer()
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(port, "127.0.0.1", () => resolveListen())
    })
  } catch (error) {
    if (errorHasCode(error, "EADDRINUSE")) {
      throw new PlaygroundPreviewPortUnavailableError(port, error)
    }

    throw error
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  }
}

function readBridgeJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk.toString()
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"))
        request.destroy()
      }
    })
    request.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {}
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

function writeBridgeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" })
  response.end(`${JSON.stringify(payload)}\n`)
}

function listenLocalHttpServer(server: ReturnType<typeof createHttpServer>): Promise<string> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen)
      const address = server.address()
      if (!address || typeof address === "string") {
        rejectListen(new Error("Runtime WP-CLI bridge did not expose a TCP address"))
        return
      }
      resolveListen(`http://${address.address}:${address.port}`)
    })
  })
}

function closeHttpServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}
