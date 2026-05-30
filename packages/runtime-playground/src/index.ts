import { createHash, randomBytes } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { basename, dirname, join, relative, resolve } from "node:path"
import { RUNTIME_EPISODE_OBSERVATION_SCHEMA, RUNTIME_EPISODE_SNAPSHOT_SCHEMA, assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, runtimeEpisodeDigest, validateBrowserInteractionScript, type BrowserInteractionStep } from "@chubes4/wp-codebox-core"
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
import { executePlaygroundCommand, playgroundRuntimeCommandIds } from "./command-router.js"
export { playgroundRuntimeCommandIds } from "./command-router.js"
import { abilityInputFromArgs, abilityPhpCode, argValue, benchRunCode, booleanArg, cleanWpCliOutput, commaListArg, CORE_PHPUNIT_RESULT_FILE, corePhpunitRunCode, isSafeEnvName, jsonArrayArg, jsonObjectArg, nonNegativeIntegerArg, normalizePhpCode, normalizePluginCheckOutput, normalizeThemeCheckOutput, phpBody, phpunitRunCode, positiveIntegerArg, shellArgv, themeCheckRunCode, wpCliCommandFromArgs, wpCliPhpScript } from "./commands.js"
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
  RuntimeRestoreSpec,
  RuntimeEpisodeTraceRef,
  RuntimeInfo,
  Snapshot,
} from "@chubes4/wp-codebox-core"
import type { ConsoleMessage, Page, Request, Response } from "playwright"

const BROWSER_PROBE_CAPTURE_VALUES = ["console", "errors", "html", "network", "performance", "memory", "screenshot"] as const
const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000
const BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT = `
(() => {
  const state = globalThis.__wpCodeboxBrowserProbe = globalThis.__wpCodeboxBrowserProbe || { checkpoints: [], longTasks: [] };
  state.checkpoints = state.checkpoints || [];
  globalThis.__wpCodeboxProbeCheckpoint = (name, metadata = {}) => {
    state.checkpoints.push({
      name: String(name || ''),
      metadata,
      timestamp: new Date().toISOString(),
    });
  };
  if (state.longTaskObserverInstalled || typeof PerformanceObserver === 'undefined') {
    return;
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    state.longTaskObserverInstalled = true;
  } catch {
    state.longTaskObserverInstalled = false;
  }
})();
`

function now(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface RuntimeSnapshotArtifact {
  schema: "wp-codebox/wordpress-runtime-snapshot/v1"
  version: 1
  id: string
  createdAt: string
  compatibility: {
    backend: "wordpress-playground"
    wordpressVersion: string
    phpVersion: string
  }
  metadata: {
    runtime: RuntimeInfo
    mounts: MountSpec[]
    mountedInputs: Array<Record<string, unknown>>
    activeTheme: string
    activePlugins: string[]
    wpContentPath: string
  }
  database: {
    tables: Array<{
      name: string
      createSql: string
      rows: Array<Record<string, unknown>>
      rowCount: number
    }>
  }
  files: Array<{
    scope: "wp-content"
    path: string
    bytes: number
    sha256: string
    base64: string
  }>
  hashes: {
    database: { algorithm: "sha256"; value: string }
    files: { algorithm: "sha256"; value: string }
  }
}

class PlaygroundSnapshotRestoreError extends Error {
  readonly code = "wp-codebox-playground-snapshot-restore-failed"

  constructor(message: string) {
    super(message)
    this.name = "PlaygroundSnapshotRestoreError"
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

function contentDigest(value: unknown): { algorithm: "sha256"; value: string } {
  return { algorithm: "sha256", value: createHash("sha256").update(stableJson(value)).digest("hex") }
}

function snapshotDigest(snapshot: Snapshot): { algorithm: "sha256"; value: string } {
  return runtimeEpisodeDigest({
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    semantics: snapshot.semantics,
    metadata: snapshot.metadata,
    artifactRefs: snapshot.artifactRefs ?? [],
  })
}

function runtimeSpecFromSnapshot(snapshot: Snapshot): RuntimeCreateSpec {
  const runtime = snapshot.metadata.runtime
  if (!isRuntimeInfo(runtime)) {
    throw new PlaygroundSnapshotRestoreError("Snapshot metadata does not include a compatible runtime description.")
  }

  return {
    backend: "wordpress-playground",
    environment: runtime.environment,
    policy: { network: "deny", filesystem: "readwrite-mounts", commands: [...playgroundRuntimeCommandIds()], secrets: "none", approvals: "never" },
  }
}

function mountsFromSnapshot(snapshot: Snapshot): MountSpec[] {
  return Array.isArray(snapshot.metadata.mounts) ? snapshot.metadata.mounts.filter(isMountSpec) : []
}

async function runtimeSnapshotPayload(snapshot: Snapshot): Promise<RuntimeSnapshotArtifact> {
  if (snapshot.schema && snapshot.schema !== RUNTIME_EPISODE_SNAPSHOT_SCHEMA) {
    throw new PlaygroundSnapshotRestoreError(`Unsupported snapshot schema: ${snapshot.schema}`)
  }

  if (snapshot.semantics !== "runtime-state-artifact") {
    throw new PlaygroundSnapshotRestoreError(`Snapshot is not a runtime-state artifact: ${snapshot.semantics ?? "metadata-only"}`)
  }

  const embedded = snapshot.metadata.payload
  if (isRuntimeSnapshotArtifact(embedded)) {
    return embedded
  }

  const artifact = snapshot.metadata.artifact
  if (isRecord(artifact) && typeof artifact.absolutePath === "string") {
    const payload = JSON.parse(await readFile(artifact.absolutePath, "utf8"))
    if (isRuntimeSnapshotArtifact(payload)) {
      return payload
    }
  }

  throw new PlaygroundSnapshotRestoreError("Snapshot does not include a readable runtime snapshot artifact payload.")
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  return isRecord(value)
    && value.backend === "wordpress-playground"
    && isRecord(value.environment)
}

function isMountSpec(value: unknown): value is MountSpec {
  return isRecord(value)
    && typeof value.source === "string"
    && typeof value.target === "string"
    && (value.mode === "readonly" || value.mode === "readwrite")
}

function isRuntimeSnapshotArtifact(value: unknown): value is RuntimeSnapshotArtifact {
  return isRecord(value)
    && value.schema === "wp-codebox/wordpress-runtime-snapshot/v1"
    && value.version === 1
    && isRecord(value.compatibility)
    && value.compatibility.backend === "wordpress-playground"
    && isRecord(value.database)
    && Array.isArray(value.database.tables)
    && Array.isArray(value.files)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function runtimeSnapshotExportPhp(): string {
  return String.raw`
global $wpdb;

function wp_codebox_snapshot_hash_file_contents( string $contents ): string {
    return hash( 'sha256', $contents );
}

function wp_codebox_snapshot_relative_path( string $base, string $path ): string {
    $base = rtrim( str_replace( '\\', '/', realpath( $base ) ?: $base ), '/' ) . '/';
    $path = str_replace( '\\', '/', $path );
    return ltrim( substr( $path, strlen( $base ) ), '/' );
}

function wp_codebox_snapshot_files( string $root ): array {
    if ( ! is_dir( $root ) ) {
        return array();
    }

    $files = array();
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ),
        RecursiveIteratorIterator::LEAVES_ONLY
    );

    foreach ( $iterator as $file ) {
        if ( ! $file->isFile() ) {
            continue;
        }

        $path = $file->getPathname();
        $contents = file_get_contents( $path );
        if ( false === $contents ) {
            continue;
        }

        $files[] = array(
            'scope' => 'wp-content',
            'path' => wp_codebox_snapshot_relative_path( $root, $path ),
            'bytes' => strlen( $contents ),
            'sha256' => wp_codebox_snapshot_hash_file_contents( $contents ),
            'base64' => base64_encode( $contents ),
        );
    }

    usort( $files, fn( $left, $right ) => strcmp( $left['path'], $right['path'] ) );
    return $files;
}

$tables = array();
foreach ( $wpdb->get_col( 'SHOW TABLES' ) as $table_name ) {
    $quoted_table = chr( 96 ) . str_replace( chr( 96 ), chr( 96 ) . chr( 96 ), $table_name ) . chr( 96 );
    $create_row = $wpdb->get_row( 'SHOW CREATE TABLE ' . $quoted_table, ARRAY_N );
    $rows = $wpdb->get_results( 'SELECT * FROM ' . $quoted_table, ARRAY_A );
    $tables[] = array(
        'name' => $table_name,
        'createSql' => $create_row[1] ?? '',
        'rows' => $rows ?: array(),
        'rowCount' => count( $rows ?: array() ),
    );
}

usort( $tables, fn( $left, $right ) => strcmp( $left['name'], $right['name'] ) );

echo wp_json_encode( array(
    'compatibility' => array(
        'backend' => 'wordpress-playground',
        'wordpressVersion' => get_bloginfo( 'version' ),
        'phpVersion' => PHP_VERSION,
    ),
    'metadata' => array(
        'runtime' => null,
        'mounts' => array(),
        'mountedInputs' => array(),
        'activeTheme' => wp_get_theme()->get_stylesheet(),
        'activePlugins' => array_values( (array) get_option( 'active_plugins', array() ) ),
        'wpContentPath' => WP_CONTENT_DIR,
    ),
    'database' => array( 'tables' => $tables ),
    'files' => wp_codebox_snapshot_files( WP_CONTENT_DIR ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}

function runtimeSnapshotRestorePhp(payload: RuntimeSnapshotArtifact): string {
  return `${String.raw`
$payload = json_decode(<<<'WP_CODEBOX_SNAPSHOT_JSON'
`}${JSON.stringify(payload)}${String.raw`
WP_CODEBOX_SNAPSHOT_JSON
, true );

if ( ! is_array( $payload ) || ( $payload['schema'] ?? '' ) !== 'wp-codebox/wordpress-runtime-snapshot/v1' ) {
    throw new RuntimeException( 'Invalid WordPress runtime snapshot payload.' );
}

global $wpdb;

function wp_codebox_snapshot_delete_tree( string $path ): void {
    if ( ! file_exists( $path ) ) {
        return;
    }

    if ( is_file( $path ) || is_link( $path ) ) {
        unlink( $path );
        return;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ( $iterator as $item ) {
        $item->isDir() ? rmdir( $item->getPathname() ) : unlink( $item->getPathname() );
    }
}

foreach ( $wpdb->get_col( 'SHOW TABLES' ) as $table_name ) {
    $quoted_table = chr( 96 ) . str_replace( chr( 96 ), chr( 96 ) . chr( 96 ), $table_name ) . chr( 96 );
    $wpdb->query( 'DROP TABLE IF EXISTS ' . $quoted_table );
}

foreach ( $payload['database']['tables'] as $table ) {
    if ( ! empty( $table['createSql'] ) ) {
        $wpdb->query( $table['createSql'] );
    }
    foreach ( $table['rows'] as $row ) {
        $wpdb->insert( $table['name'], $row );
    }
}

wp_codebox_snapshot_delete_tree( WP_CONTENT_DIR );
wp_mkdir_p( WP_CONTENT_DIR );

foreach ( $payload['files'] as $file ) {
    if ( ( $file['scope'] ?? '' ) !== 'wp-content' ) {
        continue;
    }
    $relative = ltrim( str_replace( '\\', '/', $file['path'] ), '/' );
    if ( str_contains( $relative, '..' ) ) {
        throw new RuntimeException( 'Snapshot file path is not safe: ' . $relative );
    }
    $target = WP_CONTENT_DIR . '/' . $relative;
    wp_mkdir_p( dirname( $target ) );
    file_put_contents( $target, base64_decode( $file['base64'], true ) );
}

echo wp_json_encode( array(
    'restored' => true,
    'tables' => count( $payload['database']['tables'] ),
    'files' => count( $payload['files'] ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
`}`
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

/**
 * Extract a human-readable failure message from the structured wordpress.core-phpunit
 * diagnostics log (.pg-test-result.txt). The PHP runner emits STAGE_FAIL / STAGE_DIE /
 * STAGE_FATAL markers; when core's bootstrap.php die()s mid-require, the shutdown handler
 * records STAGE_DIE with whatever the bootstrap printed (e.g. the "PHPUnit 0" notice).
 * Returns undefined when the log contains no recognizable failure marker (#314).
 */
function extractCorePhpunitFailureMessage(log: string): string | undefined {
  if (!log.trim()) {
    return undefined
  }

  const lines = log.split("\n")
  const stageFail = lines.find((line) => line.startsWith("STAGE_FAIL:"))
  const stageDie = lines.find((line) => line.startsWith("STAGE_DIE:"))
  const stageFatal = lines.find((line) => line.startsWith("STAGE_FATAL:"))

  const detail = (marker: string | undefined): string | undefined => {
    if (!marker) {
      return undefined
    }
    // Format is MARKER:<stage>:<message...>; drop the marker and stage prefix.
    const withoutMarker = marker.slice(marker.indexOf(":") + 1)
    const withoutStage = withoutMarker.slice(withoutMarker.indexOf(":") + 1)
    return withoutStage.trim() || withoutMarker.trim()
  }

  const messages = [detail(stageFail), detail(stageDie), detail(stageFatal)].filter(
    (value): value is string => Boolean(value),
  )

  if (messages.length === 0) {
    return undefined
  }

  return messages.join(" | ")
}

function phpLiteral(value: string | number | boolean | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (value === null) {
    return "null"
  }
  return String(value)
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
    steps?: string
    checkpoints?: string
    console?: string
    errors?: string
    html?: string
    memory?: string
    network?: string
    performance?: string
    screenshot?: string
    summary: string
  }
  summary: {
    actions?: number
    steps?: number
    assertions?: BrowserAssertionsSummary
    consoleMessages: number
    errors: number
    finalUrl: string
    htmlSnapshot: boolean
    memory?: BrowserProbeMemorySummary
    metrics?: Record<string, number>
    networkEvents: number
    performance?: BrowserProbePerformanceSummary
    replayability: BrowserProbeReplayability
    screenshot: boolean
    scriptResult?: unknown
    viewport: BrowserProbeViewport | null
  }
}

interface BrowserAssertionsSummary {
  total: number
  passed: number
  failed: number
  results: BrowserStepAssertion[]
}

interface BrowserProbeMetricDigest {
  final: number | null
  peak: number | null
}

interface BrowserProbeMemorySummary {
  usedJSHeapSize: BrowserProbeMetricDigest
  totalJSHeapSize: BrowserProbeMetricDigest
  jsHeapSizeLimit: number | null
  domNodes: BrowserProbeMetricDigest
  documents: BrowserProbeMetricDigest
  jsEventListeners: BrowserProbeMetricDigest
}

interface BrowserProbePerformanceSummary {
  resources: number
  transferSizeBytes: number
  encodedBodySizeBytes: number
  decodedBodySizeBytes: number
  longTasks: number
  longTaskDurationMs: number
  domNodes: BrowserProbeMetricDigest
  cdpMetrics: Record<string, BrowserProbeMetricDigest>
}

interface BrowserProbeCheckpointRecord {
  schema: "wp-codebox/browser-checkpoint/v1"
  name: string
  metadata?: unknown
  timestamp: string
  metrics: BrowserProbeMetricsSnapshot
}

interface BrowserProbeMetricsSnapshot {
  timestamp: string
  memory: {
    performanceMemory: {
      usedJSHeapSize: number | null
      totalJSHeapSize: number | null
      jsHeapSizeLimit: number | null
    }
    cdpHeap: {
      usedSize: number | null
      totalSize: number | null
    }
    domCounters: {
      documents: number | null
      nodes: number | null
      jsEventListeners: number | null
    }
  }
  performance: {
    cdpMetrics: Record<string, number>
    dom: {
      nodes: number
      documents: number
      iframes: number
    }
    resources: {
      count: number
      transferSizeBytes: number
      encodedBodySizeBytes: number
      decodedBodySizeBytes: number
    }
    longTasks: {
      count: number
      totalDurationMs: number
      maxDurationMs: number
    }
  }
}

interface BrowserProbeMemoryArtifact {
  schema: "wp-codebox/browser-memory/v1"
  version: 1
  capturedAt: string
  final: BrowserProbeMetricsSnapshot["memory"]
  peak: BrowserProbeMemorySummary
  checkpoints: BrowserProbeCheckpointRecord[]
}

interface BrowserProbePerformanceArtifact {
  schema: "wp-codebox/browser-performance/v1"
  version: 1
  capturedAt: string
  final: BrowserProbeMetricsSnapshot["performance"]
  peak: BrowserProbePerformanceSummary
  checkpoints: BrowserProbeCheckpointRecord[]
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

interface BrowserStepRecord {
  index: number
  kind: string
  status: "ok" | "failed"
  startedAt: string
  finishedAt: string
  durationMs: number
  url?: string
  selector?: string
  text?: string
  key?: string
  waitFor?: string
  duration?: string
  /** Machine-readable assertion outcome for expect/evaluate steps. */
  assertion?: BrowserStepAssertion
  screenshot?: string
  finalUrl?: string
  error?: BrowserProbeErrorRecord
}

interface BrowserStepAssertion {
  kind: "expect" | "evaluate"
  selector?: string
  state?: string
  expression?: string
  expected?: unknown
  actual?: unknown
  passed: boolean
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
  timing?: Record<string, number>
  sizes?: BrowserProbeNetworkSizes
  transferSize?: number
  bodySize?: number
  requestBodySize?: number
  responseBodySize?: number
  failure?: ReturnType<Request["failure"]>
}

interface BrowserProbeNetworkSizes {
  requestBodySize: number
  requestHeadersSize: number
  responseBodySize: number
  responseHeadersSize: number
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
      code: this.bootstrapPhpCode(runtimeSnapshotExportPhp(), []),
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
      code: this.bootstrapPhpCode(runtimeSnapshotRestorePhp(payload), []),
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
    const steps = await this.browserInteractionStepsFromArgs(args)
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

  private async browserInteractionStepsFromArgs(args: string[]): Promise<BrowserInteractionStep[]> {
    const stepsRaw = argValue(args, "steps-json")
    if (typeof stepsRaw === "string" && stepsRaw.trim().length > 0) {
      const parsed = await this.parseBrowserStepsPayload(stepsRaw.trim(), "steps-json")
      const result = validateBrowserInteractionScript(parsed)
      if (!result.valid) {
        throw new Error(`wordpress.browser-actions steps-json is invalid: ${result.issues.map((issue) => `[${issue.index}] ${issue.message}`).join("; ")}`)
      }
      return result.steps
    }

    // Back-compat: accept the legacy actions-json shape and normalize it to steps.
    const legacy = browserActionsFromArgs(args)
    return legacy.map(normalizeLegacyBrowserAction)
  }

  private async parseBrowserStepsPayload(raw: string, name: string): Promise<unknown> {
    let text = raw
    if (raw.startsWith("@")) {
      const path = raw.slice(1)
      text = await readFile(resolve(path), "utf8")
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async runPhp(spec: ExecutionSpec): Promise<string> {
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

  async runAbility(spec: ExecutionSpec): Promise<string> {
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
    const response = await this.runPlaygroundCommand("wordpress.bench", server, {
      code: this.bootstrapPhpCode(benchRunCode({ componentId, pluginSlug, iterations, warmupIterations, dependencySlugs, env, workloads }), []),
    })
    assertPlaygroundResponseOk("wordpress.bench", response)

    return promoteBrowserMetricsToBenchResults(response.text, this.browserProbes)
  }

  async runPhpunit(spec: ExecutionSpec): Promise<string> {
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

  async runCorePhpunit(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const args = spec.args ?? []
    const explicitCode = argValue(args, "code") || argValue(args, "code-file")
    // Write structured diagnostics to a sandbox-internal /tmp path rather than inside
    // the (often read-only) core mount, so the result survives read-only mounts and a
    // mid-require die() in core's bootstrap.php and can be read back from the VFS (#314).
    const resultFile = CORE_PHPUNIT_RESULT_FILE
    const code = explicitCode ? await this.phpCodeFromArgs(args, "wordpress.core-phpunit") : normalizePhpCode(corePhpunitRunCode({
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
      await this.persistCorePhpunitResult(server, resultFile)
      const structured = await this.readCorePhpunitDiagnostic(server, resultFile)
      if (structured) {
        throw new Error(`wordpress.core-phpunit could not run: ${structured}`)
      }
      throw error
    }

    await this.persistCorePhpunitResult(server, resultFile)
    assertPlaygroundResponseOk("wordpress.core-phpunit", response)

    return response.text
  }

  private async persistCorePhpunitResult(server: PlaygroundCliServer, vfsPath: string): Promise<void> {
    if (!server.playground.readFileAsText) {
      return
    }

    try {
      const contents = await server.playground.readFileAsText(vfsPath)
      const hostPath = join(this.artifactRoot, "files", "core-phpunit", ".pg-test-result.txt")
      await mkdir(dirname(hostPath), { recursive: true })
      await writeFile(hostPath, contents)
    } catch {
      // The structured result is best-effort; preserve the command outcome if copying fails.
    }
  }

  private async readCorePhpunitDiagnostic(server: PlaygroundCliServer, vfsPath: string): Promise<string | undefined> {
    if (!server.playground.readFileAsText) {
      return undefined
    }

    let contents: string
    try {
      contents = await server.playground.readFileAsText(vfsPath)
    } catch {
      return undefined
    }

    return extractCorePhpunitFailureMessage(contents)
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
${this.pluginRuntimeBootstrapPhp()}
require_once '/wordpress/wp-load.php';
${this.secretEnvPhp()}
${wpCliBridge ? `putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_URL=${wpCliBridge.url}`)});
putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_TOKEN=${wpCliBridge.token}`)});
` : ""}
${phpBody(code)}`
  }

  private pluginRuntimeBootstrapPhp(): string {
    const pluginRuntime = this.spec.metadata?.recipe && typeof this.spec.metadata.recipe === "object" && !Array.isArray(this.spec.metadata.recipe)
      ? (this.spec.metadata.recipe as { inputs?: { pluginRuntime?: unknown } }).inputs?.pluginRuntime
      : undefined
    if (!pluginRuntime || typeof pluginRuntime !== "object" || Array.isArray(pluginRuntime)) {
      return ""
    }

    const runtime = pluginRuntime as { php?: { memoryLimit?: unknown; maxExecutionTime?: unknown }; wpConfigDefines?: Record<string, unknown> }
    const lines: string[] = []
    const memoryLimit = typeof runtime.php?.memoryLimit === "string" ? runtime.php.memoryLimit : undefined
    if (memoryLimit && /^[0-9]+[KMG]?$/.test(memoryLimit)) {
      lines.push(`@ini_set('memory_limit', ${JSON.stringify(memoryLimit)});`)
    }
    const maxExecutionTime = runtime.php?.maxExecutionTime
    if (Number.isInteger(maxExecutionTime) && typeof maxExecutionTime === "number" && maxExecutionTime >= 0 && maxExecutionTime <= 3600) {
      lines.push(`@set_time_limit(${maxExecutionTime});`)
    }
    for (const [name, value] of Object.entries(runtime.wpConfigDefines ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(name) || (!["string", "number", "boolean"].includes(typeof value) && value !== null)) {
        continue
      }
      lines.push(`if (!defined(${JSON.stringify(name)})) { define(${JSON.stringify(name)}, ${phpLiteral(value as string | number | boolean | null)}); }`)
    }

    return lines.length > 0 ? `${lines.join("\n")}\n` : ""
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
    const response = await cliServer.playground.run({ code: this.bootstrapPhpCode(`
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
        checkpoints: probe.files.checkpoints,
        errorsFile: probe.files.errors,
        memory: probe.files.memory,
        actions: probe.files.steps ?? probe.files.actions,
        actionCount: probe.summary.steps ?? probe.summary.actions,
        steps: probe.files.steps,
        stepCount: probe.summary.steps,
        ...(probe.summary.assertions ? { assertions: { total: probe.summary.assertions.total, passed: probe.summary.assertions.passed, failed: probe.summary.assertions.failed } } : {}),
        performance: probe.files.performance,
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
      if (probe.files.steps) {
        files.set(probe.files.steps, { kind: "browser-steps", contentType: "application/x-ndjson" })
      }
      if (probe.files.actions) {
        files.set(probe.files.actions, { kind: "browser-actions", contentType: "application/x-ndjson" })
      }
      if (probe.files.console) {
        files.set(probe.files.console, { kind: "browser-console", contentType: "application/x-ndjson" })
      }
      if (probe.files.checkpoints) {
        files.set(probe.files.checkpoints, { kind: "browser-checkpoints", contentType: "application/x-ndjson" })
      }
      if (probe.files.errors) {
        files.set(probe.files.errors, { kind: "browser-errors", contentType: "application/x-ndjson" })
      }
      if (probe.files.html) {
        files.set(probe.files.html, { kind: "browser-html-snapshot", contentType: "text/html; charset=utf-8" })
      }
      if (probe.files.memory) {
        files.set(probe.files.memory, { kind: "browser-memory", contentType: "application/json" })
      }
      if (probe.files.network) {
        files.set(probe.files.network, { kind: "browser-network", contentType: "application/x-ndjson" })
      }
      if (probe.files.performance) {
        files.set(probe.files.performance, { kind: "browser-performance", contentType: "application/json" })
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
      for (const path of [probe.files.steps, probe.files.actions, probe.files.checkpoints, probe.files.console, probe.files.errors, probe.files.html, probe.files.memory, probe.files.network, probe.files.performance, probe.files.summary]) {
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

interface BrowserStepOutcome {
  assertion?: BrowserStepAssertion
  screenshot?: string
  screenshotIsDefault?: boolean
  error?: BrowserProbeErrorRecord
}

/**
 * Execute a single backend-agnostic interaction step against a Playwright page.
 * Each non-evaluate kind maps 1:1 to a stable locator action. evaluate is the only
 * arbitrary-JS escape hatch and is policy-gated by the caller before this runs.
 */
async function executeBrowserInteractionStep(
  page: Page,
  step: BrowserInteractionStep,
  baseUrl: string,
  stepTimeoutMs: number,
  defaultScreenshotPath: string,
  browserDirectory: string,
): Promise<BrowserStepOutcome> {
  const timeout = browserStepTimeoutMs(step, stepTimeoutMs)

  switch (step.kind) {
    case "navigate": {
      const url = resolveBrowserProbeUrl((step.url ?? "").trim(), baseUrl)
      await page.goto(url, { waitUntil: browserActionLoadState(step.waitFor), timeout })
      return {}
    }
    case "click": {
      await browserStepLocator(page, step).click({ timeout })
      return {}
    }
    case "hover": {
      await browserStepLocator(page, step).hover({ timeout })
      return {}
    }
    case "fill": {
      await page.locator(requireSelector(step, "fill")).fill(String(step.value ?? ""), { timeout })
      return {}
    }
    case "type": {
      const locator = page.locator(requireSelector(step, "type"))
      await locator.click({ timeout })
      await locator.pressSequentially(String(step.value ?? ""), { timeout })
      return {}
    }
    case "press": {
      const key = String(step.key ?? "")
      if (typeof step.selector === "string" && step.selector.length > 0) {
        await page.locator(step.selector).press(key, { timeout })
      } else {
        await page.keyboard.press(key)
      }
      return {}
    }
    case "drag": {
      const source = page.locator(requireFrom(step))
      if (step.to && "selector" in step.to) {
        await source.dragTo(page.locator(step.to.selector), { timeout })
      } else if (step.to) {
        const box = await source.boundingBox({ timeout })
        const startX = box ? box.x + box.width / 2 : 0
        const startY = box ? box.y + box.height / 2 : 0
        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await page.mouse.move(step.to.x, step.to.y, { steps: 8 })
        await page.mouse.up()
      }
      return {}
    }
    case "select": {
      const locator = page.locator(requireSelector(step, "select"))
      const values = Array.isArray(step.values) ? step.values : [String(step.value ?? "")]
      await locator.selectOption(values, { timeout })
      return {}
    }
    case "waitFor": {
      await browserStepWaitFor(page, step, timeout)
      return {}
    }
    case "evaluate": {
      const result = await page.evaluate(async (source) => {
        // Support both a bare expression ("a.b.c") and a multi-statement body
        // that returns explicitly. If the source already returns, run it as a
        // body; otherwise evaluate it as an expression and return its value.
        const body = /(^|[^.\w])return[\s(;]/.test(source) ? source : `return (\n${source}\n)`
        const run = new Function(`return (async () => {\n${body}\n})()`)
        return run()
      }, String(step.expression ?? ""))
      if (Object.prototype.hasOwnProperty.call(step, "assert")) {
        const passed = browserDeepEqual(result, step.assert)
        return {
          assertion: { kind: "evaluate", expression: step.expression, expected: step.assert, actual: result, passed },
        }
      }
      return {}
    }
    case "expect": {
      const selector = requireSelector(step, "expect")
      const state = step.state ?? "visible"
      const passed = await browserExpectState(page, selector, state, timeout)
      return { assertion: { kind: "expect", selector, state, passed } }
    }
    case "screenshot": {
      const path = typeof step.name === "string" && step.name.length > 0
        ? join(browserDirectory, `screenshot-${sanitizeScreenshotName(step.name)}.png`)
        : defaultScreenshotPath
      await page.screenshot({ path, fullPage: true })
      const isDefault = path === defaultScreenshotPath
      return {
        screenshot: isDefault ? "files/browser/screenshot.png" : `files/browser/${basename(path)}`,
        screenshotIsDefault: isDefault,
      }
    }
    case "capture":
      return {}
  }

  throw new Error(`wordpress.browser-actions step kind is not supported: ${step.kind}`)
}

function browserStepLocator(page: Page, step: BrowserInteractionStep) {
  if (typeof step.selector === "string" && step.selector.length > 0) {
    return page.locator(step.selector)
  }
  if (typeof step.text === "string" && step.text.length > 0) {
    return page.getByText(step.text)
  }
  throw new Error(`wordpress.browser-actions ${step.kind} requires selector or text`)
}

function requireSelector(step: BrowserInteractionStep, kind: string): string {
  if (typeof step.selector !== "string" || step.selector.length === 0) {
    throw new Error(`wordpress.browser-actions ${kind} requires selector`)
  }
  return step.selector
}

function requireFrom(step: BrowserInteractionStep): string {
  if (typeof step.from !== "string" || step.from.length === 0) {
    throw new Error("wordpress.browser-actions drag requires from selector")
  }
  return step.from
}

async function browserStepWaitFor(page: Page, step: BrowserInteractionStep, timeout: number): Promise<void> {
  if (typeof step.selector === "string" && step.selector.length > 0) {
    await page.locator(step.selector).waitFor({ timeout })
    return
  }
  const waitFor = typeof step.waitFor === "string" ? step.waitFor : "load"
  if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    await page.waitForLoadState(waitFor)
    return
  }
  if (waitFor === "duration") {
    await page.waitForTimeout(durationStringMs(step.duration))
    return
  }
  if (waitFor.startsWith("selector:")) {
    await page.locator(waitFor.slice("selector:".length)).waitFor({ timeout })
    return
  }
  throw new Error(`wordpress.browser-actions waitFor supports selector, domcontentloaded, load, networkidle, duration, selector:<sel>: ${waitFor}`)
}

async function browserExpectState(page: Page, selector: string, state: string, timeout: number): Promise<boolean> {
  const locator = page.locator(selector)
  try {
    switch (state) {
      case "visible":
      case "hidden":
      case "attached":
      case "detached":
        await locator.waitFor({ state, timeout })
        return true
      case "enabled":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isEnabled()
      case "disabled":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isDisabled()
      case "checked":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isChecked()
      case "unchecked":
        await locator.waitFor({ state: "visible", timeout })
        return !(await locator.isChecked())
      case "editable":
        await locator.waitFor({ state: "visible", timeout })
        return await locator.isEditable()
      default:
        return false
    }
  } catch {
    return false
  }
}

function browserStepTimeoutMs(step: BrowserInteractionStep, fallbackMs: number): number {
  if (typeof step.timeout === "string" && step.timeout.length > 0) {
    return durationStringMs(step.timeout)
  }
  return fallbackMs
}

function durationStringMs(raw: string | undefined): number {
  if (!raw) {
    return 0
  }
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) {
    throw new Error(`wordpress.browser-actions duration must be a duration like 500ms or 2s: ${raw}`)
  }
  const value = Number.parseFloat(match[1])
  return Math.max(0, Math.round(match[2] === "ms" ? value : value * 1000))
}

function sanitizeScreenshotName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "step"
}

function browserDeepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`
}

function browserStepRecord(
  index: number,
  step: BrowserInteractionStep,
  status: BrowserStepRecord["status"],
  startedAt: string,
  startedAtMs: number,
  finalUrl: string,
  outcome: BrowserStepOutcome,
): BrowserStepRecord {
  return {
    index,
    kind: step.kind,
    status,
    startedAt,
    finishedAt: now(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    ...(typeof step.url === "string" ? { url: step.url } : {}),
    ...(typeof step.selector === "string" ? { selector: step.selector } : {}),
    ...(typeof step.text === "string" ? { text: step.text } : {}),
    ...(typeof step.key === "string" ? { key: step.key } : {}),
    ...(typeof step.waitFor === "string" ? { waitFor: step.waitFor } : {}),
    ...(typeof step.duration === "string" ? { duration: step.duration } : {}),
    ...(outcome.assertion ? { assertion: outcome.assertion } : {}),
    ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
    finalUrl,
    ...(outcome.error ? { error: outcome.error } : {}),
  }
}

function browserAssertionsSummary(records: BrowserStepRecord[]): BrowserAssertionsSummary {
  const results = records
    .map((record) => record.assertion)
    .filter((assertion): assertion is BrowserStepAssertion => assertion !== undefined)
  const passed = results.filter((assertion) => assertion.passed).length
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  }
}

/** Normalize a legacy actions-json action into the steps contract. */
function normalizeLegacyBrowserAction(action: BrowserActionInput): BrowserInteractionStep {
  const kind = action.type === "wait" ? "waitFor" : (action.type as BrowserInteractionStep["kind"])
  const step: BrowserInteractionStep = { kind }
  if (typeof action.url === "string") step.url = action.url
  if (typeof action.selector === "string") step.selector = action.selector
  if (typeof action.text === "string") step.text = action.text
  if (typeof action.value === "string") step.value = action.value
  if (typeof action.key === "string") step.key = action.key
  if (typeof action.waitFor === "string") step.waitFor = action.waitFor
  if (typeof action.duration === "string") step.duration = action.duration
  return step
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

function browserActionLoadState(waitFor: unknown): "domcontentloaded" | "load" | "networkidle" {
  if (waitFor === undefined || waitFor === null || waitFor === "") {
    return "domcontentloaded"
  }
  if (waitFor === "domcontentloaded" || waitFor === "load" || waitFor === "networkidle") {
    return waitFor
  }
  throw new Error(`wordpress.browser-actions navigate waitFor supports domcontentloaded, load, networkidle: ${waitFor}`)
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

async function browserProbePendingCheckpoints(page: Page): Promise<BrowserProbeCheckpointRecord[]> {
  const pending = await page.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __wpCodeboxBrowserProbe?: { checkpoints?: Array<{ name?: unknown; metadata?: unknown; timestamp?: unknown }> } }).__wpCodeboxBrowserProbe
    const checkpoints = Array.isArray(state?.checkpoints) ? state.checkpoints.splice(0) : []
    return checkpoints.map((checkpoint) => ({
      name: typeof checkpoint.name === "string" ? checkpoint.name : "checkpoint",
      metadata: checkpoint.metadata,
      timestamp: typeof checkpoint.timestamp === "string" ? checkpoint.timestamp : undefined,
    }))
  })

  const records: BrowserProbeCheckpointRecord[] = []
  for (const checkpoint of pending) {
    records.push(await browserProbeCheckpoint(page, checkpoint.name, checkpoint.metadata, checkpoint.timestamp))
  }
  return records
}

async function browserProbeCheckpoint(page: Page, name: string, metadata?: unknown, timestamp?: string): Promise<BrowserProbeCheckpointRecord> {
  return {
    schema: "wp-codebox/browser-checkpoint/v1",
    name,
    ...(typeof metadata !== "undefined" ? { metadata } : {}),
    timestamp: timestamp ?? now(),
    metrics: await browserProbeMetricsSnapshot(page),
  }
}

async function browserProbeMetricsSnapshot(page: Page): Promise<BrowserProbeMetricsSnapshot> {
  const [pageMetrics, cdpMetrics] = await Promise.all([
    page.evaluate(() => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      const longTasks = ((globalThis as typeof globalThis & { __wpCodeboxBrowserProbe?: { longTasks?: Array<{ duration?: number }> } }).__wpCodeboxBrowserProbe?.longTasks ?? [])
        .map((entry) => Number(entry.duration ?? 0))
        .filter((duration) => Number.isFinite(duration) && duration >= 0)

      return {
        performanceMemory: {
          usedJSHeapSize: finiteNumberOrNull(memory?.usedJSHeapSize),
          totalJSHeapSize: finiteNumberOrNull(memory?.totalJSHeapSize),
          jsHeapSizeLimit: finiteNumberOrNull(memory?.jsHeapSizeLimit),
        },
        dom: {
          nodes: document.querySelectorAll("*").length,
          documents: 1,
          iframes: document.querySelectorAll("iframe").length,
        },
        resources: {
          count: resources.length,
          transferSizeBytes: resourceTotal(resources, "transferSize"),
          encodedBodySizeBytes: resourceTotal(resources, "encodedBodySize"),
          decodedBodySizeBytes: resourceTotal(resources, "decodedBodySize"),
        },
        longTasks: {
          count: longTasks.length,
          totalDurationMs: longTasks.reduce((total, duration) => total + duration, 0),
          maxDurationMs: longTasks.reduce((max, duration) => Math.max(max, duration), 0),
        },
      }

      function finiteNumberOrNull(value: unknown): number | null {
        return typeof value === "number" && Number.isFinite(value) ? value : null
      }

      function resourceTotal(resources: PerformanceResourceTiming[], field: "transferSize" | "encodedBodySize" | "decodedBodySize"): number {
        return resources.reduce((total, resource) => {
          const value = resource[field]
          return total + (Number.isFinite(value) && value > 0 ? value : 0)
        }, 0)
      }
    }),
    browserProbeCdpMetrics(page),
  ])

  return {
    timestamp: now(),
    memory: {
      performanceMemory: pageMetrics.performanceMemory,
      cdpHeap: cdpMetrics.heap,
      domCounters: cdpMetrics.domCounters,
    },
    performance: {
      cdpMetrics: cdpMetrics.performance,
      dom: {
        nodes: cdpMetrics.domCounters.nodes ?? pageMetrics.dom.nodes,
        documents: cdpMetrics.domCounters.documents ?? pageMetrics.dom.documents,
        iframes: pageMetrics.dom.iframes,
      },
      resources: pageMetrics.resources,
      longTasks: pageMetrics.longTasks,
    },
  }
}

async function browserProbeCdpMetrics(page: Page): Promise<{
  performance: Record<string, number>
  domCounters: { documents: number | null; nodes: number | null; jsEventListeners: number | null }
  heap: { usedSize: number | null; totalSize: number | null }
}> {
  const fallback = {
    performance: {},
    domCounters: { documents: null, nodes: null, jsEventListeners: null },
    heap: { usedSize: null, totalSize: null },
  }

  try {
    const session = await page.context().newCDPSession(page)
    try {
      await session.send("Performance.enable").catch(() => undefined)
      const [performanceResult, domCountersResult, heapResult] = await Promise.all([
        session.send("Performance.getMetrics").catch(() => undefined),
        session.send("Memory.getDOMCounters").catch(() => undefined),
        session.send("Runtime.getHeapUsage").catch(() => undefined),
      ])
      return {
        performance: cdpPerformanceMetrics(performanceResult),
        domCounters: cdpDomCounters(domCountersResult),
        heap: cdpHeapUsage(heapResult),
      }
    } finally {
      await session.detach().catch(() => undefined)
    }
  } catch {
    return fallback
  }
}

function browserProbeMemoryArtifact(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbeMemoryArtifact {
  const final = checkpoints.at(-1)?.metrics.memory ?? {
    performanceMemory: { usedJSHeapSize: null, totalJSHeapSize: null, jsHeapSizeLimit: null },
    cdpHeap: { usedSize: null, totalSize: null },
    domCounters: { documents: null, nodes: null, jsEventListeners: null },
  }

  return {
    schema: "wp-codebox/browser-memory/v1",
    version: 1,
    capturedAt: now(),
    final,
    peak: browserProbeMemorySummary(checkpoints),
    checkpoints,
  }
}

function browserProbePerformanceArtifact(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbePerformanceArtifact {
  const final = checkpoints.at(-1)?.metrics.performance ?? {
    cdpMetrics: {},
    dom: { nodes: 0, documents: 0, iframes: 0 },
    resources: { count: 0, transferSizeBytes: 0, encodedBodySizeBytes: 0, decodedBodySizeBytes: 0 },
    longTasks: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
  }

  return {
    schema: "wp-codebox/browser-performance/v1",
    version: 1,
    capturedAt: now(),
    final,
    peak: browserProbePerformanceSummary(checkpoints),
    checkpoints,
  }
}

function browserProbeMemorySummary(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbeMemorySummary {
  return {
    usedJSHeapSize: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.performanceMemory.usedJSHeapSize ?? checkpoint.metrics.memory.cdpHeap.usedSize)),
    totalJSHeapSize: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.performanceMemory.totalJSHeapSize ?? checkpoint.metrics.memory.cdpHeap.totalSize)),
    jsHeapSizeLimit: lastNumber(checkpoints.map((checkpoint) => checkpoint.metrics.memory.performanceMemory.jsHeapSizeLimit)),
    domNodes: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.domCounters.nodes ?? checkpoint.metrics.performance.dom.nodes)),
    documents: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.domCounters.documents ?? checkpoint.metrics.performance.dom.documents)),
    jsEventListeners: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.memory.domCounters.jsEventListeners)),
  }
}

function browserProbePerformanceSummary(checkpoints: BrowserProbeCheckpointRecord[]): BrowserProbePerformanceSummary {
  const final = checkpoints.at(-1)?.metrics.performance
  const metricNames = new Set<string>()
  for (const checkpoint of checkpoints) {
    for (const key of Object.keys(checkpoint.metrics.performance.cdpMetrics)) {
      metricNames.add(key)
    }
  }

  return {
    resources: final?.resources.count ?? 0,
    transferSizeBytes: final?.resources.transferSizeBytes ?? 0,
    encodedBodySizeBytes: final?.resources.encodedBodySizeBytes ?? 0,
    decodedBodySizeBytes: final?.resources.decodedBodySizeBytes ?? 0,
    longTasks: final?.longTasks.count ?? 0,
    longTaskDurationMs: final?.longTasks.totalDurationMs ?? 0,
    domNodes: metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.performance.dom.nodes)),
    cdpMetrics: Object.fromEntries([...metricNames].sort().map((name) => [name, metricDigest(checkpoints.map((checkpoint) => checkpoint.metrics.performance.cdpMetrics[name]))])),
  }
}

function cdpPerformanceMetrics(value: unknown): Record<string, number> {
  if (!isRecord(value) || !Array.isArray(value.metrics)) {
    return {}
  }

  return Object.fromEntries(value.metrics.flatMap((metric) => {
    if (!isRecord(metric) || typeof metric.name !== "string" || typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
      return []
    }
    return [[metric.name, metric.value]]
  }))
}

function cdpDomCounters(value: unknown): { documents: number | null; nodes: number | null; jsEventListeners: number | null } {
  return {
    documents: recordNumberOrNull(value, "documents"),
    nodes: recordNumberOrNull(value, "nodes"),
    jsEventListeners: recordNumberOrNull(value, "jsEventListeners"),
  }
}

function cdpHeapUsage(value: unknown): { usedSize: number | null; totalSize: number | null } {
  return {
    usedSize: recordNumberOrNull(value, "usedSize"),
    totalSize: recordNumberOrNull(value, "totalSize"),
  }
}

function recordNumberOrNull(value: unknown, key: string): number | null {
  if (!isRecord(value)) {
    return null
  }
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : null
}

function metricDigest(values: Array<number | null | undefined>): BrowserProbeMetricDigest {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return {
    final: numbers.at(-1) ?? null,
    peak: numbers.length > 0 ? Math.max(...numbers) : null,
  }
}

function lastNumber(values: Array<number | null | undefined>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }

  return null
}

function browserProbeBenchMetrics(memoryArtifact?: BrowserProbeMemoryArtifact, performanceArtifact?: BrowserProbePerformanceArtifact): Record<string, number> {
  const memory = memoryArtifact?.peak
  const performance = performanceArtifact?.final
  return {
    browser_peak_used_js_heap_bytes: memory?.usedJSHeapSize.peak ?? 0,
    browser_final_used_js_heap_bytes: memory?.usedJSHeapSize.final ?? 0,
    browser_checkpoint_count: performanceArtifact?.checkpoints.length ?? memoryArtifact?.checkpoints.length ?? 0,
    browser_dom_node_count: performance?.dom.nodes ?? memory?.domNodes.final ?? 0,
    browser_iframe_count: performance?.dom.iframes ?? 0,
    browser_resource_count: performance?.resources.count ?? 0,
    browser_transfer_size_bytes: performance?.resources.transferSizeBytes ?? 0,
    browser_long_task_count: performance?.longTasks.count ?? 0,
    browser_long_task_total_ms: performance?.longTasks.totalDurationMs ?? 0,
  }
}

function promoteBrowserMetricsToBenchResults(raw: string, probes: BrowserProbeArtifact[]): string {
  const metrics = combinedBrowserBenchMetrics(probes)
  if (!metrics) {
    return raw
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>
  const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : []
  for (const scenario of scenarios) {
    if (!isRecord(scenario)) {
      continue
    }

    scenario.metrics = {
      ...(isRecord(scenario.metrics) ? scenario.metrics : {}),
      ...metrics,
    }
  }

  return `${JSON.stringify(parsed, null, 2)}\n`
}

function combinedBrowserBenchMetrics(probes: BrowserProbeArtifact[]): Record<string, number> | undefined {
  const metricSets = probes.map((probe) => probe.summary.metrics).filter((metrics): metrics is Record<string, number> => isRecord(metrics))
  if (metricSets.length === 0) {
    return undefined
  }

  const finalMetrics = metricSets.at(-1) ?? {}
  return {
    browser_peak_used_js_heap_bytes: Math.max(...metricSets.map((metrics) => metrics.browser_peak_used_js_heap_bytes ?? 0)),
    browser_final_used_js_heap_bytes: finalMetrics.browser_final_used_js_heap_bytes ?? 0,
    browser_checkpoint_count: sumMetric(metricSets, "browser_checkpoint_count"),
    browser_dom_node_count: finalMetrics.browser_dom_node_count ?? 0,
    browser_iframe_count: finalMetrics.browser_iframe_count ?? 0,
    browser_resource_count: finalMetrics.browser_resource_count ?? 0,
    browser_transfer_size_bytes: finalMetrics.browser_transfer_size_bytes ?? 0,
    browser_long_task_count: sumMetric(metricSets, "browser_long_task_count"),
    browser_long_task_total_ms: sumMetric(metricSets, "browser_long_task_total_ms"),
  }
}

function sumMetric(metricSets: Array<Record<string, number>>, name: string): number {
  return metricSets.reduce((total, metrics) => total + (metrics[name] ?? 0), 0)
}

async function serializeBrowserFinishedRequest(request: Request): Promise<BrowserProbeNetworkRecord> {
  const response = await request.response()
  if (!response) {
    return {
      type: "response",
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp: now(),
      timing: browserRequestTiming(request),
    }
  }

  return serializeBrowserResponse(response)
}

async function serializeBrowserResponse(response: Response): Promise<BrowserProbeNetworkRecord> {
  const request = response.request()
  const sizes = await browserRequestSizes(request)
  const transferSize = sizes ? sizes.responseHeadersSize + sizes.responseBodySize : undefined
  return {
    type: "response",
    url: response.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    statusText: response.statusText(),
    ok: response.ok(),
    contentType: response.headers()["content-type"] ?? null,
    timing: browserRequestTiming(request),
    ...(sizes ? { sizes } : {}),
    ...(typeof transferSize === "number" ? { transferSize } : {}),
    ...(sizes ? { bodySize: sizes.responseBodySize } : {}),
    ...(sizes ? { requestBodySize: sizes.requestBodySize } : {}),
    ...(sizes ? { responseBodySize: sizes.responseBodySize } : {}),
    timestamp: now(),
  }
}

function serializeBrowserRequestFailure(request: Request): BrowserProbeNetworkRecord {
  return {
    type: "requestfailed",
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    timing: browserRequestTiming(request),
    failure: request.failure(),
    timestamp: now(),
  }
}

function browserRequestTiming(request: Request): Record<string, number> {
  return Object.fromEntries(
    Object.entries(request.timing()).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  )
}

async function browserRequestSizes(request: Request): Promise<BrowserProbeNetworkSizes | undefined> {
  const maybeSizedRequest = request as Request & { sizes?: () => Promise<BrowserProbeNetworkSizes> }
  if (typeof maybeSizedRequest.sizes !== "function") {
    return undefined
  }

  try {
    return await maybeSizedRequest.sizes()
  } catch {
    return undefined
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
