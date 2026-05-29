import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, sep } from "node:path"

export * from "./workspace-policy.js"

export type RuntimeBackendKind = "wordpress-playground" | (string & {})

export const RUNTIME_EPISODE_TRACE_SCHEMA = "wp-codebox/runtime-episode-trace/v1" as const
export const RUNTIME_EPISODE_ACTION_SCHEMA = "wp-codebox/runtime-episode-action/v1" as const
export const RUNTIME_EPISODE_OBSERVATION_SCHEMA = "wp-codebox/runtime-episode-observation/v1" as const
export const RUNTIME_EPISODE_SNAPSHOT_SCHEMA = "wp-codebox/runtime-episode-snapshot/v1" as const
export const RUNTIME_REFERENCE_MANIFEST_SCHEMA = "wp-codebox/runtime-reference-manifest/v1" as const

export const RUNTIME_EPISODE_TRACE_JSON_SCHEMA = {
  $id: RUNTIME_EPISODE_TRACE_SCHEMA,
  type: "object",
  required: ["schema", "version", "id", "createdAt", "runtime", "reset", "steps", "snapshots"],
  properties: {
    schema: { const: RUNTIME_EPISODE_TRACE_SCHEMA },
    version: { const: 1 },
    id: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    runtime: { type: "object", required: ["id", "backend", "environment", "createdAt", "status"] },
    reset: { type: "object", required: ["id", "runtime", "observations", "observationRefs"] },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "index", "action", "actionRef", "execution", "executionRef"],
        properties: {
          action: {
            type: "object",
            required: ["schema", "id", "kind", "command", "args", "digest"],
            properties: {
              schema: { const: RUNTIME_EPISODE_ACTION_SCHEMA },
              id: { type: "string", minLength: 1 },
              kind: { enum: ["command", "filesystem", "http", "browser"] },
              command: { type: "string", minLength: 1 },
              args: { type: "array", items: { type: "string" } },
              cwd: { type: "string" },
              timeoutMs: { type: "number", minimum: 0 },
              method: { type: "string", minLength: 1 },
              url: { type: "string", minLength: 1 },
              path: { type: "string", minLength: 1 },
              operation: { type: "string", minLength: 1 },
              selector: { type: "string", minLength: 1 },
              description: { type: "string", minLength: 1 },
              metadata: { type: "object" },
              digest: {
                type: "object",
                required: ["algorithm", "value"],
                properties: {
                  algorithm: { const: "sha256" },
                  value: { type: "string", pattern: "^[a-f0-9]{64}$" },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          observation: {
            type: "object",
            required: ["schema", "id", "type", "data", "observedAt", "digest"],
          },
        },
      },
    },
    snapshots: {
      type: "array",
      items: { type: "object", required: ["schema", "id", "createdAt", "semantics", "metadata", "digest"] },
    },
    artifacts: { type: "object" },
    artifactRef: { type: "object", required: ["kind", "id"] },
  },
  additionalProperties: true,
} as const

const RUNTIME_EPISODE_TRACE_FORBIDDEN_FIELDS = new Set([
  "reward",
  "success",
  "grader",
  "scenario",
  "task-set",
  "task_set",
  "taskSet",
  "benchmark",
  "model-eval",
  "model_eval",
  "modelEval",
])

export const SANDBOX_WORKSPACE_ROOT = "/workspace"

export type SandboxWorkspaceMode = "repo-backed" | "site-backed"

export const SANDBOX_DMC_SAFE_ABILITIES = [
  "datamachine/workspace-read",
  "datamachine/workspace-ls",
  "datamachine/workspace-grep",
  "datamachine/workspace-write",
  "datamachine/workspace-edit",
  "datamachine/workspace-apply-patch",
  "datamachine/workspace-git-status",
  "datamachine/workspace-git-log",
  "datamachine/workspace-git-diff",
  "datamachine/list-github-issues",
  "datamachine/get-github-issue",
  "datamachine/list-github-pulls",
  "datamachine/get-github-pull",
  "datamachine/list-github-pull-files",
  "datamachine/get-github-check-runs",
  "datamachine/get-github-commit-statuses",
  "datamachine/list-github-tree",
  "datamachine/get-github-file",
  "datamachine/list-github-repos",
] as const

export const SANDBOX_DMC_PARENT_ONLY_ABILITIES = [
  "datamachine/workspace-clone",
  "datamachine/workspace-adopt",
  "datamachine/workspace-remove",
  "datamachine/workspace-delete",
  "datamachine/workspace-git-pull",
  "datamachine/workspace-git-add",
  "datamachine/workspace-git-commit",
  "datamachine/workspace-git-push",
  "datamachine/workspace-git-rebase",
  "datamachine/workspace-git-reset",
  "datamachine/workspace-pr-rebase",
  "datamachine/workspace-worktree-add",
  "datamachine/workspace-worktree-finalize",
  "datamachine/workspace-worktree-remove",
  "datamachine/workspace-worktree-prune",
  "datamachine/workspace-worktree-cleanup",
  "datamachine/workspace-cleanup-apply",
  "datamachine/create-github-issue",
  "datamachine/update-github-issue",
  "datamachine/create-github-pull-request",
  "datamachine/comment-github-issue",
  "datamachine/comment-github-pull-request",
  "datamachine/upsert-github-pull-review-comment",
  "datamachine/merge-github-pull-request",
  "datamachine/cleanup-github-pull-request",
  "datamachine/create-or-update-github-file",
  "datamachine/create-code-task",
  "datamachine/gitsync-bind",
  "datamachine/gitsync-unbind",
  "datamachine/gitsync-pull",
  "datamachine/gitsync-submit",
  "datamachine/gitsync-push",
  "datamachine/gitsync-policy-update",
] as const

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
  bind?: string
}

export interface WorkspaceRecipeMount {
  source: string
  target: string
  mode?: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
}

export interface WorkspaceRecipeStagedFile {
  source: string
  target: string
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

export type WorkspaceRecipeSiteSeedType = "fixture" | "parent_site"
export type WorkspaceRecipeSiteSeedFormat = "json" | (string & {})

export interface WorkspaceRecipeSiteSeedScopeSelector {
  ids?: number[]
  slugs?: string[]
  names?: string[]
  postTypes?: string[]
  taxonomies?: string[]
  roles?: string[]
  statuses?: string[]
  includeFiles?: boolean
  anonymize?: boolean
  maxRecords?: number
}

export interface WorkspaceRecipeSiteSeed {
  type: WorkspaceRecipeSiteSeedType
  name: string
  source?: string
  format?: WorkspaceRecipeSiteSeedFormat
  scopes: {
    posts?: WorkspaceRecipeSiteSeedScopeSelector
    terms?: WorkspaceRecipeSiteSeedScopeSelector
    options?: WorkspaceRecipeSiteSeedScopeSelector
    users?: WorkspaceRecipeSiteSeedScopeSelector
    media?: WorkspaceRecipeSiteSeedScopeSelector
    activePlugins?: boolean
    activeTheme?: boolean
  }
}

export type WorkspaceRecipeSeedType = "plugin_scaffold" | "theme_scaffold" | "directory"

export interface WorkspaceRecipeWorkspaceSeed {
  type: WorkspaceRecipeSeedType
  slug?: string
  name?: string
  source?: string
  excludePaths?: string[]
}

export interface WorkspaceRecipeWorkspace {
  target?: string
  mode?: "readonly" | "readwrite"
  sourceMode?: SandboxWorkspaceMode
  seed: WorkspaceRecipeWorkspaceSeed
}

export interface SandboxWorkspaceMountRef {
  target: string
  mode: "readonly" | "readwrite"
  sourceMode: SandboxWorkspaceMode
  workspaceRef?: string
  mountRole?: string
  component?: string
  repo?: string
  gitRef?: string
  defaultBranch?: string
  wpContentPath?: string
}

export interface SandboxWorkspaceContract {
  schema: "wp-codebox/sandbox-workspace/v1"
  root: typeof SANDBOX_WORKSPACE_ROOT | (string & {})
  defaultMode: SandboxWorkspaceMode
  mounts: SandboxWorkspaceMountRef[]
  dmc: {
    safeAbilities: string[]
    parentOnlyAbilities: string[]
  }
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
    siteSeeds?: WorkspaceRecipeSiteSeed[]
    stagedFiles?: WorkspaceRecipeStagedFile[]
    inherit?: WorkspaceRecipeInheritanceRequest
    inheritance?: WorkspaceRecipeInheritanceResolution
  }
  workflow: {
    before?: WorkspaceRecipeStep[]
    steps: WorkspaceRecipeStep[]
    after?: WorkspaceRecipeStep[]
  }
  artifacts?: {
    directory?: string
    verify?: boolean | WorkspaceRecipeArtifactVerifier
    workspacePolicy?: boolean | WorkspaceRecipeWorkspacePolicyArtifact
  }
}

export interface WorkspaceRecipeArtifactVerifier {
  enabled?: boolean
  strict?: boolean
}

export interface WorkspaceRecipeWorkspacePolicyArtifact {
  enabled?: boolean
  strict?: boolean
  writableRoots?: string[]
  hiddenPaths?: string[]
  gitBacked?: boolean
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
  credentials?: ConnectorCredentialEnvelope
}

export type ConnectorCredentialStatus = "available" | "missing" | "denied"

export interface ConnectorCredentialSecret {
  name: string
  status: ConnectorCredentialStatus
  scope?: string
  source?: "parent-env" | "connector" | (string & {})
  reason?: string
}

export interface ConnectorCredentialEnvelope {
  schema: "wp-codebox/connector-credentials/v1"
  connector: string
  scope: "connector"
  status: ConnectorCredentialStatus
  secrets: ConnectorCredentialSecret[]
  reason?: string
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

export type RuntimeEpisodeActionKind = "command" | "filesystem" | "http" | "browser"

export interface RuntimeEpisodeActionSpec extends ExecutionSpec {
  kind?: RuntimeEpisodeActionKind
  method?: string
  url?: string
  path?: string
  operation?: string
  selector?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface RuntimeEpisodeContentDigest {
  algorithm: "sha256"
  value: string
}

export interface RuntimeEpisodeTraceRef {
  kind: "action" | "execution" | "observation" | "snapshot" | "artifact-bundle" | (string & {})
  id: string
  digest?: RuntimeEpisodeContentDigest
  artifactId?: string
  path?: string
}

export interface RuntimeEpisodeActionRecord {
  schema: typeof RUNTIME_EPISODE_ACTION_SCHEMA
  id: string
  kind: RuntimeEpisodeActionKind
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
  method?: string
  url?: string
  path?: string
  operation?: string
  selector?: string
  description?: string
  metadata?: Record<string, unknown>
  digest: RuntimeEpisodeContentDigest
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
  type:
    | "runtime-info"
    | "mounts"
    | "files"
    | "command-result"
    | "wordpress-state"
    | "http-response"
    | "browser-result"
    | "runtime-events"
    | "runtime-logs"
    | (string & {})
  path?: string
  commandId?: string
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  includeBody?: boolean
}

export interface ObservationResult {
  schema?: typeof RUNTIME_EPISODE_OBSERVATION_SCHEMA
  id?: string
  type: string
  data: unknown
  observedAt: string
  artifactRefs?: RuntimeEpisodeTraceRef[]
  digest?: RuntimeEpisodeContentDigest
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
  schema?: typeof RUNTIME_EPISODE_SNAPSHOT_SCHEMA
  id: string
  createdAt: string
  semantics?: "metadata-only" | "runtime-state-artifact" | (string & {})
  metadata: Record<string, unknown>
  artifactRefs?: RuntimeEpisodeTraceRef[]
  digest?: RuntimeEpisodeContentDigest
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
  sha256: ArtifactFileDigest
}

export interface ArtifactFileDigest {
  algorithm: "sha256"
  value: string
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

export type RuntimeSnapshotReplayStatus = "metadata-only" | "runtime-state-artifact" | "not-replayable" | (string & {})

export interface RuntimeReferenceManifestFileRef {
  path: string
  kind: string
  contentType: string
  sha256: ArtifactFileDigest
}

export interface RuntimeReferenceManifestArtifactBundleRef {
  kind: "artifact-bundle"
  id: string
  digest: ArtifactFileDigest
}

export interface RuntimeReferenceManifestSnapshotRef {
  id: string
  semantics: string
  digest: RuntimeEpisodeContentDigest
  replay: {
    status: RuntimeSnapshotReplayStatus
    limitations: string[]
  }
  artifactRefs: RuntimeEpisodeTraceRef[]
}

export interface RuntimeReferenceManifest {
  schema: typeof RUNTIME_REFERENCE_MANIFEST_SCHEMA
  version: 1
  id: string
  createdAt: string
  digest: RuntimeEpisodeContentDigest
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  files: RuntimeReferenceManifestFileRef[]
  trace?: RuntimeReferenceManifestFileRef
  events?: RuntimeReferenceManifestFileRef
  snapshots: RuntimeReferenceManifestSnapshotRef[]
}

export interface BuildRuntimeReferenceManifestInput {
  createdAt: string
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  files: RuntimeReferenceManifestFileRef[]
  trace?: RuntimeReferenceManifestFileRef
  events?: RuntimeReferenceManifestFileRef
  snapshots?: Snapshot[]
}

export interface ArtifactProvenance {
  task?: Record<string, unknown>
  workspace?: SandboxWorkspaceContract
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
    runtimeEpisodeTrace?: string
    runtimeReferenceManifest?: string
    agentResult?: string
    transcript?: string
  }
  browser?: ArtifactReviewBrowserSummary
  redaction?: ArtifactRedactionSummary
  riskFlags: string[]
}

export interface ArtifactReviewBrowserSummary {
  summary: string
  probes: Array<{
    url: string
    requestedUrl?: string
    finalUrl?: string
    viewport?: {
      width: number
      height: number
      deviceScaleFactor: number
      isMobile: boolean
      hasTouch: boolean
      userAgent: string
    } | null
    replayability?: "artifact-backed" | "partial" | "diagnostic-only"
    consoleMessages: number
    errors: number
    html?: string
    network?: string
    networkEvents?: number
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
  runAttestationPath?: string
  runtimeEpisodeTracePath?: string
  runtimeEpisodeEventsPath?: string
  artifactVerificationPath?: string
  workspacePolicyPath?: string
  runtimeReferenceManifestPath?: string
  preview?: ArtifactPreview
  contentDigest: string
  createdAt: string
}

export type ArtifactBundleVerificationViolationCode =
  | "missing-manifest"
  | "malformed-manifest"
  | "invalid-manifest-shape"
  | "invalid-path"
  | "missing-file"
  | "orphaned-file"
  | "digest-mismatch"
  | "missing-file-hash"
  | "file-hash-mismatch"
  | "bundle-id-mismatch"
  | "malformed-reference"
  | "review-evidence-mismatch"
  | "unsafe-file"
  | "hardlink"

export interface ArtifactBundleVerificationViolation {
  code: ArtifactBundleVerificationViolationCode
  path: string
  message: string
  file?: string
  details?: Record<string, unknown>
}

export interface ArtifactBundleVerificationResult {
  schema: "wp-codebox/artifact-bundle-verification/v1"
  bundleDirectory: string
  valid: boolean
  violations: ArtifactBundleVerificationViolation[]
  manifest?: ArtifactManifest
}

export interface VerifyArtifactBundleOptions {
  manifestFileName?: string
  allowOrphanedFiles?: boolean
}

export async function verifyArtifactBundle(directory: string, options: VerifyArtifactBundleOptions = {}): Promise<ArtifactBundleVerificationResult> {
  const bundleDirectory = normalize(directory)
  const manifestFileName = options.manifestFileName ?? "manifest.json"
  const manifestPath = join(bundleDirectory, manifestFileName)
  const violations: ArtifactBundleVerificationViolation[] = []
  let manifest: ArtifactManifest | undefined

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactManifest
  } catch (error) {
    violations.push({
      code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing-manifest" : "malformed-manifest",
      path: manifestFileName,
      message: (error as NodeJS.ErrnoException).code === "ENOENT" ? "manifest.json is missing." : "manifest.json is not valid JSON.",
    })
    return artifactBundleVerificationResult(bundleDirectory, violations)
  }

  if (!isArtifactManifestShape(manifest)) {
    violations.push({
      code: "invalid-manifest-shape",
      path: manifestFileName,
      message: "manifest.json does not match the WP Codebox artifact manifest shape.",
    })
    return artifactBundleVerificationResult(bundleDirectory, violations)
  }

  const manifestFiles = new Set<string>()
  for (const [index, file] of manifest.files.entries()) {
    const fieldPath = `manifest.files[${index}].path`
    const pathViolation = artifactPathViolation(file.path, fieldPath)
    if (pathViolation) {
      violations.push(pathViolation)
      continue
    }

    if (manifestFiles.has(file.path)) {
      violations.push({ code: "invalid-manifest-shape", path: fieldPath, file: file.path, message: `Manifest file path is duplicated: ${file.path}` })
    }
    manifestFiles.add(file.path)
    try {
      await verifyBundleFileTopology(bundleDirectory, file.path, fieldPath, violations)
    } catch {
      violations.push({ code: "missing-file", path: fieldPath, file: file.path, message: `Manifest file is missing: ${file.path}` })
    }
  }

  if (!manifestFiles.has(manifestFileName)) {
    violations.push({
      code: "invalid-manifest-shape",
      path: "manifest.files",
      file: manifestFileName,
      message: "manifest.json must list itself in manifest.files.",
    })
  }

  if (!options.allowOrphanedFiles) {
    for (const file of await listBundleFiles(bundleDirectory)) {
      if (!manifestFiles.has(file)) {
        violations.push({ code: "orphaned-file", path: file, file, message: `Bundle file is not listed in manifest.json: ${file}` })
      }
    }
  }

  await verifyManifestFileHashes(bundleDirectory, manifest, manifestFileName, violations)
  await verifyContentDigest(bundleDirectory, manifest, manifestFiles, violations)
  verifyBundleId(manifest, violations)
  await verifyMetadataReferences(bundleDirectory, manifestFiles, violations)
  await verifyReviewEvidence(bundleDirectory, manifest, manifestFiles, violations)
  await verifyRuntimeEpisodeTraceArtifacts(bundleDirectory, manifest, violations)
  await verifyRuntimeReferenceManifestArtifacts(bundleDirectory, manifest, manifestFiles, violations)

  return artifactBundleVerificationResult(bundleDirectory, violations, manifest)
}

export async function calculateArtifactContentDigest(directory: string, inputs: string[]): Promise<string> {
  const hash = createHash("sha256").update("wp-codebox/artifact-content/v1\n")
  for (const [index, input] of inputs.entries()) {
    if (index > 0) {
      hash.update("\n")
    }
    hash.update(`${input}\n`)
    hash.update(await readFile(join(directory, input)))
  }

  return hash.digest("hex")
}

export async function calculateArtifactManifestFileSha256(directory: string, manifest: ArtifactManifest, file: ArtifactManifestFile, manifestFileName = "manifest.json"): Promise<string> {
  if (file.path === manifestFileName) {
    return calculateArtifactManifestSelfSha256(manifest, manifestFileName)
  }

  return createHash("sha256").update(await readFile(join(directory, file.path))).digest("hex")
}

async function verifyBundleFileTopology(directory: string, path: string, fieldPath: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  const absolutePath = join(directory, path)
  const fileStat = await lstat(absolutePath)
  if (!fileStat.isFile()) {
    violations.push({ code: "missing-file", path: fieldPath, file: path, message: `Manifest path is not a regular file: ${path}` })
    return
  }

  if (typeof fileStat.nlink !== "number" || !Number.isFinite(fileStat.nlink)) {
    violations.push({ code: "hardlink", path: fieldPath, file: path, message: `Unable to determine artifact file link count: ${path}`, details: { linkCountAvailable: false } })
  } else if (fileStat.nlink > 1) {
    violations.push({ code: "hardlink", path: fieldPath, file: path, message: `Artifact file must not be hard linked: ${path}`, details: { links: fileStat.nlink } })
  }

  try {
    const [bundleRealpath, fileRealpath] = await Promise.all([realpath(directory), realpath(absolutePath)])
    const realRelative = relative(bundleRealpath, fileRealpath)
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      violations.push({ code: "unsafe-file", path: fieldPath, file: path, message: `Artifact file resolves outside the bundle directory: ${path}` })
    }
  } catch (error) {
    violations.push({ code: "unsafe-file", path: fieldPath, file: path, message: `Unable to prove artifact file stays inside the bundle directory: ${errorMessage(error)}` })
  }
}

export function calculateArtifactManifestSelfSha256(manifest: ArtifactManifest, manifestFileName = "manifest.json"): string {
  return createHash("sha256")
    .update("wp-codebox/artifact-manifest-self/v1\n")
    .update(stableJson(manifestWithPlaceholderSelfHash(manifest, manifestFileName)))
    .digest("hex")
}

function manifestWithPlaceholderSelfHash(manifest: ArtifactManifest, manifestFileName: string): ArtifactManifest {
  return {
    ...manifest,
    files: manifest.files.map((file) => file.path === manifestFileName
      ? { ...file, sha256: { algorithm: "sha256", value: "0".repeat(64) } }
      : file),
  }
}

async function verifyManifestFileHashes(directory: string, manifest: ArtifactManifest, manifestFileName: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const [index, file] of manifest.files.entries()) {
    if (artifactPathViolation(file.path, `manifest.files[${index}].path`)) {
      continue
    }

    const fieldPath = `manifest.files[${index}].sha256`
    if (!isArtifactFileDigestShape(file.sha256)) {
      violations.push({ code: "missing-file-hash", path: fieldPath, file: file.path, message: `Manifest file entry must include a lowercase SHA-256 digest: ${file.path}` })
      continue
    }

    try {
      const value = await calculateArtifactManifestFileSha256(directory, manifest, file, manifestFileName)
      if (value !== file.sha256.value) {
        violations.push({ code: "file-hash-mismatch", path: fieldPath, file: file.path, message: `Manifest file hash does not match ${file.path}: expected ${value}, got ${file.sha256.value}` })
      }
    } catch (error) {
      violations.push({ code: "file-hash-mismatch", path: fieldPath, file: file.path, message: `Unable to hash manifest file entry ${file.path}: ${errorMessage(error)}` })
    }
  }
}

function artifactBundleVerificationResult(bundleDirectory: string, violations: ArtifactBundleVerificationViolation[], manifest?: ArtifactManifest): ArtifactBundleVerificationResult {
  return {
    schema: "wp-codebox/artifact-bundle-verification/v1",
    bundleDirectory,
    valid: violations.length === 0,
    violations,
    ...(manifest ? { manifest } : {}),
  }
}

function isArtifactManifestShape(value: unknown): value is ArtifactManifest {
  if (!isRecord(value)) {
    return false
  }

  const contentDigest = value.contentDigest
  return typeof value.id === "string"
    && typeof value.createdAt === "string"
    && isRecord(value.runtime)
    && isRecord(contentDigest)
    && contentDigest.algorithm === "sha256"
    && Array.isArray(contentDigest.inputs)
    && contentDigest.inputs.every((input) => typeof input === "string")
    && typeof contentDigest.value === "string"
    && Array.isArray(value.files)
    && value.files.every(isArtifactManifestFileShape)
}

function isArtifactManifestFileShape(value: unknown): value is ArtifactManifestFile {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.kind === "string"
    && typeof value.contentType === "string"
}

function isRuntimeReferenceManifestShape(value: unknown): value is RuntimeReferenceManifest {
  if (!isRecord(value)) {
    return false
  }

  return value.schema === RUNTIME_REFERENCE_MANIFEST_SCHEMA
    && value.version === 1
    && typeof value.id === "string"
    && typeof value.createdAt === "string"
    && isArtifactFileDigestShape(value.digest)
    && isRecord(value.runtime)
    && isRuntimeReferenceManifestArtifactBundleRefShape(value.artifactBundle)
    && Array.isArray(value.files)
    && value.files.every(isRuntimeReferenceManifestFileRefShape)
    && (value.trace === undefined || isRuntimeReferenceManifestFileRefShape(value.trace))
    && (value.events === undefined || isRuntimeReferenceManifestFileRefShape(value.events))
    && Array.isArray(value.snapshots)
    && value.snapshots.every(isRuntimeReferenceManifestSnapshotRefShape)
}

function isRuntimeReferenceManifestArtifactBundleRefShape(value: unknown): value is RuntimeReferenceManifestArtifactBundleRef {
  return isRecord(value)
    && value.kind === "artifact-bundle"
    && typeof value.id === "string"
    && isArtifactFileDigestShape(value.digest)
}

function isRuntimeReferenceManifestFileRefShape(value: unknown): value is RuntimeReferenceManifestFileRef {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.kind === "string"
    && typeof value.contentType === "string"
    && isArtifactFileDigestShape(value.sha256)
}

function isRuntimeReferenceManifestSnapshotRefShape(value: unknown): value is RuntimeReferenceManifestSnapshotRef {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.semantics === "string"
    && validDigest(value.digest)
    && isRecord(value.replay)
    && typeof value.replay.status === "string"
    && Array.isArray(value.replay.limitations)
    && value.replay.limitations.every((limitation) => typeof limitation === "string")
    && Array.isArray(value.artifactRefs)
}

function isArtifactFileDigestShape(value: unknown): value is ArtifactFileDigest {
  return isRecord(value)
    && value.algorithm === "sha256"
    && typeof value.value === "string"
    && /^[a-f0-9]{64}$/.test(value.value)
}

function artifactPathViolation(path: string, fieldPath: string): ArtifactBundleVerificationViolation | undefined {
  if (path.length === 0) {
    return { code: "invalid-path", path: fieldPath, file: path, message: "Artifact paths must not be empty." }
  }

  if (path.includes("\\") || isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    return { code: "invalid-path", path: fieldPath, file: path, message: `Artifact path must be bundle-relative and local: ${path}` }
  }

  const normalized = normalize(path).split(sep).join("/")
  if (normalized === ".." || normalized.startsWith("../") || path.split("/").includes("..")) {
    return { code: "invalid-path", path: fieldPath, file: path, message: `Artifact path must not contain traversal: ${path}` }
  }

  return undefined
}

async function verifyContentDigest(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const [index, input] of manifest.contentDigest.inputs.entries()) {
    const pathViolation = artifactPathViolation(input, `manifest.contentDigest.inputs[${index}]`)
    if (pathViolation) {
      violations.push(pathViolation)
      return
    }
    if (!manifestFiles.has(input)) {
      violations.push({ code: "malformed-reference", path: `manifest.contentDigest.inputs[${index}]`, file: input, message: `contentDigest input is not listed in manifest.json: ${input}` })
      return
    }
  }

  if (!/^[a-f0-9]{64}$/.test(manifest.contentDigest.value)) {
    violations.push({ code: "invalid-manifest-shape", path: "manifest.contentDigest.value", message: "contentDigest.value must be a lowercase sha256 hex digest." })
    return
  }

  try {
    const value = await calculateArtifactContentDigest(directory, manifest.contentDigest.inputs)
    if (value !== manifest.contentDigest.value) {
      violations.push({
        code: "digest-mismatch",
        path: "manifest.contentDigest.value",
        message: `contentDigest.value does not match declared inputs: expected ${value}, got ${manifest.contentDigest.value}`,
      })
    }
  } catch (error) {
    violations.push({ code: "digest-mismatch", path: "manifest.contentDigest.inputs", message: `Unable to calculate content digest: ${errorMessage(error)}` })
  }
}

function verifyBundleId(manifest: ArtifactManifest, violations: ArtifactBundleVerificationViolation[]): void {
  const prefix = "artifact-bundle-sha256-"
  if (manifest.id.startsWith(prefix) && manifest.id !== `${prefix}${manifest.contentDigest.value}`) {
    violations.push({
      code: "bundle-id-mismatch",
      path: "manifest.id",
      message: `Bundle id must match content digest: expected ${prefix}${manifest.contentDigest.value}, got ${manifest.id}`,
    })
  }
}

async function verifyMetadataReferences(directory: string, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
  } catch {
    return
  }

  const artifacts = isRecord(metadata) ? metadata.artifacts : undefined
  if (!isRecord(artifacts)) {
    return
  }

  for (const [key, value] of Object.entries(artifacts)) {
    for (const reference of artifactReferenceStrings(value)) {
      validateArtifactReference(reference, `metadata.artifacts.${key}`, manifestFiles, violations)
    }
  }
}

async function verifyReviewEvidence(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  let review: unknown
  try {
    review = JSON.parse(await readFile(join(directory, "files/review.json"), "utf8"))
  } catch {
    return
  }

  if (!isRecord(review) || !isRecord(review.evidence)) {
    violations.push({ code: "malformed-reference", path: "files/review.json", file: "files/review.json", message: "Review artifact does not include an evidence object." })
    return
  }

  const evidence = review.evidence
  if (typeof evidence.artifactContentDigest === "string" && evidence.artifactContentDigest !== manifest.contentDigest.value) {
    violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.artifactContentDigest", file: "files/review.json", message: "Review artifact content digest does not match manifest contentDigest.value." })
  }

  if (typeof evidence.patch === "string") {
    validateArtifactReference(evidence.patch, "files/review.json:evidence.patch", manifestFiles, violations)
    if (typeof evidence.patchSha256 === "string") {
      try {
        const patchSha256 = createHash("sha256").update(await readFile(join(directory, evidence.patch))).digest("hex")
        if (patchSha256 !== evidence.patchSha256) {
          violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.patchSha256", file: "files/review.json", message: "Review patchSha256 does not match the referenced patch file." })
        }
      } catch (error) {
        violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.patchSha256", file: evidence.patch, message: `Unable to hash review patch evidence: ${errorMessage(error)}` })
      }
    }
  }

  if (typeof evidence.changedFiles === "string") {
    validateArtifactReference(evidence.changedFiles, "files/review.json:evidence.changedFiles", manifestFiles, violations)
    await verifyChangedFileEvidence(directory, evidence.changedFiles, review, violations)
  }

  if (typeof evidence.runtimeEpisodeTrace === "string") {
    validateArtifactReference(evidence.runtimeEpisodeTrace, "files/review.json:evidence.runtimeEpisodeTrace", manifestFiles, violations)
  }

  if (typeof evidence.runtimeReferenceManifest === "string") {
    validateArtifactReference(evidence.runtimeReferenceManifest, "files/review.json:evidence.runtimeReferenceManifest", manifestFiles, violations)
  }
}

async function verifyRuntimeEpisodeTraceArtifacts(directory: string, manifest: ArtifactManifest, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const file of manifest.files) {
    if (file.kind !== "runtime-episode-trace") {
      continue
    }

    try {
      const trace = JSON.parse(await readFile(join(directory, file.path), "utf8"))
      const validation = validateRuntimeEpisodeTrace(trace)
      if (!validation.valid) {
        violations.push({
          code: "malformed-reference",
          path: file.path,
          file: file.path,
          message: `Runtime episode trace is invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
        })
      }
    } catch (error) {
      violations.push({
        code: "malformed-reference",
        path: file.path,
        file: file.path,
        message: `Runtime episode trace is not valid JSON: ${errorMessage(error)}`,
      })
    }
  }
}

async function verifyRuntimeReferenceManifestArtifacts(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const file of manifest.files) {
    if (file.kind !== "runtime-reference-manifest") {
      continue
    }

    let referenceManifest: unknown
    try {
      referenceManifest = JSON.parse(await readFile(join(directory, file.path), "utf8"))
    } catch (error) {
      violations.push({
        code: "malformed-reference",
        path: file.path,
        file: file.path,
        message: `Runtime reference manifest is not valid JSON: ${errorMessage(error)}`,
      })
      continue
    }

    if (!isRuntimeReferenceManifestShape(referenceManifest)) {
      violations.push({ code: "malformed-reference", path: file.path, file: file.path, message: "Runtime reference manifest does not match wp-codebox/runtime-reference-manifest/v1." })
      continue
    }

    const expectedDigest = runtimeReferenceManifestDigest(referenceManifest)
    if (referenceManifest.digest.value !== expectedDigest.value) {
      violations.push({ code: "digest-mismatch", path: `${file.path}:digest`, file: file.path, message: `Runtime reference manifest digest does not match declared refs: expected ${expectedDigest.value}, got ${referenceManifest.digest.value}` })
    }

    const expectedId = `runtime-reference-manifest-sha256-${referenceManifest.digest.value}`
    if (referenceManifest.id !== expectedId) {
      violations.push({ code: "bundle-id-mismatch", path: `${file.path}:id`, file: file.path, message: `Runtime reference manifest id must match its digest: expected ${expectedId}, got ${referenceManifest.id}` })
    }

    if (referenceManifest.artifactBundle.id !== manifest.id || referenceManifest.artifactBundle.digest.value !== manifest.contentDigest.value) {
      violations.push({ code: "review-evidence-mismatch", path: `${file.path}:artifactBundle`, file: file.path, message: "Runtime reference manifest artifactBundle ref must match manifest id and contentDigest." })
    }

    for (const [index, referencedFile] of referenceManifest.files.entries()) {
      validateArtifactReference(referencedFile.path, `${file.path}:files[${index}].path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referencedFile, `${file.path}:files[${index}].sha256`, violations)
    }

    if (referenceManifest.trace) {
      validateArtifactReference(referenceManifest.trace.path, `${file.path}:trace.path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referenceManifest.trace, `${file.path}:trace.sha256`, violations)
    }

    if (referenceManifest.events) {
      validateArtifactReference(referenceManifest.events.path, `${file.path}:events.path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referenceManifest.events, `${file.path}:events.sha256`, violations)
    }
  }
}

async function verifyReferencedFileDigest(directory: string, file: RuntimeReferenceManifestFileRef, path: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  if (!isArtifactFileDigestShape(file.sha256)) {
    violations.push({ code: "missing-file-hash", path, file: file.path, message: `Runtime reference manifest file ref must include a lowercase SHA-256 digest: ${file.path}` })
    return
  }

  try {
    const value = createHash("sha256").update(await readFile(join(directory, file.path))).digest("hex")
    if (value !== file.sha256.value) {
      violations.push({ code: "file-hash-mismatch", path, file: file.path, message: `Runtime reference manifest file ref hash does not match ${file.path}: expected ${value}, got ${file.sha256.value}` })
    }
  } catch (error) {
    violations.push({ code: "file-hash-mismatch", path, file: file.path, message: `Unable to hash runtime reference file ${file.path}: ${errorMessage(error)}` })
  }
}

async function verifyChangedFileEvidence(directory: string, changedFilesPath: string, review: Record<string, unknown>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  try {
    const changedFiles = JSON.parse(await readFile(join(directory, changedFilesPath), "utf8"))
    const changedFileList = isRecord(changedFiles) && Array.isArray(changedFiles.files) ? changedFiles.files : undefined
    const reviewChangedFiles = Array.isArray(review.changedFiles) ? review.changedFiles : undefined
    if (!changedFileList || !reviewChangedFiles) {
      return
    }

    const changedFileKeys = new Set(changedFileList.filter(isRecord).map((file) => `${file.path}:${file.status}`))
    for (const file of reviewChangedFiles.filter(isRecord)) {
      if (!changedFileKeys.has(`${file.path}:${file.status}`)) {
        violations.push({ code: "review-evidence-mismatch", path: "files/review.json:changedFiles", file: "files/review.json", message: `Review changed-file evidence is not present in ${changedFilesPath}: ${String(file.path)}` })
      }
    }
  } catch (error) {
    violations.push({ code: "review-evidence-mismatch", path: "files/review.json:evidence.changedFiles", file: changedFilesPath, message: `Unable to read changed-file evidence: ${errorMessage(error)}` })
  }
}

function validateArtifactReference(reference: string, fieldPath: string, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): void {
  const pathViolation = artifactPathViolation(reference, fieldPath)
  if (pathViolation) {
    violations.push(pathViolation)
    return
  }

  if (!manifestFiles.has(reference)) {
    violations.push({ code: "malformed-reference", path: fieldPath, file: reference, message: `Artifact reference is not listed in manifest.json: ${reference}` })
  }
}

function artifactReferenceStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
  }

  return []
}

async function listBundleFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await listBundleFiles(directory, path))
    } else {
      files.push(path)
    }
  }

  return files.sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  id: string
  runtime: RuntimeInfo
  observations: ObservationResult[]
  observationRefs: RuntimeEpisodeTraceRef[]
}

export interface RuntimeEpisodeStepResult {
  id: string
  index: number
  action: RuntimeEpisodeActionRecord
  actionRef: RuntimeEpisodeTraceRef
  execution: ExecutionResult
  executionRef: RuntimeEpisodeTraceRef
  observation?: ObservationResult
  observationRef?: RuntimeEpisodeTraceRef
}

export interface RuntimeEpisodeTrace {
  schema: typeof RUNTIME_EPISODE_TRACE_SCHEMA
  version: 1
  id: string
  createdAt: string
  runtime: RuntimeInfo
  reset: RuntimeEpisodeResetResult
  steps: RuntimeEpisodeStepResult[]
  snapshots: Snapshot[]
  artifacts?: ArtifactBundle
  artifactRef?: RuntimeEpisodeTraceRef
}

export interface RuntimeEpisodeTraceValidationIssue {
  path: string
  message: string
}

export interface RuntimeEpisodeTraceValidationResult {
  valid: boolean
  schema: typeof RUNTIME_EPISODE_TRACE_SCHEMA
  issues: RuntimeEpisodeTraceValidationIssue[]
}

export interface RuntimeEpisode {
  reset(): Promise<RuntimeEpisodeResetResult>
  step(action: RuntimeEpisodeActionSpec, observation?: ObservationSpec | false): Promise<RuntimeEpisodeStepResult>
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

export function runtimeEpisodeDigest(value: unknown): RuntimeEpisodeContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update("wp-codebox/runtime-episode-trace/v1\n").update(stableJson(value)).digest("hex"),
  }
}

export function buildRuntimeReferenceManifest(input: BuildRuntimeReferenceManifestInput): RuntimeReferenceManifest {
  const manifest = {
    schema: RUNTIME_REFERENCE_MANIFEST_SCHEMA,
    version: 1 as const,
    id: "runtime-reference-manifest-pending",
    createdAt: input.createdAt,
    digest: { algorithm: "sha256" as const, value: "0".repeat(64) },
    runtime: input.runtime,
    artifactBundle: input.artifactBundle,
    files: input.files.map(runtimeReferenceManifestFileRef).sort((left, right) => left.path.localeCompare(right.path)),
    ...(input.trace ? { trace: runtimeReferenceManifestFileRef(input.trace) } : {}),
    ...(input.events ? { events: runtimeReferenceManifestFileRef(input.events) } : {}),
    snapshots: (input.snapshots ?? []).map(runtimeReferenceManifestSnapshotRef),
  }
  const digest = runtimeReferenceManifestDigest(manifest)

  return {
    ...manifest,
    id: `runtime-reference-manifest-sha256-${digest.value}`,
    digest,
  }
}

export function runtimeReferenceManifestDigest(manifest: RuntimeReferenceManifest): RuntimeEpisodeContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256")
      .update("wp-codebox/runtime-reference-manifest/v1\n")
      .update(stableJson(runtimeReferenceManifestDigestPayload(manifest)))
      .digest("hex"),
  }
}

function runtimeReferenceManifestDigestPayload(manifest: RuntimeReferenceManifest): Record<string, unknown> {
  return {
    schema: manifest.schema,
    version: manifest.version,
    runtime: manifest.runtime,
    artifactBundle: manifest.artifactBundle,
    files: manifest.files,
    ...(manifest.trace ? { trace: manifest.trace } : {}),
    ...(manifest.events ? { events: manifest.events } : {}),
    snapshots: manifest.snapshots,
  }
}

function runtimeReferenceManifestFileRef(file: RuntimeReferenceManifestFileRef): RuntimeReferenceManifestFileRef {
  return {
    path: file.path,
    kind: file.kind,
    contentType: file.contentType,
    sha256: file.sha256,
  }
}

function runtimeReferenceManifestSnapshotRef(snapshot: Snapshot): RuntimeReferenceManifestSnapshotRef {
  const semantics = snapshot.semantics ?? "metadata-only"

  return {
    id: snapshot.id,
    semantics,
    digest: snapshot.digest ?? runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload({ ...snapshot, semantics })),
    replay: runtimeSnapshotReplaySemantics(semantics),
    artifactRefs: [...(snapshot.artifactRefs ?? [])],
  }
}

function runtimeSnapshotReplaySemantics(semantics: string): RuntimeReferenceManifestSnapshotRef["replay"] {
  if (semantics === "runtime-state-artifact") {
    return { status: "runtime-state-artifact", limitations: [] }
  }

  if (semantics === "metadata-only") {
    return {
      status: "metadata-only",
      limitations: [
        "Snapshot records runtime metadata only; it is not a WordPress database or filesystem checkpoint.",
        "Replay consumers must use trace actions and artifact bundle files to reconstruct supported state.",
      ],
    }
  }

  return {
    status: "not-replayable",
    limitations: [`Snapshot semantics are not recognized by this WP Codebox version: ${semantics}`],
  }
}

function runtimeEpisodeActionDigestPayload(action: RuntimeEpisodeActionRecord | RuntimeEpisodeActionSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema: RUNTIME_EPISODE_ACTION_SCHEMA,
    kind: action.kind ?? "command",
    command: action.command,
    args: Array.isArray(action.args) ? action.args : [],
  }

  for (const key of ["cwd", "method", "url", "path", "operation", "selector", "description"] as const) {
    if (typeof action[key] === "string") {
      payload[key] = action[key]
    }
  }
  if (typeof action.timeoutMs === "number") {
    payload.timeoutMs = action.timeoutMs
  }
  if (isRecord(action.metadata)) {
    payload.metadata = action.metadata
  }

  return payload
}

function runtimeEpisodeObservationDigestPayload(observation: ObservationResult): Record<string, unknown> {
  return {
    schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
    type: observation.type,
    data: observation.data,
    observedAt: observation.observedAt,
    artifactRefs: observation.artifactRefs ?? [],
  }
}

function runtimeEpisodeSnapshotDigestPayload(snapshot: Snapshot): Record<string, unknown> {
  return {
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    semantics: snapshot.semantics,
    metadata: snapshot.metadata,
    artifactRefs: snapshot.artifactRefs ?? [],
  }
}

export function validateRuntimeEpisodeTrace(trace: unknown): RuntimeEpisodeTraceValidationResult {
  const issues: RuntimeEpisodeTraceValidationIssue[] = []
  const candidate = trace as Partial<RuntimeEpisodeTrace> | null

  if (!candidate || typeof candidate !== "object") {
    return { valid: false, schema: RUNTIME_EPISODE_TRACE_SCHEMA, issues: [{ path: "$", message: "trace must be an object" }] }
  }

  if (candidate.schema !== RUNTIME_EPISODE_TRACE_SCHEMA) {
    issues.push({ path: "$.schema", message: `schema must be ${RUNTIME_EPISODE_TRACE_SCHEMA}` })
  }
  if (candidate.version !== 1) {
    issues.push({ path: "$.version", message: "version must be 1" })
  }
  if (!nonEmptyString(candidate.id)) {
    issues.push({ path: "$.id", message: "id must be a non-empty string" })
  }
  if (!nonEmptyString(candidate.createdAt)) {
    issues.push({ path: "$.createdAt", message: "createdAt must be a non-empty string" })
  }
  if (!candidate.runtime || typeof candidate.runtime !== "object" || !nonEmptyString(candidate.runtime.id)) {
    issues.push({ path: "$.runtime.id", message: "runtime id is required" })
  }
  if (!candidate.reset || typeof candidate.reset !== "object" || !nonEmptyString(candidate.reset.id)) {
    issues.push({ path: "$.reset.id", message: "reset id is required" })
  }
  if (!Array.isArray(candidate.reset?.observations)) {
    issues.push({ path: "$.reset.observations", message: "reset observations must be an array" })
  } else {
    candidate.reset.observations.forEach((observation, index) => {
      validateRuntimeEpisodeObservation(observation, `$.reset.observations[${index}]`, issues)
    })
  }
  if (!Array.isArray(candidate.reset?.observationRefs)) {
    issues.push({ path: "$.reset.observationRefs", message: "reset observationRefs must be an array" })
  } else {
    candidate.reset.observationRefs.forEach((ref, index) => {
      validateRuntimeEpisodeTraceRef(ref, `$.reset.observationRefs[${index}]`, "observation", issues)
      const observation = candidate.reset?.observations?.[index]
      if (observation) {
        validateRuntimeEpisodeRefDigest(ref, observation.digest, `$.reset.observationRefs[${index}]`, issues)
      }
    })
  }
  if (!Array.isArray(candidate.steps)) {
    issues.push({ path: "$.steps", message: "steps must be an array" })
  } else {
    candidate.steps.forEach((step, index) => validateRuntimeEpisodeStep(step, index, issues))
  }
  if (!Array.isArray(candidate.snapshots)) {
    issues.push({ path: "$.snapshots", message: "snapshots must be an array" })
  } else {
    candidate.snapshots.forEach((snapshot, index) => validateRuntimeEpisodeSnapshot(snapshot, `$.snapshots[${index}]`, issues))
  }

  collectForbiddenRuntimeEpisodeTraceFields(candidate, "$", issues)

  return { valid: issues.length === 0, schema: RUNTIME_EPISODE_TRACE_SCHEMA, issues }
}

function validateRuntimeEpisodeStep(
  step: RuntimeEpisodeStepResult,
  index: number,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  const path = `$.steps[${index}]`
  if (!nonEmptyString(step.id)) {
    issues.push({ path: `${path}.id`, message: "step id is required" })
  }
  if (step.index !== index) {
    issues.push({ path: `${path}.index`, message: "step index must match array position" })
  }
  if (!nonEmptyString(step.action?.id)) {
    issues.push({ path: `${path}.action.id`, message: "action id is required" })
  } else {
    validateRuntimeEpisodeAction(step.action, `${path}.action`, issues)
  }
  if (!nonEmptyString(step.actionRef?.id)) {
    issues.push({ path: `${path}.actionRef.id`, message: "actionRef id is required" })
  } else {
    validateRuntimeEpisodeTraceRef(step.actionRef, `${path}.actionRef`, "action", issues)
    validateRuntimeEpisodeRefDigest(step.actionRef, step.action?.digest, `${path}.actionRef`, issues)
  }
  if (!nonEmptyString(step.execution?.id)) {
    issues.push({ path: `${path}.execution.id`, message: "execution id is required" })
  }
  if (!nonEmptyString(step.executionRef?.id)) {
    issues.push({ path: `${path}.executionRef.id`, message: "executionRef id is required" })
  } else {
    validateRuntimeEpisodeTraceRef(step.executionRef, `${path}.executionRef`, "execution", issues)
    validateRuntimeEpisodeRefDigest(step.executionRef, step.execution ? runtimeEpisodeDigest(step.execution) : undefined, `${path}.executionRef`, issues)
  }
  if (step.observation && !nonEmptyString(step.observation.id)) {
    issues.push({ path: `${path}.observation.id`, message: "observation id is required" })
  } else if (step.observation) {
    validateRuntimeEpisodeObservation(step.observation, `${path}.observation`, issues)
  }
  if (step.observationRef) {
    validateRuntimeEpisodeTraceRef(step.observationRef, `${path}.observationRef`, "observation", issues)
    if (step.observation) {
      validateRuntimeEpisodeRefDigest(step.observationRef, step.observation.digest, `${path}.observationRef`, issues)
    }
  }
}

function validateRuntimeEpisodeAction(
  action: RuntimeEpisodeActionRecord | unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(action)) {
    issues.push({ path, message: "action must be an object" })
    return
  }

  if (action.schema !== RUNTIME_EPISODE_ACTION_SCHEMA) {
    issues.push({ path: `${path}.schema`, message: `action schema must be ${RUNTIME_EPISODE_ACTION_SCHEMA}` })
  }
  if (!["command", "filesystem", "http", "browser"].includes(`${action.kind}`)) {
    issues.push({ path: `${path}.kind`, message: "action kind must be command, filesystem, http, or browser" })
  }
  if (!nonEmptyString(action.command)) {
    issues.push({ path: `${path}.command`, message: "action command is required" })
  }
  if (!Array.isArray(action.args) || !action.args.every((arg) => typeof arg === "string")) {
    issues.push({ path: `${path}.args`, message: "action args must be an array of strings" })
  }
  if (action.cwd !== undefined && typeof action.cwd !== "string") {
    issues.push({ path: `${path}.cwd`, message: "action cwd must be a string when present" })
  }
  for (const key of ["method", "url", "path", "operation", "selector", "description"] as const) {
    if (action[key] !== undefined && !nonEmptyString(action[key])) {
      issues.push({ path: `${path}.${key}`, message: `action ${key} must be a non-empty string when present` })
    }
  }
  if (action.metadata !== undefined && !isRecord(action.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "action metadata must be an object when present" })
  }
  const timeoutMs = action.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    issues.push({ path: `${path}.timeoutMs`, message: "action timeoutMs must be a non-negative number when present" })
  }
  if (!validDigest(action.digest)) {
    issues.push({ path: `${path}.digest`, message: "action digest must be a sha256 digest" })
    return
  }

  const expected = runtimeEpisodeDigest(runtimeEpisodeActionDigestPayload(action as unknown as RuntimeEpisodeActionRecord))
  if (action.digest.value !== expected.value) {
    issues.push({ path: `${path}.digest`, message: "action digest must match the canonical replay payload" })
  }
}

function validateRuntimeEpisodeObservation(
  observation: ObservationResult | unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(observation)) {
    issues.push({ path, message: "observation must be an object" })
    return
  }

  if (observation.schema !== RUNTIME_EPISODE_OBSERVATION_SCHEMA) {
    issues.push({ path: `${path}.schema`, message: `observation schema must be ${RUNTIME_EPISODE_OBSERVATION_SCHEMA}` })
  }
  if (!nonEmptyString(observation.id)) {
    issues.push({ path: `${path}.id`, message: "observation id is required" })
  }
  if (!nonEmptyString(observation.type)) {
    issues.push({ path: `${path}.type`, message: "observation type is required" })
  }
  if (!("data" in observation)) {
    issues.push({ path: `${path}.data`, message: "observation data is required" })
  }
  if (!nonEmptyString(observation.observedAt)) {
    issues.push({ path: `${path}.observedAt`, message: "observation observedAt is required" })
  }
  if (!validDigest(observation.digest)) {
    issues.push({ path: `${path}.digest`, message: "observation digest must be a sha256 digest" })
    return
  }

  if (observation.artifactRefs !== undefined) {
    if (!Array.isArray(observation.artifactRefs)) {
      issues.push({ path: `${path}.artifactRefs`, message: "observation artifactRefs must be an array when present" })
    } else {
      observation.artifactRefs.forEach((ref, index) => validateRuntimeEpisodeTraceRef(ref, `${path}.artifactRefs[${index}]`, undefined, issues))
    }
  }

  const expected = runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation as unknown as ObservationResult))
  if (observation.digest.value !== expected.value) {
    issues.push({ path: `${path}.digest`, message: "observation digest must match the canonical observation payload" })
  }
}

function validateRuntimeEpisodeSnapshot(
  snapshot: Snapshot | unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(snapshot)) {
    issues.push({ path, message: "snapshot must be an object" })
    return
  }

  if (snapshot.schema !== RUNTIME_EPISODE_SNAPSHOT_SCHEMA) {
    issues.push({ path: `${path}.schema`, message: `snapshot schema must be ${RUNTIME_EPISODE_SNAPSHOT_SCHEMA}` })
  }
  if (!nonEmptyString(snapshot.id)) {
    issues.push({ path: `${path}.id`, message: "snapshot id is required" })
  }
  if (!nonEmptyString(snapshot.createdAt)) {
    issues.push({ path: `${path}.createdAt`, message: "snapshot createdAt is required" })
  }
  if (!nonEmptyString(snapshot.semantics)) {
    issues.push({ path: `${path}.semantics`, message: "snapshot semantics are required" })
  }
  if (!isRecord(snapshot.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "snapshot metadata must be an object" })
  }
  if (snapshot.artifactRefs !== undefined) {
    if (!Array.isArray(snapshot.artifactRefs)) {
      issues.push({ path: `${path}.artifactRefs`, message: "snapshot artifactRefs must be an array when present" })
    } else {
      snapshot.artifactRefs.forEach((ref, index) => validateRuntimeEpisodeTraceRef(ref, `${path}.artifactRefs[${index}]`, undefined, issues))
    }
  }
  if (!validDigest(snapshot.digest)) {
    issues.push({ path: `${path}.digest`, message: "snapshot digest must be a sha256 digest" })
    return
  }

  const expected = runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload(snapshot as unknown as Snapshot))
  if (snapshot.digest.value !== expected.value) {
    issues.push({ path: `${path}.digest`, message: "snapshot digest must match the canonical snapshot payload" })
  }
}

function validateRuntimeEpisodeTraceRef(
  ref: RuntimeEpisodeTraceRef | unknown,
  path: string,
  kind: RuntimeEpisodeTraceRef["kind"] | undefined,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!isRecord(ref)) {
    issues.push({ path, message: "ref must be an object" })
    return
  }

  if (kind !== undefined && ref.kind !== kind) {
    issues.push({ path: `${path}.kind`, message: `ref kind must be ${kind}` })
  }
  if (!nonEmptyString(ref.kind)) {
    issues.push({ path: `${path}.kind`, message: "ref kind is required" })
  }
  if (!nonEmptyString(ref.id)) {
    issues.push({ path: `${path}.id`, message: "ref id is required" })
  }
  if (!validDigest(ref.digest)) {
    issues.push({ path: `${path}.digest`, message: "ref digest must be a sha256 digest" })
  }
}

function validateRuntimeEpisodeRefDigest(
  ref: RuntimeEpisodeTraceRef,
  targetDigest: RuntimeEpisodeContentDigest | undefined,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!validDigest(ref.digest) || !validDigest(targetDigest)) {
    return
  }
  if (ref.digest.value !== targetDigest.value) {
    issues.push({ path: `${path}.digest`, message: "ref digest must match the referenced envelope digest" })
  }
}

function validDigest(value: unknown): value is RuntimeEpisodeContentDigest {
  return isRecord(value) && value.algorithm === "sha256" && typeof value.value === "string" && /^[a-f0-9]{64}$/.test(value.value)
}

function collectForbiddenRuntimeEpisodeTraceFields(
  value: unknown,
  path: string,
  issues: RuntimeEpisodeTraceValidationIssue[],
): void {
  if (!value || typeof value !== "object") {
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenRuntimeEpisodeTraceFields(item, `${path}[${index}]`, issues))
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (RUNTIME_EPISODE_TRACE_FORBIDDEN_FIELDS.has(key)) {
      issues.push({ path: childPath, message: `${key} is not part of the generic runtime episode trace contract` })
    }
    collectForbiddenRuntimeEpisodeTraceFields(child, childPath, issues)
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
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

function observationRef(observation: ObservationResult, fallbackId: string): RuntimeEpisodeTraceRef {
  return { kind: "observation", id: observation.id || fallbackId, digest: observation.digest ?? runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(observation)) }
}

function observationWithId(observation: ObservationResult, fallbackId: string): ObservationResult {
  const enveloped = {
    ...observation,
    schema: RUNTIME_EPISODE_OBSERVATION_SCHEMA,
    id: observation.id || fallbackId,
  }

  return { ...enveloped, digest: runtimeEpisodeDigest(runtimeEpisodeObservationDigestPayload(enveloped)) }
}

function snapshotWithSemantics(snapshot: Snapshot): Snapshot {
  const enveloped = {
    ...snapshot,
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    semantics: snapshot.semantics ?? "metadata-only",
  }

  return { ...enveloped, digest: runtimeEpisodeDigest(runtimeEpisodeSnapshotDigestPayload(enveloped)) }
}

function runtimeEpisodeJsonLines(trace: RuntimeEpisodeTrace): string {
  const records: Array<Record<string, unknown>> = [
    {
      type: "episode.reset",
      id: trace.reset.id,
      runtime: trace.reset.runtime,
      observations: trace.reset.observationRefs,
    },
    ...trace.steps.map((step) => ({
      type: "episode.step",
      id: step.id,
      index: step.index,
      actionRef: step.actionRef,
      executionRef: step.executionRef,
      ...(step.observationRef ? { observationRef: step.observationRef } : {}),
    })),
    ...trace.snapshots.map((snapshot) => ({
      type: "episode.snapshot",
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      semantics: snapshot.semantics,
      artifactRefs: snapshot.artifactRefs ?? [],
    })),
  ]

  if (trace.artifactRef) {
    records.push({
      type: "episode.artifacts",
      id: trace.artifactRef.id,
      artifactRef: trace.artifactRef,
    })
  }

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

function upsertManifestFile(manifest: ArtifactManifest, file: ArtifactManifestFile): void {
  const index = manifest.files.findIndex((candidate) => candidate.path === file.path)
  if (index === -1) {
    manifest.files.push(file)
    return
  }

  manifest.files[index] = file
}

function artifactManifestFile(path: string, kind: string, contentType: string): ArtifactManifestFile {
  return { path, kind, contentType, sha256: { algorithm: "sha256", value: "0".repeat(64) } }
}

async function refreshArtifactManifestFileHashes(directory: string, manifest: ArtifactManifest): Promise<void> {
  for (const file of manifest.files) {
    if (file.path !== "manifest.json") {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file) }
    }
  }
  for (const file of manifest.files) {
    if (file.path === "manifest.json") {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(directory, manifest, file) }
    }
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
  private resetCount = 0
  private readonly steps: RuntimeEpisodeStepResult[] = []
  private readonly snapshots: Snapshot[] = []
  private artifacts?: ArtifactBundle
  private traceCreatedAt?: string

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
    this.traceCreatedAt = undefined

    for (const mount of this.spec.mounts ?? []) {
      await this.runtime.mount(mount)
    }

    const runtime = await this.runtime.info()
    const resetId = `${runtime.id}:reset:${this.resetCount++}`
    const observations = []
    for (const [index, observation] of (this.spec.resetObservations ?? [{ type: "runtime-info" }, { type: "mounts" }]).entries()) {
      observations.push(observationWithId(await this.runtime.observe(observation), `${resetId}:observation:${index}`))
    }
    this.resetResult = {
      id: resetId,
      runtime,
      observations,
      observationRefs: observations.map((observation, index) => observationRef(observation, `${resetId}:observation:${index}`)),
    }

    return this.resetResult
  }

  async step(action: RuntimeEpisodeActionSpec, observation: ObservationSpec | false = this.spec.stepObservation ?? false): Promise<RuntimeEpisodeStepResult> {
    const runtime = this.assertRuntime()
    const execution = await runtime.execute(action)
    const index = this.steps.length
    const stepId = `${execution.id}:step:${index}`
    const actionRecord = {
      schema: RUNTIME_EPISODE_ACTION_SCHEMA,
      id: `${stepId}:action`,
      kind: action.kind ?? "command",
      command: action.command,
      args: action.args ?? [],
      ...(action.cwd ? { cwd: action.cwd } : {}),
      ...(action.timeoutMs !== undefined ? { timeoutMs: action.timeoutMs } : {}),
      ...(action.method ? { method: action.method } : {}),
      ...(action.url ? { url: action.url } : {}),
      ...(action.path ? { path: action.path } : {}),
      ...(action.operation ? { operation: action.operation } : {}),
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.description ? { description: action.description } : {}),
      ...(action.metadata ? { metadata: action.metadata } : {}),
      digest: runtimeEpisodeDigest(runtimeEpisodeActionDigestPayload(action)),
    }
    const stepObservation = observation ? observationWithId(await runtime.observe(observation), `${stepId}:observation`) : undefined
    const result: RuntimeEpisodeStepResult = {
      id: stepId,
      index,
      action: actionRecord,
      actionRef: { kind: "action", id: actionRecord.id, digest: actionRecord.digest },
      execution,
      executionRef: { kind: "execution", id: execution.id, digest: runtimeEpisodeDigest(execution) },
      ...(stepObservation
        ? { observation: stepObservation, observationRef: observationRef(stepObservation, `${stepId}:observation`) }
        : {}),
    }

    this.steps.push(result)
    return result
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    return this.assertRuntime().observe(spec)
  }

  async snapshot(): Promise<Snapshot> {
    const snapshot = snapshotWithSemantics(await this.assertRuntime().snapshot())
    this.snapshots.push(snapshot)
    return snapshot
  }

  async collectArtifacts(spec: ArtifactSpec = this.spec.artifactSpec ?? {}): Promise<ArtifactBundle> {
    const artifacts = await this.assertRuntime().collectArtifacts(spec)
    this.artifacts = {
      ...artifacts,
      runtimeEpisodeTracePath: join(artifacts.directory, "files/runtime-episode-trace.json"),
      runtimeEpisodeEventsPath: join(artifacts.directory, "files/runtime-episode.jsonl"),
    }
    await this.persistRuntimeEpisodeTraceArtifacts()
    return this.artifacts
  }

  private async persistRuntimeEpisodeTraceArtifacts(): Promise<void> {
    if (!this.artifacts?.runtimeEpisodeTracePath || !this.artifacts.runtimeEpisodeEventsPath || !this.artifacts.runtimeReferenceManifestPath) {
      return
    }

    const trace = await this.trace()
    const traceRelativePath = "files/runtime-episode-trace.json"
    const eventsRelativePath = "files/runtime-episode.jsonl"
    await writeFile(this.artifacts.runtimeEpisodeTracePath, `${JSON.stringify(trace, null, 2)}\n`)
    await writeFile(this.artifacts.runtimeEpisodeEventsPath, `${runtimeEpisodeJsonLines(trace)}`)
    await this.updateArtifactMetadataForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateArtifactReviewForRuntimeEpisodeTrace(traceRelativePath)
    await this.updateArtifactManifestForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
    await this.updateRuntimeReferenceManifestForRuntimeEpisodeTrace(traceRelativePath, eventsRelativePath)
  }

  private async updateRuntimeReferenceManifestForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts?.runtimeReferenceManifestPath) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const fileRefs = manifest.files
      .filter((file) => !["manifest.json", "metadata.json", "files/review.json", "files/runtime-reference-manifest.json"].includes(file.path))
      .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 }))
    const traceRef = fileRefs.find((file) => file.path === traceRelativePath)
    const eventsRef = fileRefs.find((file) => file.path === eventsRelativePath)
    const referenceManifest = buildRuntimeReferenceManifest({
      createdAt: this.artifacts.createdAt,
      runtime: manifest.runtime,
      artifactBundle: {
        kind: "artifact-bundle",
        id: manifest.id,
        digest: { algorithm: "sha256", value: manifest.contentDigest.value },
      },
      files: fileRefs,
      ...(traceRef ? { trace: traceRef } : {}),
      ...(eventsRef ? { events: eventsRef } : {}),
      snapshots: this.snapshots,
    })
    await writeFile(this.artifacts.runtimeReferenceManifestPath, `${JSON.stringify(referenceManifest, null, 2)}\n`)
    await refreshArtifactManifestFileHashes(this.artifacts.directory, manifest)
    await writeFile(this.artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async updateArtifactManifestForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    upsertManifestFile(manifest, artifactManifestFile(traceRelativePath, "runtime-episode-trace", "application/json"))
    upsertManifestFile(manifest, artifactManifestFile(eventsRelativePath, "runtime-episode-events", "application/x-ndjson"))
    await refreshArtifactManifestFileHashes(this.artifacts.directory, manifest)
    await writeFile(this.artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async updateArtifactMetadataForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const metadata = JSON.parse(await readFile(this.artifacts.metadataPath, "utf8")) as Record<string, unknown>
    metadata.artifacts = {
      ...(isRecord(metadata.artifacts) ? metadata.artifacts : {}),
      runtimeEpisodeTrace: traceRelativePath,
      runtimeEpisodeEvents: eventsRelativePath,
    }
    await writeFile(this.artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  }

  private async updateArtifactReviewForRuntimeEpisodeTrace(traceRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const review = JSON.parse(await readFile(this.artifacts.reviewPath, "utf8")) as ArtifactReview
    review.evidence.runtimeEpisodeTrace = traceRelativePath
    if (!review.progress.some((event) => event.type === "artifact" && event.component === "runtime-episode")) {
      review.progress.push({
        type: "artifact",
        component: "runtime-episode",
        label: "Runtime episode trace persisted",
        timestamp: new Date().toISOString(),
      })
    }
    await writeFile(this.artifacts.reviewPath, `${JSON.stringify(review, null, 2)}\n`)
  }

  async trace(): Promise<RuntimeEpisodeTrace> {
    const runtime = this.assertRuntime()
    const reset = this.resetResult ?? {
      id: `${(await runtime.info()).id}:reset:unrecorded`,
      runtime: await runtime.info(),
      observations: [],
      observationRefs: [],
    }
    const artifactRef = this.artifacts
      ? {
          kind: "artifact-bundle" as const,
          id: this.artifacts.id,
          artifactId: this.artifacts.id,
          path: this.artifacts.directory,
          digest: { algorithm: "sha256" as const, value: this.artifacts.contentDigest },
        }
      : undefined

    return {
      schema: RUNTIME_EPISODE_TRACE_SCHEMA,
      version: 1,
      id: `trace-${reset.runtime.id}`,
      createdAt: this.traceCreatedAt ??= new Date().toISOString(),
      runtime: await runtime.info(),
      reset,
      steps: [...this.steps],
      snapshots: [...this.snapshots],
      ...(this.artifacts ? { artifacts: this.artifacts } : {}),
      ...(artifactRef ? { artifactRef } : {}),
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
