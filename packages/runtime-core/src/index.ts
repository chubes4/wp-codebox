export type RuntimeBackendKind = "wordpress-playground" | (string & {})

export interface EnvironmentSpec {
  kind: string
  name?: string
  blueprint?: unknown
  version?: string
}

export interface RuntimePolicy {
  network: "allow" | "deny" | { allowHosts: string[] }
  filesystem: "sandbox" | "readonly-mounts" | "readwrite-mounts"
  commands: string[]
  secrets: "none" | "connector-scoped"
  approvals: "never" | "on-write" | "on-command"
}

export type TaskTargetKind = "repo" | "site" | "plugin" | "theme" | (string & {})

export interface TaskTarget {
  kind: TaskTargetKind
  ref?: string
  path?: string
  url?: string
}

export interface TaskInputPolicy {
  approvals?: "never" | "on-write" | "on-command"
  applyBack?: "disabled" | "reviewed"
  sandbox?: "required" | "preferred"
  [key: string]: unknown
}

export interface TaskInput {
  schema?: "wp-codebox/task-input/v1"
  goal: string
  target?: TaskTarget
  allowed_tools?: string[]
  expected_artifacts?: string[]
  policy?: TaskInputPolicy
  context?: Record<string, unknown>
}

export type RuntimePolicyField = keyof RuntimePolicy

export type RuntimePolicyValidationIssueCode =
  | "invalid-network"
  | "invalid-filesystem"
  | "invalid-command"
  | "invalid-secrets"
  | "invalid-approvals"

export interface RuntimePolicyValidationIssue {
  code: RuntimePolicyValidationIssueCode
  field: RuntimePolicyField
  message: string
}

export interface RuntimePolicyValidationResult {
  valid: boolean
  issues: RuntimePolicyValidationIssue[]
}

export interface RuntimeCommandPolicyViolationDetails {
  code: "runtime-command-disallowed"
  command: string
  allowedCommands: string[]
  policy: RuntimePolicy
}

export interface RuntimeCreateSpec {
  backend: RuntimeBackendKind
  environment: EnvironmentSpec
  policy: RuntimePolicy
  artifactsDirectory?: string
  secretEnv?: Record<string, string>
  metadata?: Record<string, unknown>
  preview?: RuntimePreviewSpec
}

export interface RuntimePreviewSpec {
  publicUrl?: string
  siteUrl?: string
  port?: number
}

export interface WorkspaceRecipeMount {
  source: string
  target: string
  mode?: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeStep {
  command: string
  args?: string[]
}

export interface WorkspaceRecipeExtraPlugin {
  source: string
  slug?: string
  pluginFile?: string
  activate?: boolean
}

export type WorkspaceRecipeSeedType = "plugin_scaffold" | "theme_scaffold" | "directory"

export interface WorkspaceRecipeWorkspaceSeed {
  type: WorkspaceRecipeSeedType
  slug?: string
  name?: string
  source?: string
}

export interface WorkspaceRecipeWorkspace {
  target?: string
  mode?: "readonly" | "readwrite"
  seed: WorkspaceRecipeWorkspaceSeed
}

export interface WorkspaceRecipe {
  schema: "wp-codebox/workspace-recipe/v1"
  runtime?: {
    backend?: RuntimeBackendKind
    name?: string
    wp?: string
    blueprint?: unknown
  }
  inputs?: {
    workspaces?: WorkspaceRecipeWorkspace[]
    mounts?: WorkspaceRecipeMount[]
    extra_plugins?: WorkspaceRecipeExtraPlugin[]
    extraPlugins?: WorkspaceRecipeExtraPlugin[]
    secretEnv?: string[]
    inherit?: WorkspaceRecipeInheritanceRequest
    inheritance?: WorkspaceRecipeInheritanceResolution
  }
  workflow: {
    steps: WorkspaceRecipeStep[]
  }
  artifacts?: {
    directory?: string
  }
}

export interface WorkspaceRecipeInheritanceRequest {
  connectors?: string[]
  settings?: string[]
}

export interface WorkspaceRecipeInheritanceConnector {
  name: string
  status: "resolved" | "unresolved" | "skipped" | (string & {})
  provider?: string
  model?: string
  secretEnv?: string[]
}

export interface WorkspaceRecipeInheritanceSetting {
  name: string
  status: "resolved" | "unresolved" | "skipped" | (string & {})
  scope?: string
}

export interface WorkspaceRecipeInheritanceResolution {
  connectors?: WorkspaceRecipeInheritanceConnector[]
  settings?: WorkspaceRecipeInheritanceSetting[]
}

export interface RuntimeInfo {
  id: string
  backend: RuntimeBackendKind
  environment: EnvironmentSpec
  createdAt: string
  status: "created" | "destroyed"
  previewUrl?: string
}

export interface MountSpec {
  type: "directory" | "file" | (string & {})
  source: string
  target: string
  mode: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
}

export interface ExecutionSpec {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

export interface ExecutionResult {
  id: string
  command: string
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
  startedAt: string
  finishedAt: string
}

export interface ObservationSpec {
  type: "runtime-info" | "mounts" | "files" | (string & {})
  path?: string
}

export interface ObservationResult {
  type: string
  data: unknown
  observedAt: string
}

export interface LifecycleEvent {
  id: string
  type:
    | "runtime.created"
    | "runtime.mounted"
    | "runtime.command.started"
    | "runtime.command.finished"
    | "runtime.observed"
    | "runtime.snapshot.created"
    | "runtime.artifacts.collected"
    | "runtime.destroyed"
    | (string & {})
  timestamp: string
  data?: Record<string, unknown>
}

export interface Snapshot {
  id: string
  createdAt: string
  metadata: Record<string, unknown>
}

export interface ArtifactSpec {
  includeFiles?: boolean
  includeLogs?: boolean
  includePatch?: boolean
  includeScreenshots?: boolean
  includeObservations?: boolean
  previewHoldSeconds?: number
}

export interface ArtifactManifestFile {
  path: string
  kind:
    | "manifest"
    | "metadata"
    | "events"
    | "commands"
    | "observations"
    | "log"
    | "mounts"
    | "file"
    | "test-results"
    | (string & {})
  contentType: string
}

export interface ArtifactManifest {
  id: string
  contentDigest: ArtifactContentDigest
  createdAt: string
  runtime: RuntimeInfo
  files: ArtifactManifestFile[]
}

export interface ArtifactContentDigest {
  algorithm: "sha256"
  inputs: string[]
  value: string
}

export interface ArtifactProvenance {
  task?: Record<string, unknown>
  runtime: {
    backend: RuntimeBackendKind
    version?: string
    wordpressVersion?: string
  }
  agent?: Record<string, unknown>
  mounts: Array<{
    type: MountSpec["type"]
    source: string
    target: string
    mode: MountSpec["mode"]
    metadata?: Record<string, unknown>
  }>
}

export type ArtifactReviewProgressEventType =
  | "boot"
  | "mount"
  | "agent-start"
  | "tool-activity"
  | "artifact"
  | "complete"
  | (string & {})

export interface ArtifactReviewProgressEvent {
  type: ArtifactReviewProgressEventType
  label: string
  component?: string
  action?: string
  timestamp?: string
}

export type ArtifactReviewActionKind = "approve" | "approve-files" | "discard" | "iterate" | (string & {})

export interface ArtifactReviewAction {
  kind: ArtifactReviewActionKind
  label: string
  requiresApprovedFiles?: boolean
}

export interface ArtifactReviewChangedFile {
  path: string
  status: "added" | "modified" | "deleted"
  label: string
  mountTarget: string
  relativePath: string
}

export interface ArtifactReview {
  schema: "wp-codebox/artifact-review/v1"
  artifactId: string
  createdAt: string
  provenance: ArtifactProvenance
  summary: string
  stats: {
    added: number
    modified: number
    deleted: number
    total: number
  }
  changedFiles: ArtifactReviewChangedFile[]
  preview?: ArtifactPreview
  progress: ArtifactReviewProgressEvent[]
  actions: ArtifactReviewAction[]
  evidence: {
    patch: string
    patchSha256: string
    artifactContentDigest: string
    changedFiles: string
    testResults?: string
  }
  browser?: ArtifactReviewBrowserSummary
  redaction?: ArtifactRedactionSummary
  riskFlags: string[]
}

export interface ArtifactReviewBrowserSummary {
  summary: string
  probes: Array<{
    url: string
    consoleMessages: number
    errors: number
    screenshot?: string
    console?: string
    errorsFile?: string
  }>
}

export interface ArtifactPreview {
  url: string
  localUrl?: string
  publicUrl?: string
  siteUrl?: string
  status: "available" | "expired-on-completion"
  lifecycle: "held-after-run" | "destroyed-on-completion"
  source: "live-playground" | "public-url-override"
  createdAt: string
  expiresAt?: string
  holdSeconds?: number
}

export interface ArtifactRedactionArtifactSummary {
  path: string
  count: number
  kinds: string[]
}

export interface ArtifactRedactionSummary {
  schema: "wp-codebox/artifact-redaction/v1"
  status: "clean" | "redacted"
  total: number
  byKind: Record<string, number>
  artifacts: ArtifactRedactionArtifactSummary[]
}

export interface ArtifactTestResultsRawLogReference {
  path: string
  kind: string
}

export interface ArtifactTestResultsSuite {
  name: string
  status: "passed" | "failed" | "skipped" | "unknown"
  tests: number
  passed: number
  failed: number
  skipped: number
  unknown: number
  rawLogReferences?: ArtifactTestResultsRawLogReference[]
}

export interface ArtifactTestResults {
  schema: "wp-codebox/test-results/v1"
  status: "passed" | "failed" | "skipped" | "unknown"
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    unknown: number
  }
  suites: ArtifactTestResultsSuite[]
  rawLogReferences: ArtifactTestResultsRawLogReference[]
}

export interface ArtifactBundle {
  id: string
  directory: string
  manifestPath: string
  metadataPath: string
  blueprintAfterPath: string
  blueprintAfterNotesPath: string
  eventsPath: string
  commandsPath: string
  observationsPath: string
  runtimeLogPath: string
  commandsLogPath: string
  mountsPath: string
  capturedMountsPath: string
  diffsPath: string
  changedFilesPath: string
  patchPath: string
  testResultsPath: string
  reviewPath: string
  preview?: ArtifactPreview
  contentDigest: string
  createdAt: string
}

export interface Runtime {
  info(): Promise<RuntimeInfo>
  mount(spec: MountSpec): Promise<void>
  execute(spec: ExecutionSpec): Promise<ExecutionResult>
  observe(spec: ObservationSpec): Promise<ObservationResult>
  snapshot(): Promise<Snapshot>
  collectArtifacts(spec?: ArtifactSpec): Promise<ArtifactBundle>
  destroy(): Promise<void>
}

export interface RuntimeEpisodeSpec {
  runtime: RuntimeCreateSpec
  mounts?: MountSpec[]
  resetObservations?: ObservationSpec[]
  stepObservation?: ObservationSpec | false
  artifactSpec?: ArtifactSpec
}

export interface RuntimeEpisodeResetResult {
  runtime: RuntimeInfo
  observations: ObservationResult[]
}

export interface RuntimeEpisodeStepResult {
  index: number
  action: ExecutionSpec
  execution: ExecutionResult
  observation?: ObservationResult
}

export interface RuntimeEpisodeTrace {
  schema: "wp-codebox/runtime-episode-trace/v1"
  runtime: RuntimeInfo
  reset: RuntimeEpisodeResetResult
  steps: RuntimeEpisodeStepResult[]
  snapshots: Snapshot[]
  artifacts?: ArtifactBundle
}

export interface RuntimeEpisode {
  reset(): Promise<RuntimeEpisodeResetResult>
  step(action: ExecutionSpec, observation?: ObservationSpec | false): Promise<RuntimeEpisodeStepResult>
  observe(spec: ObservationSpec): Promise<ObservationResult>
  snapshot(): Promise<Snapshot>
  collectArtifacts(spec?: ArtifactSpec): Promise<ArtifactBundle>
  trace(): Promise<RuntimeEpisodeTrace>
  close(): Promise<void>
}

export interface RuntimeBackend {
  readonly kind: RuntimeBackendKind
  create(spec: RuntimeCreateSpec): Promise<Runtime>
}

export class RuntimePolicyValidationError extends Error {
  readonly code = "runtime-policy-invalid" as const

  constructor(readonly issues: RuntimePolicyValidationIssue[]) {
    super(`Runtime policy is invalid: ${issues.map((issue) => issue.message).join("; ")}`)
    this.name = "RuntimePolicyValidationError"
  }

  toJSON(): { code: "runtime-policy-invalid"; issues: RuntimePolicyValidationIssue[]; message: string; name: string } {
    return {
      code: this.code,
      issues: this.issues,
      message: this.message,
      name: this.name,
    }
  }
}

export class RuntimeCommandPolicyViolationError extends Error {
  readonly code = "runtime-command-disallowed" as const
  readonly command: string
  readonly allowedCommands: string[]
  readonly policy: RuntimePolicy

  constructor(command: string, policy: RuntimePolicy) {
    super(`Command is not allowed by runtime policy: ${command}`)
    this.name = "RuntimeCommandPolicyViolationError"
    this.command = command
    this.allowedCommands = [...policy.commands]
    this.policy = policy
  }

  toJSON(): RuntimeCommandPolicyViolationDetails & { message: string; name: string } {
    return {
      code: this.code,
      command: this.command,
      allowedCommands: this.allowedCommands,
      policy: this.policy,
      message: this.message,
      name: this.name,
    }
  }
}

export function validateRuntimePolicy(policy: unknown): RuntimePolicyValidationResult {
  const issues: RuntimePolicyValidationIssue[] = []
  const candidate = policy as Partial<RuntimePolicy> | null

  if (!candidate || typeof candidate !== "object") {
    return {
      valid: false,
      issues: [
        { code: "invalid-network", field: "network", message: "policy must be an object with v0 policy fields" },
        { code: "invalid-filesystem", field: "filesystem", message: "policy must be an object with v0 policy fields" },
        { code: "invalid-command", field: "commands", message: "policy must be an object with v0 policy fields" },
        { code: "invalid-secrets", field: "secrets", message: "policy must be an object with v0 policy fields" },
        { code: "invalid-approvals", field: "approvals", message: "policy must be an object with v0 policy fields" },
      ],
    }
  }

  if (
    candidate.network !== "allow" &&
    candidate.network !== "deny" &&
    (!candidate.network ||
      typeof candidate.network !== "object" ||
      !Array.isArray(candidate.network.allowHosts) ||
      !candidate.network.allowHosts.every((host) => typeof host === "string" && host.length > 0))
  ) {
    issues.push({
      code: "invalid-network",
      field: "network",
      message: "network must be allow, deny, or an allowHosts list",
    })
  }

  if (!["sandbox", "readonly-mounts", "readwrite-mounts"].includes(candidate.filesystem ?? "")) {
    issues.push({
      code: "invalid-filesystem",
      field: "filesystem",
      message: "filesystem must be sandbox, readonly-mounts, or readwrite-mounts",
    })
  }

  if (!Array.isArray(candidate.commands) || !candidate.commands.every((command) => typeof command === "string" && command.length > 0)) {
    issues.push({
      code: "invalid-command",
      field: "commands",
      message: "commands must be a list of non-empty command names",
    })
  }

  if (!["none", "connector-scoped"].includes(candidate.secrets ?? "")) {
    issues.push({
      code: "invalid-secrets",
      field: "secrets",
      message: "secrets must be none or connector-scoped",
    })
  }

  if (!["never", "on-write", "on-command"].includes(candidate.approvals ?? "")) {
    issues.push({
      code: "invalid-approvals",
      field: "approvals",
      message: "approvals must be never, on-write, or on-command",
    })
  }

  return { valid: issues.length === 0, issues }
}

export function assertRuntimePolicy(policy: unknown): asserts policy is RuntimePolicy {
  const result = validateRuntimePolicy(policy)

  if (!result.valid) {
    throw new RuntimePolicyValidationError(result.issues)
  }
}

export function assertRuntimeCommandAllowed(command: string, policy: RuntimePolicy): void {
  if (!policy.commands.includes(command)) {
    throw new RuntimeCommandPolicyViolationError(command, policy)
  }
}

export async function createRuntime(spec: RuntimeCreateSpec, backend: RuntimeBackend): Promise<Runtime> {
  assertRuntimePolicy(spec.policy)

  if (backend.kind !== spec.backend) {
    throw new Error(`Backend ${backend.kind} cannot create runtime ${spec.backend}`)
  }

  return backend.create(spec)
}

export async function createRuntimeEpisode(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<RuntimeEpisode> {
  return RuntimeEpisodeRunner.create(spec, backend)
}

class RuntimeEpisodeRunner implements RuntimeEpisode {
  private runtime?: Runtime
  private resetResult?: RuntimeEpisodeResetResult
  private readonly steps: RuntimeEpisodeStepResult[] = []
  private readonly snapshots: Snapshot[] = []
  private artifacts?: ArtifactBundle

  private constructor(
    private readonly spec: RuntimeEpisodeSpec,
    private readonly backend: RuntimeBackend,
  ) {}

  static async create(spec: RuntimeEpisodeSpec, backend: RuntimeBackend): Promise<RuntimeEpisodeRunner> {
    const episode = new RuntimeEpisodeRunner(spec, backend)
    await episode.reset()
    return episode
  }

  async reset(): Promise<RuntimeEpisodeResetResult> {
    await this.runtime?.destroy()
    this.runtime = await createRuntime(this.spec.runtime, this.backend)
    this.steps.length = 0
    this.snapshots.length = 0
    this.artifacts = undefined

    for (const mount of this.spec.mounts ?? []) {
      await this.runtime.mount(mount)
    }

    const observations = []
    for (const observation of this.spec.resetObservations ?? [{ type: "runtime-info" }, { type: "mounts" }]) {
      observations.push(await this.runtime.observe(observation))
    }

    this.resetResult = {
      runtime: await this.runtime.info(),
      observations,
    }

    return this.resetResult
  }

  async step(action: ExecutionSpec, observation: ObservationSpec | false = this.spec.stepObservation ?? false): Promise<RuntimeEpisodeStepResult> {
    const runtime = this.assertRuntime()
    const execution = await runtime.execute(action)
    const result: RuntimeEpisodeStepResult = {
      index: this.steps.length,
      action,
      execution,
      ...(observation ? { observation: await runtime.observe(observation) } : {}),
    }

    this.steps.push(result)
    return result
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    return this.assertRuntime().observe(spec)
  }

  async snapshot(): Promise<Snapshot> {
    const snapshot = await this.assertRuntime().snapshot()
    this.snapshots.push(snapshot)
    return snapshot
  }

  async collectArtifacts(spec: ArtifactSpec = this.spec.artifactSpec ?? {}): Promise<ArtifactBundle> {
    this.artifacts = await this.assertRuntime().collectArtifacts(spec)
    return this.artifacts
  }

  async trace(): Promise<RuntimeEpisodeTrace> {
    const runtime = this.assertRuntime()
    const reset = this.resetResult ?? {
      runtime: await runtime.info(),
      observations: [],
    }

    return {
      schema: "wp-codebox/runtime-episode-trace/v1",
      runtime: await runtime.info(),
      reset,
      steps: [...this.steps],
      snapshots: [...this.snapshots],
      ...(this.artifacts ? { artifacts: this.artifacts } : {}),
    }
  }

  async close(): Promise<void> {
    await this.runtime?.destroy()
    this.runtime = undefined
  }

  private assertRuntime(): Runtime {
    if (!this.runtime) {
      throw new Error("Runtime episode is closed")
    }

    return this.runtime
  }
}
