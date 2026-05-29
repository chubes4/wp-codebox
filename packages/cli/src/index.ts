#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { SANDBOX_DMC_PARENT_ONLY_ABILITIES, SANDBOX_DMC_SAFE_ABILITIES, SANDBOX_WORKSPACE_ROOT, calculateArtifactManifestFileSha256, checkWorkspacePolicy, commandRegistry, createRuntime, createWorkspaceRecipeJsonSchema, recipeCommandDefinitions, validateRuntimePolicy, verifyArtifactBundle, type ArtifactBundle, type ArtifactBundleVerificationResult, type ArtifactManifest, type CommandDefinition, type ExecutionResult, type MountSpec, type Runtime, type RuntimeInfo, type RuntimePolicy, type SandboxWorkspaceContract, type SandboxWorkspaceMode, type WorkspacePolicyResult, type WorkspaceRecipe, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeJsonSchema, type WorkspaceRecipePluginRuntime, type WorkspaceRecipePluginRuntimeHealthProbe, type WorkspaceRecipeSiteSeed, type WorkspaceRecipeStagedFile, type WorkspaceRecipeWorkspace } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"
import { agentRuntimeProbeCode, agentSandboxRunCode, resolveSandboxTaskCode } from "./agent-code.js"
import { captureStdout, printArtifactVerifyHumanOutput, printBatchHumanOutput, printBlueprintValidateHumanOutput, printBootHumanOutput, printCommandCatalogHumanOutput, printHelp, printHumanOutput, printRecipeHumanOutput, printRecipeSchemaHumanOutput, printRecipeValidateHumanOutput, serializeError } from "./output.js"
import { parsePreviewBind, parsePreviewHoldSeconds, parsePreviewPort, parsePreviewPublicUrl } from "./preview-options.js"

interface CommandCatalogOutput {
  schema: "wp-codebox/command-catalog/v1"
  commands: Array<Omit<CommandDefinition, "handler">>
}

interface RecipeSchemaOutput {
  schema: "wp-codebox/json-schema/v1"
  id: "wp-codebox/workspace-recipe/v1"
  jsonSchema: WorkspaceRecipeJsonSchema
}

interface RunOptions {
  mounts: Array<{ source: string; target: string; mode: "readonly" | "readwrite"; metadata?: Record<string, unknown> }>
  command: string
  args: string[]
  wpVersion?: string
  artifactsDirectory?: string
  policy?: RuntimePolicy
  secretEnv?: Record<string, string>
  metadata?: Record<string, unknown>
  blueprint?: unknown
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  json: boolean
}

interface RunOutput {
  success: boolean
  runtime?: RuntimeInfo
  execution?: ExecutionResult
  artifacts?: ArtifactBundle
  logs?: string[]
  error?: {
    name: string
    message: string
    code?: string
  }
}

interface BootOptions {
  mounts: RunOptions["mounts"]
  wpVersion?: string
  artifactsDirectory?: string
  policy?: RuntimePolicy
  blueprint?: unknown
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  json: boolean
}

interface BootOutput {
  success: boolean
  schema: "wp-codebox/boot/v1"
  runtime?: RuntimeInfo
  artifacts?: ArtifactBundle
  logs?: string[]
  error?: RunOutput["error"]
}

interface BlueprintValidateOptions {
  blueprint: unknown
  blueprintPath?: string
  wpVersion?: string
  artifactsDirectory?: string
  policy?: RuntimePolicy
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  json: boolean
}

interface BlueprintValidateOutput {
  success: boolean
  schema: "wp-codebox/blueprint-validation/v1"
  blueprintPath?: string
  runtime?: RuntimeInfo
  artifacts?: ArtifactBundle
  logs?: string[]
  error?: RunOutput["error"]
}

interface RecipeRunOptions {
  recipePath: string
  artifactsDirectory?: string
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  previewBind?: string
  json: boolean
  dryRun: boolean
}

type RecipeInterruptionSignal = "SIGINT" | "SIGTERM" | "SIGHUP"

interface RecipeInterruptionMetadata {
  signal: RecipeInterruptionSignal
  receivedAt: string
  artifactsFinalized: boolean
}

interface RecipeInterruptionController {
  readonly metadata: RecipeInterruptionMetadata | undefined
  install(): void
  dispose(): void
  interruptible<T>(promise: Promise<T>): Promise<T>
  throwIfInterrupted(): void
  propagateIfInterrupted(): void
}

interface RecipeArtifactEvidenceFile {
  path: string
  sha256: string
  kind: string
  contentType: string
}

interface RecipeArtifactEvidenceResult {
  runAttestation?: RecipeRunAttestation & {
    artifact: RecipeArtifactEvidenceFile
  }
  artifactVerification?: ArtifactBundleVerificationResult & {
    artifact: RecipeArtifactEvidenceFile
    strict: boolean
  }
  workspacePolicy?: RecipeWorkspacePolicyArtifactResult & {
    artifact: RecipeArtifactEvidenceFile
    strict: boolean
  }
  agentResult?: AgentSandboxResultSummary & {
    artifact: RecipeArtifactEvidenceFile
  }
  transcript?: AgentSandboxTranscript & {
    artifact: RecipeArtifactEvidenceFile
  }
}

interface AgentSandboxResultSummary {
  schema: "wp-codebox/agent-result/v1"
  status: "completed" | "failed" | "unknown"
  actionable: boolean
  summary: string
  changedFiles: {
    count: number
    paths: string[]
    statuses: Record<string, number>
    artifact: string
  }
  patch: {
    bytes: number
    sha256: string
    artifact: string
  }
  transcript: {
    artifact: string
    executionCount: number
  }
  artifacts: {
    directory: string
    review: string
    manifest: string
  }
  failures: Array<{ executionIndex: number; command: string; exitCode: number; message: string }>
  noOpReason?: string
  workspaceTools?: {
    diagnostics: string[]
  }
}

interface AgentSandboxTranscript {
  schema: "wp-codebox/agent-transcript/v1"
  executions: AgentSandboxTranscriptExecution[]
}

interface AgentSandboxTranscriptExecution {
  executionIndex: number
  command: string
  exitCode: number
  recipePhase?: string
  recipeStepIndex?: number
  recipeCommand?: string
  stdout: string
  stderr: string
  parsed?: unknown
}

interface RecipeRunAttestation {
  schema: "wp-codebox/run-attestation/v1"
  createdAt: string
  package: {
    name: string
    version?: string
    commit?: string
  }
  backend: {
    kind: string
    package: {
      name: string
      version?: string
    }
    engine?: {
      name: string
      version?: string
    }
  }
  runtime: {
    kind: string
    name?: string
    version?: string
    immutableRef?: string
  }
  policy: {
    command: {
      sha256: string
      allowedCommands: string[]
      enforcement: "enforced"
    }
    network: RunAttestationPolicyField
    filesystem: RunAttestationPolicyField
    secrets: RunAttestationPolicyField
    approvals: RunAttestationPolicyField
    workspace: RunAttestationEvidencePolicy
    artifactVerifier: RunAttestationEvidencePolicy
  }
  secretEnvelope: {
    schema: "wp-codebox/redacted-secret-envelope/v1"
    provided: boolean
    count: number
    secrets: Array<{ name: string; status: "available"; source: "recipe-secret-env" }>
    redaction: "names-only"
  }
  evidenceRefs: {
    workspacePolicyResult?: RunAttestationEvidenceRef
    artifactVerifierResult?: RunAttestationEvidenceRef
  }
  sealed: {
    enforced: string[]
    declarative: string[]
  }
}

interface RunAttestationPolicyField {
  value: RuntimePolicy[keyof RuntimePolicy]
  enforcement: "enforced"
}

interface RunAttestationEvidencePolicy {
  enabled: boolean
  strict: boolean
  enforcement: "enforced" | "declarative" | "not-configured"
  sha256?: string
  resultRef?: RunAttestationEvidenceRef
}

interface RunAttestationEvidenceRef {
  path: string
  sha256: string
  kind: string
}

interface RecipeWorkspacePolicyArtifactResult {
  schema: "wp-codebox/workspace-policy-artifacts/v1"
  passed: boolean
  checks: Array<{
    workspace: {
      target: string
      mode: "readonly" | "readwrite"
      metadata?: Record<string, unknown>
    }
    result: WorkspacePolicyResult
  }>
}

interface RecipeValidateOptions {
  recipePath: string
  json: boolean
}

interface WorkspacePolicyOptions {
  workspaceRoot: string
  writableRoots: string[]
  hiddenPaths: string[]
  gitBacked: boolean
  json: boolean
}

interface ArtifactVerifyOptions {
  bundleDirectory: string
  json: boolean
}

interface RecipeValidationIssue {
  code: string
  path: string
  message: string
}

interface RecipeValidateOutput {
  success: boolean
  schema: "wp-codebox/recipe-validation/v1"
  recipePath?: string
  valid: boolean
  issues: RecipeValidationIssue[]
  summary?: {
    steps: number
    mounts: number
    workspaces: number
    extraPlugins: number
    stagedFiles: number
  }
  error?: RunOutput["error"]
}

interface RecipeRunOutput {
  success: boolean
  schema: "wp-codebox/recipe-run/v1"
  recipePath?: string
  runtime?: RuntimeInfo
  executions: RecipeExecutionResult[]
  stagedFiles?: RecipeRunStagedFile[]
  siteSeeds?: RecipeRunSiteSeed[]
  diagnostics?: RecipeRuntimeDiagnostic[]
  validation?: {
    issues: RecipeValidationIssue[]
  }
  benchResults?: BenchResults
  benchResultsList?: BenchResults[]
  artifacts?: ArtifactBundle
  interruption?: RecipeInterruptionMetadata
  logs?: string[]
  error?: RunOutput["error"]
}

interface RecipeDryRunOutput {
  success: boolean
  schema: "wp-codebox/recipe-run-dry-run/v1"
  recipePath?: string
  dryRun: true
  valid: boolean
  validation: {
    issues: RecipeValidationIssue[]
  }
  plan?: RecipeDryRunPlan
  error?: RunOutput["error"]
}

type RecipeRunCommandOutput = RecipeRunOutput | RecipeDryRunOutput

interface RecipeDryRunPlan {
  runtime: {
    backend: string
    name: string
    wp: string
    blueprint: unknown
  }
  artifacts: {
    directory?: string
  }
  mounts: RecipeDryRunMount[]
  workspaces: RecipeDryRunWorkspace[]
  extra_plugins: RecipeDryRunExtraPlugin[]
  pluginRuntime?: RecipeDryRunPluginRuntime
  siteSeeds: RecipeDryRunSiteSeed[]
  stagedFiles: RecipeDryRunStagedFile[]
  secretEnv: Array<{ name: string; available: boolean }>
  policy: RuntimePolicy & {
    valid: boolean
    issues: ReturnType<typeof validateRuntimePolicy>["issues"]
  }
  workflow: {
    before?: RecipeDryRunStep[]
    steps: RecipeDryRunStep[]
    after?: RecipeDryRunStep[]
  }
}

type RecipeWorkflowPhase = "setup" | "before" | "steps" | "after"

type RecipeExecutionResult = ExecutionResult & {
  recipePhase?: RecipeWorkflowPhase
  recipeStepIndex?: number
  recipeCommand?: string
}

interface RecipeDryRunMount {
  type: MountSpec["type"]
  source?: string
  target: string
  mode: "readonly" | "readwrite"
  metadata?: Record<string, unknown>
  planned?: "existing" | "generated"
}

interface RecipeDryRunWorkspace {
  index: number
  source?: string
  target: string
  mode: "readonly" | "readwrite"
  sourceMode: SandboxWorkspaceMode
  seed: WorkspaceRecipeWorkspace["seed"]
  generated: boolean
  metadata: Record<string, unknown>
}

interface RecipeDryRunExtraPlugin {
  source: string
  sourceRef: string
  sourceType: RecipeSourceType
  slug: string
  target: string
  pluginFile: string
  activate: boolean
  loadAs: "plugin" | "mu-plugin"
  provenance: RecipeSourceProvenance
}

interface RecipeDryRunPluginRuntime {
  label?: string
  php?: WorkspaceRecipePluginRuntime["php"]
  wpConfigDefines?: WorkspaceRecipePluginRuntime["wpConfigDefines"]
  setup: RecipeDryRunStep[]
  healthProbes: RecipeDryRunPluginRuntimeHealthProbe[]
}

interface RecipeDryRunPluginRuntimeHealthProbe {
  index: number
  name: string
  type: WorkspaceRecipePluginRuntimeHealthProbe["type"]
  command: string
  args: string[]
  resolvedCommand: string
  resolvedArgs: string[]
  policy: RecipeDryRunStep["policy"]
}

interface RecipeRuntimeDiagnostic {
  schema: "wp-codebox/plugin-runtime-diagnostic/v1"
  severity: "error"
  phase: "setup" | "health-probe" | "runtime"
  name?: string
  command?: string
  exitCode?: number
  message: string
  executionIndex?: number
}

interface RecipeDryRunSiteSeed {
  index: number
  type: WorkspaceRecipeSiteSeed["type"]
  name: string
  source?: string
  format?: WorkspaceRecipeSiteSeed["format"]
  importer?: string
  scopes: WorkspaceRecipeSiteSeed["scopes"]
  bounded: boolean
  dryRunOnly: boolean
  privacy: {
    exportsParentSiteData: boolean
    importsIntoSandbox: boolean
    includesRecordData: boolean
    secrets: "excluded-by-default"
  }
}

interface RecipeRunSiteSeed extends Omit<RecipeDryRunSiteSeed, "dryRunOnly"> {
  action: "imported" | "skipped"
  reason?: string
  counts?: Record<string, number>
  warnings?: string[]
  provenance?: Record<string, unknown>
}

interface RecipeDryRunStagedFile {
  index: number
  source: string
  sourceRef: string
  target: string
  type: MountSpec["type"]
  provenance: RecipeStagedFileProvenance
}

interface RecipeRunStagedFile extends RecipeDryRunStagedFile {
  action: "staged"
}

interface RecipeDryRunStep {
  phase: RecipeWorkflowPhase
  index: number
  command: string
  args: string[]
  parsedArgs: Record<string, string | true>
  resolvedCommand: string
  resolvedArgs: string[]
  resolvedParsedArgs: Record<string, string | true>
  policy: {
    status: "allowed" | "denied"
    command: string
    allowedCommands: string[]
    approvals: RuntimePolicy["approvals"]
    filesystem: RuntimePolicy["filesystem"]
    secrets: RuntimePolicy["secrets"]
  }
}

interface PreparedWorkspaceMount {
  source: string
  target: string
  mode: "readonly" | "readwrite"
  cleanupPaths: string[]
  metadata: Record<string, unknown>
}

interface PreparedWorkspaceSource {
  source: string
  baselineSource: string
  cleanupPaths: string[]
}

type RecipeSourceType = "local" | "https_zip" | "wporg_plugin_zip"

interface RecipeSourceProvenance {
  kind: RecipeSourceType
  original: string
  resolvedUrl?: string
  digest?: {
    sha256: string
    expected?: string
    verified?: boolean
  }
  policy?: {
    host: string
    maxDownloadBytes: number
    maxExtractedBytes: number
    maxExtractedFiles: number
    sha256Required: boolean
  }
  localPathCategory?: "recipe-relative" | "temporary-download"
}

interface PreparedExternalSource {
  source: string
  cleanupPaths: string[]
  provenance: RecipeSourceProvenance
}

interface PreparedExtraPlugin {
  source: string
  slug: string
  target: string
  pluginFile: string
  activate: boolean
  loadAs: "plugin" | "mu-plugin"
  cleanupPaths: string[]
  provenance: RecipeSourceProvenance
}

interface RecipeStagedFileProvenance {
  kind: "local"
  original: string
  localPathCategory?: "recipe-relative"
}

interface PreparedStagedFile {
  source: string
  originalSource: string
  sourceRef: string
  target: string
  type: MountSpec["type"]
  cleanupPaths: string[]
  provenance: RecipeStagedFileProvenance
  metadata: Record<string, unknown>
}

interface AgentRuntimeProbeOptions {
  agentsApiPath: string
  dataMachinePath: string
  dataMachineCodePath: string
  providerPluginPaths: string[]
  mounts: RunOptions["mounts"]
  wpVersion?: string
  artifactsDirectory?: string
  secretEnvNames?: string[]
  json: boolean
}

interface AgentSandboxRunOptions extends AgentRuntimeProbeOptions {
  task: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  sessionId?: string
  maxTurns?: string
  timeoutSeconds?: string
  code?: string
  codeFile?: string
}

interface AgentSandboxBatchOptions extends AgentRuntimeProbeOptions {
  tasks: string[]
  agent?: string
  mode?: string
  provider?: string
  model?: string
  maxTurns?: string
  concurrency?: string
}

interface AgentSandboxBatchOutput {
  success: boolean
  schema: "wp-codebox/agent-sandbox-batch/v1"
  concurrency: number
  total: number
  completed: number
  failed: number
  runs: Array<RunOutput & { index: number; task: string }>
}

interface BenchResults {
  component_id: string
  iterations: number
  scenarios: Array<Record<string, unknown>>
}

const defaultPolicy: RuntimePolicy = {
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["inspect-mounted-inputs", "wordpress.run-php"],
  secrets: "none",
  approvals: "never",
}

const WP_CODEBOX_RUNTIME_VERSION = "0.0.0"
const DEFAULT_WORDPRESS_VERSION = "7.0"
const ALLOW_NETWORK_DOWNLOADS_ENV = "WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS"
const ALLOWED_DOWNLOAD_HOSTS_ENV = "WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS"
const REQUIRE_SOURCE_SHA256_ENV = "WP_CODEBOX_REQUIRE_SOURCE_SHA256"
const MAX_DOWNLOAD_BYTES_ENV = "WP_CODEBOX_MAX_DOWNLOAD_BYTES"
const MAX_EXTRACTED_BYTES_ENV = "WP_CODEBOX_MAX_EXTRACTED_BYTES"
const MAX_EXTRACTED_FILES_ENV = "WP_CODEBOX_MAX_EXTRACTED_FILES"
const DEFAULT_ALLOWED_DOWNLOAD_HOSTS = ["downloads.wordpress.org"]
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_FILES = 2000
const execFileAsync = promisify(execFile)

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function sourceSha256Required(): boolean {
  return process.env[REQUIRE_SOURCE_SHA256_ENV] === "1"
}

function allowedDownloadHosts(): string[] {
  const configured = process.env[ALLOWED_DOWNLOAD_HOSTS_ENV]
  return (configured ? configured.split(",") : DEFAULT_ALLOWED_DOWNLOAD_HOSTS)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? "")
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function maxDownloadBytes(): number {
  return envPositiveInteger(MAX_DOWNLOAD_BYTES_ENV, DEFAULT_MAX_DOWNLOAD_BYTES)
}

function maxExtractedBytes(): number {
  return envPositiveInteger(MAX_EXTRACTED_BYTES_ENV, DEFAULT_MAX_EXTRACTED_BYTES)
}

function maxExtractedFiles(): number {
  return envPositiveInteger(MAX_EXTRACTED_FILES_ENV, DEFAULT_MAX_EXTRACTED_FILES)
}

function normalizedWorkspaceSeedExcludePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
}

function workspaceSeedExcludeMatches(relativePath: string, excludePath: string): boolean {
  const normalizedRelativePath = normalizedWorkspaceSeedExcludePath(relativePath)
  const normalizedExcludePath = normalizedWorkspaceSeedExcludePath(excludePath)
  if (!normalizedExcludePath) {
    return false
  }

  if (normalizedExcludePath.endsWith("*")) {
    return normalizedRelativePath.startsWith(normalizedExcludePath.slice(0, -1))
  }

  return normalizedRelativePath === normalizedExcludePath || normalizedRelativePath.startsWith(`${normalizedExcludePath}/`)
}

function shouldCopyWorkspaceSeedEntry(sourceRoot: string, entry: string, excludePaths: string[] = []): boolean {
  const relativePath = relative(sourceRoot, entry)
  if (!relativePath) {
    return true
  }

  return !excludePaths.some((excludePath) => workspaceSeedExcludeMatches(relativePath, excludePath))
}

async function copyWorkspaceSeedDirectory(source: string, target: string, excludePaths: string[] = []): Promise<void> {
  await cp(source, target, {
    recursive: true,
    filter: (entry) => shouldCopyWorkspaceSeedEntry(source, entry, excludePaths),
  })
}
const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(moduleDirectory, "..", "..", "..")
const supportedRecipeCommands = new Set(recipeCommandDefinitions().map((command) => command.id))

const secretEnvPolicy: RuntimePolicy = {
  ...defaultPolicy,
  secrets: "connector-scoped",
}

async function main(args: string[]): Promise<number> {
  const command = args.shift()

  const jspiRespawnExitCode = await maybeRespawnWithJspi(command, args)
  if (jspiRespawnExitCode !== undefined) {
    return jspiRespawnExitCode
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return command ? 0 : 1
  }

  if (command === "boot") {
    const options = await parseBootOptions(args)
    const execute = () => boot(options)

    if (!options.json) {
      const output = await execute()
      printBootHumanOutput(output)
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const output = logs.length > 0 ? { ...result, logs } : result
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    printJsonFailureDiagnostic(output)
    return output.success ? 0 : 1
  }

  if (command === "validate-blueprint") {
    const options = await parseBlueprintValidateOptions(args)
    const execute = () => validateBlueprint(options)

    if (!options.json) {
      const output = await execute()
      printBlueprintValidateHumanOutput(output)
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const output = logs.length > 0 ? { ...result, logs } : result
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    printJsonFailureDiagnostic(output)
    return output.success ? 0 : 1
  }

  if (command === "recipe-run") {
    const options = parseRecipeRunOptions(args)
    const interruption = options.dryRun ? undefined : createRecipeInterruptionController()
    interruption?.install()
    const execute = (): Promise<RecipeRunCommandOutput> => options.dryRun ? dryRunRecipe(options) : runRecipe(options, interruption)

    try {
      if (!options.json) {
        const output = interruptedRecipeOutput(await execute(), interruption)
        printRecipeHumanOutput(output)
        interruption?.propagateIfInterrupted()
        return output.success ? 0 : 1
      }

      const { result, logs } = await captureStdout(execute)
      const interruptedResult = interruptedRecipeOutput(result, interruption)
      const output = logs.length > 0 ? { ...interruptedResult, logs } : interruptedResult
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
      printJsonFailureDiagnostic(output)
      interruption?.propagateIfInterrupted()
      return output.success ? 0 : 1
    } finally {
      interruption?.dispose()
    }
  }

  if (command === "recipe") {
    const subcommand = args.shift()
    if (subcommand !== "validate") {
      console.error(`Unknown recipe command: ${subcommand ?? ""}`)
      printHelp()
      return 1
    }

    const options = parseRecipeValidateOptions(args)
    const output = await validateRecipe(options)
    if (!options.json) {
      printRecipeValidateHumanOutput(output)
      return output.success ? 0 : 1
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return output.success ? 0 : 1
  }

  if (command === "workspace-policy") {
    const subcommand = args.shift()
    if (subcommand !== "check") {
      console.error(`Unknown workspace-policy command: ${subcommand ?? ""}`)
      printHelp()
      return 1
    }

    const options = parseWorkspacePolicyOptions(args)
    const output = await checkWorkspacePolicy({
      workspaceRoot: options.workspaceRoot,
      writableRoots: options.writableRoots,
      hiddenPaths: options.hiddenPaths,
      gitBacked: options.gitBacked,
    })
    if (!options.json) {
      printWorkspacePolicyHumanOutput(output)
      return output.passed ? 0 : 1
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return output.passed ? 0 : 1
  }

  if (command === "artifacts") {
    const subcommand = args.shift()
    if (subcommand !== "verify") {
      console.error(`Unknown artifacts command: ${subcommand ?? ""}`)
      printHelp()
      return 1
    }

    const options = parseArtifactVerifyOptions(args)
    const output = await verifyArtifacts(options)
    if (!options.json) {
      printArtifactVerifyHumanOutput(output)
      return output.valid ? 0 : 1
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return output.valid ? 0 : 1
  }

  if (command === "commands") {
    const json = parseDiscoveryJsonOption(args)
    const output = commandCatalogOutput()
    if (!json) {
      printCommandCatalogHumanOutput(output)
      return 0
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return 0
  }

  if (command === "schema") {
    const subcommand = args.shift()
    if (subcommand !== "recipe") {
      console.error(`Unknown schema command: ${subcommand ?? ""}`)
      printHelp()
      return 1
    }

    const json = parseDiscoveryJsonOption(args)
    const output = recipeSchemaOutput()
    if (!json) {
      printRecipeSchemaHumanOutput(output)
      return 0
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return 0
  }

  if (command !== "run") {
    console.error(`Unknown command: ${command}`)
    printHelp()
    return 1
  }

  const options = await parseRunOptions(args)
  const execute = () => run(options)

  if (!options.json) {
    const output = await execute()
    printHumanOutput(output)
    return output.success ? 0 : 1
  }

  const { result, logs } = await captureStdout(execute)
  const output = logs.length > 0 ? { ...result, logs } : result
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  printJsonFailureDiagnostic(output)
  return output.success ? 0 : 1
}

async function maybeRespawnWithJspi(command: string | undefined, args: string[]): Promise<number | undefined> {
  if (!command || !["boot", "run", "recipe-run"].includes(command)) {
    return undefined
  }

  if (!shouldRespawnWithJspi()) {
    return undefined
  }

  const requiredFlags = ["--experimental-wasm-jspi", "--experimental-wasm-stack-switching"]
  const missingFlags = requiredFlags.filter((flag) => !process.execArgv.includes(flag))
  const child = spawn(process.execPath, [...missingFlags, ...process.execArgv, ...process.argv.slice(1, 2), command, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      WP_CODEBOX_JSPI_RESPAWNED: "1",
    },
  })

  let parentSignal: NodeJS.Signals | undefined
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  const forwardSignal = (signal: NodeJS.Signals): void => {
    parentSignal ??= signal
    child.kill(signal)
  }
  for (const signal of signals) {
    process.on(signal, forwardSignal)
  }

  try {
    const exit = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject)
      child.once("close", (status, signal) => resolveExit({ status, signal }))
    })

    const signal = exit.signal ?? parentSignal
    if (signal) {
      for (const forwardedSignal of signals) {
        process.off(forwardedSignal, forwardSignal)
      }
      process.kill(process.pid, signal)
      return 1
    }

    return exit.status ?? 1
  } catch {
    return undefined
  } finally {
    for (const signal of signals) {
      process.off(signal, forwardSignal)
    }
  }
}

function shouldRespawnWithJspi(): boolean {
  if (process.env.WP_CODEBOX_JSPI_RESPAWNED || process.env.WP_CODEBOX_NO_JSPI_RESPAWN || process.env.PLAYGROUND_NO_JSPI_RESPAWN) {
    return false
  }

  if ("Suspending" in WebAssembly) {
    return false
  }

  if (process.versions.bun || "Deno" in globalThis) {
    return false
  }

  if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 23) {
    return false
  }

  return !["--experimental-wasm-jspi", "--experimental-wasm-stack-switching"].every((flag) => process.execArgv.includes(flag))
}

function parseDiscoveryJsonOption(args: string[]): boolean {
  let json = false
  for (const arg of args) {
    if (arg === "--json") {
      json = true
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  return json
}

function parseWorkspacePolicyOptions(args: string[]): WorkspacePolicyOptions {
  const options: WorkspacePolicyOptions = {
    workspaceRoot: process.cwd(),
    writableRoots: [],
    hiddenPaths: [],
    gitBacked: false,
    json: false,
  }

  while (args.length > 0) {
    const arg = args.shift()
    if (!arg) {
      continue
    }

    if (arg === "--json") {
      options.json = true
      continue
    }
    if (arg === "--git") {
      options.gitBacked = true
      continue
    }

    const value = args.shift()
    if (!value) {
      throw new Error(`Missing value for ${arg}`)
    }

    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        options.workspaceRoot = resolve(value)
        break
      case "--writable-root":
      case "--writable":
        options.writableRoots.push(value)
        break
      case "--hidden-path":
      case "--hidden":
        options.hiddenPaths.push(value)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (options.writableRoots.length === 0) {
    throw new Error("At least one --writable-root is required")
  }

  return options
}

function printWorkspacePolicyHumanOutput(output: WorkspacePolicyResult): void {
  console.log(output.passed ? "Workspace policy passed" : "Workspace policy failed")
  console.log(`Policy: ${output.policy_sha256}`)
  if (output.violations.length === 0) {
    return
  }

  console.log("Violations:")
  for (const violation of output.violations) {
    console.log(`- ${violation.code}: ${violation.path}`)
    console.log(`  ${violation.message}`)
  }
}

function commandCatalogOutput(): CommandCatalogOutput {
  return {
    schema: "wp-codebox/command-catalog/v1",
    commands: commandRegistry.map(({ handler, ...metadata }) => metadata),
  }
}

function recipeSchemaOutput(): RecipeSchemaOutput {
  return {
    schema: "wp-codebox/json-schema/v1",
    id: "wp-codebox/workspace-recipe/v1",
    jsonSchema: createWorkspaceRecipeJsonSchema({
      recipeCommandIds: recipeCommandDefinitions().map((command) => command.id),
    }),
  }
}

async function dryRunRecipe(options: RecipeRunOptions): Promise<RecipeDryRunOutput> {
  const recipePath = resolve(options.recipePath)
  try {
    const recipeDirectory = dirname(recipePath)
    const raw = await readFile(recipePath, "utf8")
    const recipe = parseWorkspaceRecipe(raw, recipePath)
    const issues = await validateWorkspaceRecipe(recipe, recipePath)

    if (issues.length > 0) {
      return {
        success: false,
        schema: "wp-codebox/recipe-run-dry-run/v1",
        recipePath,
        dryRun: true,
        valid: false,
        validation: { issues },
        error: {
          name: "RecipeValidationError",
          message: `Recipe validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
        },
      }
    }

    return {
      success: true,
      schema: "wp-codebox/recipe-run-dry-run/v1",
      recipePath,
      dryRun: true,
      valid: true,
      validation: { issues },
      plan: await recipeDryRunPlan(recipe, recipeDirectory, options),
    }
  } catch (error) {
    return {
      success: false,
      schema: "wp-codebox/recipe-run-dry-run/v1",
      recipePath,
      dryRun: true,
      valid: false,
      validation: {
        issues: [
          {
            code: "invalid-recipe",
            path: "$",
            message: error instanceof SyntaxError ? `Recipe JSON is invalid: ${error.message}` : error instanceof Error ? error.message : String(error),
          },
        ],
      },
      error: serializeError(error),
    }
  }
}

async function recipeDryRunPlan(recipe: WorkspaceRecipe, recipeDirectory: string, options: RecipeRunOptions): Promise<RecipeDryRunPlan> {
  const policy = recipePolicy(recipe)
  const policyValidation = validateRuntimePolicy(policy)
  const workspaces = recipeDryRunWorkspaces(recipe, recipeDirectory)
  const extraPlugins = recipeDryRunExtraPlugins(recipe, recipeDirectory)
  const pluginRuntime = await recipeDryRunPluginRuntime(recipe, recipeDirectory, policy)
  const siteSeeds = recipeDryRunSiteSeeds(recipe, recipeDirectory)
  const stagedFiles = await recipeDryRunStagedFiles(recipe, recipeDirectory)
  const workflowSteps = await recipeDryRunSteps(recipe, recipeDirectory, policy)
  const mounts: RecipeDryRunMount[] = [
    ...workspaces.map((workspace) => ({
      type: "directory" as const,
      ...(workspace.source ? { source: workspace.source } : {}),
      target: workspace.target,
      mode: workspace.mode,
      metadata: workspace.metadata,
      planned: workspace.generated ? "generated" as const : "existing" as const,
    })),
    ...extraPlugins.map((plugin) => ({
      type: "directory" as const,
      source: plugin.source,
      target: plugin.target,
      mode: "readonly" as const,
      metadata: {
        kind: "extra-plugin",
        slug: plugin.slug,
        source: plugin.provenance,
      },
      planned: "existing" as const,
    })),
    ...(recipe.inputs?.mounts ?? []).map((mount) => ({
      type: "directory" as const,
      source: resolve(recipeDirectory, mount.source),
      target: mount.target,
      mode: mount.mode ?? "readwrite" as const,
      ...(mount.metadata ? { metadata: mount.metadata } : {}),
      planned: "existing" as const,
    })),
    ...stagedFiles.map((stagedFile) => ({
      type: stagedFile.type,
      source: stagedFile.source,
      target: stagedFile.target,
      mode: "readwrite" as const,
      metadata: {
        kind: "staged-file",
        index: stagedFile.index,
        source: stagedFile.provenance,
      },
      planned: "generated" as const,
    })),
  ]

  return {
    runtime: {
      backend: recipe.runtime?.backend ?? "wordpress-playground",
      name: recipe.runtime?.name ?? "wp-codebox-recipe",
      wp: recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
      blueprint: recipe.runtime?.blueprint ?? { steps: [] },
    },
    artifacts: stripUndefined({
      directory: options.artifactsDirectory ?? recipe.artifacts?.directory,
    }),
    mounts,
    workspaces,
    extra_plugins: extraPlugins,
    ...(pluginRuntime ? { pluginRuntime } : {}),
    siteSeeds,
    stagedFiles,
    secretEnv: (recipe.inputs?.secretEnv ?? []).map((name) => ({
      name,
      available: process.env[name] !== undefined,
    })),
    policy: {
      ...policy,
      valid: policyValidation.valid,
      issues: policyValidation.issues,
    },
    workflow: {
      ...(recipe.workflow.before ? { before: workflowSteps.filter((step) => step.phase === "before") } : {}),
      steps: workflowSteps,
      ...(recipe.workflow.after ? { after: workflowSteps.filter((step) => step.phase === "after") } : {}),
    },
  }
}

function printJsonFailureDiagnostic(output: { success: boolean; error?: { message?: string }; logs?: string[] }): void {
  if (output.success) {
    return
  }

  const message = output.error?.message?.trim()
  if (message) {
    console.error(message)
  }

  for (const log of output.logs ?? []) {
    const trimmed = log.trim()
    if (trimmed) {
      console.error(trimmed)
    }
  }
}

class RecipeInterruptedError extends Error {
  readonly code = "recipe-interrupted"

  constructor(readonly signal: RecipeInterruptionSignal, readonly receivedAt: string) {
    super(`Recipe run interrupted by ${signal}`)
    this.name = "RecipeInterruptedError"
  }
}

function createRecipeInterruptionController(): RecipeInterruptionController {
  let metadata: RecipeInterruptionMetadata | undefined
  let rejectInterrupted: ((error: RecipeInterruptedError) => void) | undefined
  let installed = false
  const signals: RecipeInterruptionSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  const handler = (signal: RecipeInterruptionSignal): void => {
    if (!metadata) {
      metadata = { signal, receivedAt: new Date().toISOString(), artifactsFinalized: false }
    }
    rejectInterrupted?.(new RecipeInterruptedError(metadata.signal, metadata.receivedAt))
  }

  const controller: RecipeInterruptionController = {
    get metadata() {
      return metadata
    },
    install() {
      if (installed) {
        return
      }
      for (const signal of signals) {
        process.on(signal, handler)
      }
      installed = true
    },
    dispose() {
      if (!installed) {
        return
      }
      for (const signal of signals) {
        process.off(signal, handler)
      }
      installed = false
    },
    async interruptible<T>(promise: Promise<T>): Promise<T> {
      if (metadata) {
        throw new RecipeInterruptedError(metadata.signal, metadata.receivedAt)
      }

      let settled = false
      try {
        return await Promise.race([
          promise.finally(() => {
            settled = true
          }),
          new Promise<T>((_resolve, reject) => {
            rejectInterrupted = (error) => {
              if (!settled) {
                reject(error)
              }
            }
          }),
        ])
      } finally {
        rejectInterrupted = undefined
      }
    },
    throwIfInterrupted() {
      if (metadata) {
        throw new RecipeInterruptedError(metadata.signal, metadata.receivedAt)
      }
    },
    propagateIfInterrupted() {
      if (!metadata) {
        return
      }
      controller.dispose()
      process.kill(process.pid, metadata.signal)
    },
  }

  return controller
}

function markRecipeArtifactsFinalized(interruption: RecipeInterruptionController | undefined, artifactsFinalized: boolean): void {
  if (interruption?.metadata) {
    interruption.metadata.artifactsFinalized = artifactsFinalized
  }
}

function interruptedRecipeOutput<T extends RecipeRunCommandOutput>(output: T, interruption: RecipeInterruptionController | undefined): T {
  if (!interruption?.metadata || output.schema !== "wp-codebox/recipe-run/v1") {
    return output
  }

  return {
    ...output,
    success: false,
    interruption: interruption.metadata,
    error: {
      name: "RecipeInterruptedError",
      message: `Recipe run interrupted by ${interruption.metadata.signal}`,
      code: "recipe-interrupted",
    },
  } as T
}

async function runRecipe(options: RecipeRunOptions, interruption?: RecipeInterruptionController): Promise<RecipeRunOutput> {
  const recipePath = resolve(options.recipePath)
  const recipeDirectory = dirname(recipePath)
  const recipe = parseWorkspaceRecipe(await readFile(recipePath, "utf8"), recipePath)
  const issues = await validateWorkspaceRecipe(recipe, recipePath)
  if (issues.length > 0) {
    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      executions: [],
      validation: { issues },
      error: {
        name: "RecipeValidationError",
        message: `Recipe validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
      },
    }
  }

  const policy = recipePolicy(recipe)
  const secretEnv = resolveSecretEnv(recipe.inputs?.secretEnv ?? [])
  const effectivePolicy = Object.keys(secretEnv).length > 0 ? { ...policy, secrets: "connector-scoped" as const } : policy
  let workspaceMounts: PreparedWorkspaceMount[] = []
  let extraPlugins: PreparedExtraPlugin[] = []
  let stagedFiles: PreparedStagedFile[] = []
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  const executions: RecipeExecutionResult[] = []
  let artifacts: ArtifactBundle | undefined
  const awaitRecipe = <T>(promise: Promise<T>): Promise<T> => interruption ? interruption.interruptible(promise) : promise

  try {
    workspaceMounts = await prepareRecipeWorkspaces(recipe, recipeDirectory)
    extraPlugins = await prepareRecipeExtraPlugins(recipe, recipeDirectory)
    stagedFiles = await prepareRecipeStagedFiles(recipe, recipeDirectory)
    interruption?.throwIfInterrupted()

    runtime = await awaitRecipe(createRuntime(
      {
        backend: recipe.runtime?.backend ?? "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: recipe.runtime?.name ?? "wp-codebox-recipe",
          version: recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: recipe.runtime?.blueprint ?? { steps: [] },
        },
        policy: effectivePolicy,
        secretEnv,
        artifactsDirectory: options.artifactsDirectory ?? recipe.artifacts?.directory,
        metadata: {
          ...runtimeMetadata(options.artifactsDirectory ?? recipe.artifacts?.directory, recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION),
          ...recipeRunMetadata(recipe, recipePath, workspaceMounts, extraPlugins, stagedFiles, options.previewPublicUrl, options.previewPort, options.previewBind),
        },
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    ))
    interruption?.throwIfInterrupted()

    for (const workspace of workspaceMounts) {
      await awaitRecipe(runtime.mount({
        type: "directory",
        source: workspace.source,
        target: workspace.target,
        mode: workspace.mode,
        metadata: workspace.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const plugin of extraPlugins) {
      await awaitRecipe(runtime.mount({
        type: "directory",
        source: plugin.source,
        target: plugin.target,
        mode: "readonly",
        metadata: {
          kind: "extra-plugin",
          slug: plugin.slug,
          source: plugin.provenance,
        },
      }))
      interruption?.throwIfInterrupted()
    }

    for (const mount of recipe.inputs?.mounts ?? []) {
      await awaitRecipe(runtime.mount({
        type: "directory",
        source: resolve(recipeDirectory, mount.source),
        target: mount.target,
        mode: mount.mode ?? "readwrite",
        metadata: mount.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    for (const stagedFile of stagedFiles) {
      await awaitRecipe(runtime.mount({
        type: stagedFile.type,
        source: stagedFile.source,
        target: stagedFile.target,
        mode: "readwrite",
        metadata: stagedFile.metadata,
      }))
      interruption?.throwIfInterrupted()
    }

    const muPluginInstallCode = installMuPluginsCode(extraPlugins)
    if (muPluginInstallCode) {
      executions.push(withRecipeExecutionPhase(await runtime.execute({ command: "wordpress.run-php", args: [`code=${muPluginInstallCode}`] }), "setup", -2))
    }

    const pluginActivationCode = activateExtraPluginsCode(extraPlugins)
    if (pluginActivationCode) {
      executions.push(withRecipeExecutionPhase(await awaitRecipe(runtime.execute({ command: "wordpress.run-php", args: [`code=${pluginActivationCode}`] })), "setup", -1))
      interruption?.throwIfInterrupted()
    }

    for (const [index, setupStep] of (recipe.inputs?.pluginRuntime?.setup ?? []).entries()) {
      executions.push(await awaitRecipe(executeRecipePluginRuntimeStep(runtime, setupStep, recipeDirectory, "setup", index)))
      interruption?.throwIfInterrupted()
    }

    for (const [index, probe] of (recipe.inputs?.pluginRuntime?.healthProbes ?? []).entries()) {
      executions.push(await awaitRecipe(executeRecipePluginRuntimeHealthProbe(runtime, probe, recipeDirectory, index)))
      interruption?.throwIfInterrupted()
    }

    const siteSeeds = await awaitRecipe(importRecipeSiteSeeds(recipe, recipeDirectory, runtime, executions))
    interruption?.throwIfInterrupted()

    for (const workflowStep of recipeWorkflowSteps(recipe)) {
      executions.push(await awaitRecipe(executeRecipeWorkflowStep(runtime, workflowStep, recipeDirectory)))
      interruption?.throwIfInterrupted()
    }

    await awaitRecipe(runtime.observe({ type: "runtime-info" }))
    await awaitRecipe(runtime.observe({ type: "mounts" }))
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const evidence = await finalizeRecipeArtifactEvidence(artifacts, recipe, workspaceMounts, stagedFiles, effectivePolicy, secretEnv)
    const agentEvidence = await finalizeAgentSandboxEvidence(artifacts, executions)
    Object.assign(evidence, agentEvidence)
    markRecipeArtifactsFinalized(interruption, true)
    const strictFailure = recipeArtifactEvidenceFailure(evidence)
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds, () => cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles), interruption)
    interruption?.throwIfInterrupted()

    const benchResultsList = executions
      .filter((execution) => execution.command === "wordpress.bench" && execution.exitCode === 0)
      .map((execution) => parseBenchResults(execution.stdout))

    if (strictFailure) {
      return {
        success: false,
        schema: "wp-codebox/recipe-run/v1",
        recipePath,
        runtime: runtimeInfo ?? await runtime.info(),
        executions,
        stagedFiles: stagedFiles.map(recipeRunStagedFile),
        siteSeeds,
        ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
        ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
        ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
        artifacts,
        error: strictFailure,
      }
    }

    return {
      success: true,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      runtime: runtimeInfo ?? await runtime.info(),
      executions,
      stagedFiles: stagedFiles.map(recipeRunStagedFile),
      siteSeeds,
      ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
      ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
      ...(evidence.agentResult ? { agentResult: recipeAgentResultOutput(evidence.agentResult) } : {}),
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      artifacts = await collectAndFinalizeFailedRecipeArtifacts({
        runtime,
        existingArtifacts: artifacts,
        recipe,
        workspaceMounts,
        stagedFiles,
        policy: effectivePolicy,
        secretEnv,
        executions,
        interruption,
      })

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    await cleanupRecipePreparedSources(workspaceMounts, extraPlugins, stagedFiles)

    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      executions,
      diagnostics: recipeRuntimeDiagnostics(recipe, executions, error),
      ...(artifacts ? { artifacts } : {}),
      ...(interruption?.metadata ? { interruption: interruption.metadata } : {}),
      error: serializeError(error),
    }
  }
}

async function collectAndFinalizeFailedRecipeArtifacts(args: {
  runtime: Runtime
  existingArtifacts?: ArtifactBundle
  recipe: WorkspaceRecipe
  workspaceMounts: PreparedWorkspaceMount[]
  stagedFiles: PreparedStagedFile[]
  policy: RuntimePolicy
  secretEnv: Record<string, string>
  executions: RecipeExecutionResult[]
  interruption?: RecipeInterruptionController
}): Promise<ArtifactBundle | undefined> {
  let artifacts = args.existingArtifacts

  if (!artifacts) {
    try {
      artifacts = await args.runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
    } catch {
      return undefined
    }
  }

  try {
    await finalizeRecipeArtifactEvidence(artifacts, args.recipe, args.workspaceMounts, args.stagedFiles, args.policy, args.secretEnv)
    await finalizeAgentSandboxEvidence(artifacts, args.executions)
    markRecipeArtifactsFinalized(args.interruption, true)
  } catch {
    markRecipeArtifactsFinalized(args.interruption, true)
  }

  return artifacts
}

async function finalizeRecipeArtifactEvidence(
  artifacts: ArtifactBundle,
  recipe: WorkspaceRecipe,
  workspaceMounts: PreparedWorkspaceMount[],
  stagedFiles: PreparedStagedFile[],
  policy: RuntimePolicy,
  secretEnv: Record<string, string>,
): Promise<RecipeArtifactEvidenceResult> {
  const result: RecipeArtifactEvidenceResult = {}
  const verifier = normalizeArtifactToggle(recipe.artifacts?.verify)
  const workspacePolicy = normalizeWorkspacePolicyArtifact(recipe.artifacts?.workspacePolicy)

  const evidenceDirectory = join(dirname(artifacts.reviewPath), "runtime-evidence")
  await mkdir(evidenceDirectory, { recursive: true })

  const evidenceFiles: RecipeArtifactEvidenceFile[] = []
  if (workspacePolicy.enabled) {
    const workspacePolicyPath = join(evidenceDirectory, "workspace-policy.json")
    const policyResult = await buildRecipeWorkspacePolicyResult(recipe, workspaceMounts, stagedFiles, workspacePolicy)
    const policyFile = await writeRecipeEvidenceJson(artifacts.directory, workspacePolicyPath, policyResult, "workspace-policy-result")
    artifacts.workspacePolicyPath = workspacePolicyPath
    evidenceFiles.push(policyFile)
    result.workspacePolicy = {
      ...policyResult,
      artifact: policyFile,
      strict: workspacePolicy.strict,
    }
  }

  if (verifier.enabled) {
    const verificationPath = join(evidenceDirectory, "artifact-bundle-verification.json")
    const placeholder = {
      schema: "wp-codebox/artifact-bundle-verification/v1",
      bundleDirectory: artifacts.directory,
      valid: false,
      violations: [],
      status: "pending",
    }
    const placeholderFile = await writeRecipeEvidenceJson(artifacts.directory, verificationPath, placeholder, "artifact-bundle-verification")
    artifacts.artifactVerificationPath = verificationPath
    evidenceFiles.push(placeholderFile)
    await updateRecipeArtifactEvidenceReferences(artifacts, evidenceFiles)

    const verification = await verifyArtifactBundle(artifacts.directory)
    const verificationFile = await writeRecipeEvidenceJson(artifacts.directory, verificationPath, verification, "artifact-bundle-verification")
    const verificationFiles = evidenceFiles.map((file) => file.path === verificationFile.path ? verificationFile : file)
    await updateRecipeArtifactEvidenceReferences(artifacts, verificationFiles)
    result.artifactVerification = {
      ...verification,
      artifact: verificationFile,
      strict: verifier.strict,
    }
  }

  const attestationPath = join(evidenceDirectory, "run-attestation.json")
  const attestation = await buildRecipeRunAttestation({
    artifacts,
    recipe,
    policy,
    secretEnv,
    workspacePolicy,
    verifier,
    workspacePolicyFile: result.workspacePolicy?.artifact,
    artifactVerificationFile: result.artifactVerification?.artifact,
  })
  const attestationFile = await writeRecipeEvidenceJson(artifacts.directory, attestationPath, attestation, "run-attestation")
  artifacts.runAttestationPath = attestationPath
  evidenceFiles.push(attestationFile)
  result.runAttestation = {
    ...attestation,
    artifact: attestationFile,
  }

  await updateRecipeArtifactEvidenceReferences(artifacts, evidenceFiles)
  return result
}

async function finalizeAgentSandboxEvidence(artifacts: ArtifactBundle, executions: RecipeExecutionResult[]): Promise<Pick<RecipeArtifactEvidenceResult, "agentResult" | "transcript">> {
  const transcript = buildAgentSandboxTranscript(executions)
  if (transcript.executions.length === 0) {
    return {}
  }

  const transcriptPath = join(dirname(artifacts.reviewPath), "transcript.json")
  const agentResultPath = join(dirname(artifacts.reviewPath), "agent-result.json")
  const transcriptFile = await writeRecipeEvidenceJson(artifacts.directory, transcriptPath, transcript, "agent-transcript")
  const agentResult = await buildAgentSandboxResultSummary(artifacts, transcript, transcriptFile.path)
  const agentResultFile = await writeRecipeEvidenceJson(artifacts.directory, agentResultPath, agentResult, "agent-result")
  await updateRecipeArtifactEvidenceReferences(artifacts, [agentResultFile, transcriptFile])

  return {
    agentResult: { ...agentResult, artifact: agentResultFile },
    transcript: { ...transcript, artifact: transcriptFile },
  }
}

function buildAgentSandboxTranscript(executions: RecipeExecutionResult[]): AgentSandboxTranscript {
  return {
    schema: "wp-codebox/agent-transcript/v1",
    executions: executions
      .map((execution, index) => ({ execution, index }))
      .filter(({ execution }) => isAgentSandboxExecution(execution))
      .map(({ execution, index }) => ({
        executionIndex: index,
        command: execution.command,
        exitCode: execution.exitCode,
        recipePhase: execution.recipePhase,
        recipeStepIndex: execution.recipeStepIndex,
        recipeCommand: execution.recipeCommand,
        stdout: boundTranscriptText(execution.stdout),
        stderr: boundTranscriptText(execution.stderr),
        ...(decodeJsonFragment(execution.stdout) ?? decodeJsonFragment(execution.stderr) ? { parsed: decodeJsonFragment(execution.stdout) ?? decodeJsonFragment(execution.stderr) } : {}),
      })),
  }
}

function isAgentSandboxExecution(execution: RecipeExecutionResult): boolean {
  return execution.recipeCommand === "wp-codebox.agent-sandbox-run"
}

async function buildAgentSandboxResultSummary(artifacts: ArtifactBundle, transcript: AgentSandboxTranscript, transcriptPath: string): Promise<AgentSandboxResultSummary> {
  const changedFiles = await readChangedFileSummary(artifacts.changedFilesPath)
  const patch = await readPatchSummary(artifacts.patchPath)
  const failures = transcript.executions
    .filter((execution) => execution.exitCode !== 0)
    .map((execution) => ({
      executionIndex: execution.executionIndex,
      command: execution.command,
      exitCode: execution.exitCode,
      message: firstTranscriptMessage(execution) || `Command exited with ${execution.exitCode}`,
    }))
  const status: AgentSandboxResultSummary["status"] = failures.length > 0 ? "failed" : transcript.executions.length > 0 ? "completed" : "unknown"
  const actionable = status === "completed" && (changedFiles.count > 0 || patch.bytes > 0)
  const noOpReason = actionable ? undefined : status === "failed" ? "execution_failed" : "no_file_changes"

  return stripUndefined({
    schema: "wp-codebox/agent-result/v1" as const,
    status,
    actionable,
    summary: actionable
      ? `Agent sandbox produced ${changedFiles.count === 1 ? "1 changed file" : `${changedFiles.count} changed files`} and a ${patch.bytes}-byte patch.`
      : status === "failed"
        ? "Agent sandbox failed before producing actionable file changes."
        : "Agent sandbox completed without actionable file changes.",
    changedFiles,
    patch,
    transcript: {
      artifact: transcriptPath,
      executionCount: transcript.executions.length,
    },
    artifacts: {
      directory: artifacts.directory,
      review: relative(artifacts.directory, artifacts.reviewPath),
      manifest: relative(artifacts.directory, artifacts.manifestPath),
    },
    failures,
    noOpReason,
    workspaceTools: workspaceToolDiagnostics(transcript),
  })
}

async function readChangedFileSummary(path: string): Promise<AgentSandboxResultSummary["changedFiles"]> {
  try {
    const decoded = JSON.parse(await readFile(path, "utf8"))
    const files: Record<string, unknown>[] = Array.isArray(decoded?.files) ? decoded.files.filter(isRecord) : []
    const statuses: Record<string, number> = {}
    for (const file of files) {
      const status = typeof file.status === "string" && file.status.length > 0 ? file.status : "unknown"
      statuses[status] = (statuses[status] ?? 0) + 1
    }

    return {
      count: files.length,
      paths: files.map((file) => String(file.relativePath ?? file.relative_path ?? file.path ?? "")).filter(Boolean),
      statuses,
      artifact: "files/changed-files.json",
    }
  } catch {
    return { count: 0, paths: [], statuses: {}, artifact: "files/changed-files.json" }
  }
}

async function readPatchSummary(path: string): Promise<AgentSandboxResultSummary["patch"]> {
  try {
    const patch = await readFile(path, "utf8")
    return {
      bytes: Buffer.byteLength(patch),
      sha256: createHash("sha256").update(patch).digest("hex"),
      artifact: "files/patch.diff",
    }
  } catch {
    return { bytes: 0, sha256: createHash("sha256").update("").digest("hex"), artifact: "files/patch.diff" }
  }
}

function firstTranscriptMessage(execution: AgentSandboxTranscriptExecution): string {
  const parsed = isRecord(execution.parsed) ? execution.parsed : undefined
  const result = isRecord(parsed?.result) ? parsed.result : parsed
  for (const key of ["message", "error", "error_message", "errorMessage", "answer"]) {
    const value = result?.[key]
    if (typeof value === "string" && value.trim()) {
      return boundTranscriptText(value.trim(), 500)
    }
  }

  return boundTranscriptText(execution.stderr || execution.stdout, 500)
}

function workspaceToolDiagnostics(transcript: AgentSandboxTranscript): AgentSandboxResultSummary["workspaceTools"] | undefined {
  const diagnostics = new Set<string>()
  const text = transcript.executions.map((execution) => `${execution.stdout}\n${execution.stderr}`).join("\n").toLowerCase()
  if (text.includes("workspace") && /not found|unknown tool|tool_not_found|tool not found|not available/.test(text)) {
    diagnostics.add("workspace-tool-unavailable")
  }
  if (/permission denied|not allowlisted|not allowed|forbidden/.test(text)) {
    diagnostics.add("workspace-tool-denied")
  }
  if (text.includes("workspace_apply_patch") || text.includes("workspace-edit") || text.includes("workspace_write")) {
    diagnostics.add("workspace-tool-surface-observed")
  }

  return diagnostics.size > 0 ? { diagnostics: [...diagnostics].sort() } : undefined
}

function recipeAgentResultOutput(agentResult: RecipeArtifactEvidenceResult["agentResult"]): AgentSandboxResultSummary | undefined {
  if (!agentResult) {
    return undefined
  }

  const { artifact: _artifact, ...result } = agentResult
  return result
}

function decodeJsonFragment(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) {
    return undefined
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end <= start) {
      return undefined
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

function boundTranscriptText(text: string, maxLength = 12000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} bytes]` : text
}

async function buildRecipeRunAttestation(args: {
  artifacts: ArtifactBundle
  recipe: WorkspaceRecipe
  policy: RuntimePolicy
  secretEnv: Record<string, string>
  workspacePolicy: { enabled: boolean; strict: boolean }
  verifier: { enabled: boolean; strict: boolean }
  workspacePolicyFile?: RecipeArtifactEvidenceFile
  artifactVerificationFile?: RecipeArtifactEvidenceFile
}): Promise<RecipeRunAttestation> {
  const manifest = JSON.parse(await readFile(args.artifacts.manifestPath, "utf8")) as { runtime?: RuntimeInfo }
  const runtime = manifest.runtime ?? {
    id: "unknown",
    backend: args.recipe.runtime?.backend ?? "wordpress-playground",
    environment: {
      kind: "wordpress",
      name: args.recipe.runtime?.name ?? "wp-codebox-recipe",
      version: args.recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
    },
    createdAt: args.artifacts.createdAt,
    status: "destroyed" as const,
  }
  const rootPackage = await readPackageJson(resolve(workspaceRoot, "package.json"))
  const backendPackage = await readPackageJson(resolve(moduleDirectory, "..", "..", "runtime-playground", "package.json"))
  const commit = await readGitCommit(workspaceRoot)
  const workspacePolicyRef = args.workspacePolicyFile ? evidenceRef(args.workspacePolicyFile) : undefined
  const artifactVerificationRef = args.artifactVerificationFile ? evidenceRef(args.artifactVerificationFile) : undefined
  const workspacePolicyEnforcement = evidencePolicyEnforcement(args.workspacePolicy.enabled, args.workspacePolicy.strict)
  const verifierEnforcement = evidencePolicyEnforcement(args.verifier.enabled, args.verifier.strict)

  return {
    schema: "wp-codebox/run-attestation/v1",
    createdAt: new Date().toISOString(),
    package: stripUndefined({
      name: "wp-codebox",
      version: typeof rootPackage.version === "string" ? rootPackage.version : undefined,
      commit,
    }),
    backend: stripUndefined({
      kind: runtime.backend,
      package: stripUndefined({
        name: typeof backendPackage.name === "string" ? backendPackage.name : "@chubes4/wp-codebox-playground",
        version: typeof backendPackage.version === "string" ? backendPackage.version : undefined,
      }),
      engine: stripUndefined({
        name: "@wp-playground/cli",
        version: packageDependencyVersion(backendPackage, "@wp-playground/cli"),
      }),
    }),
    runtime: stripUndefined({
      kind: runtime.environment.kind,
      name: runtime.environment.name,
      version: runtime.environment.version,
      immutableRef: runtime.environment.version,
    }),
    policy: {
      command: {
        sha256: sha256Json(args.policy.commands),
        allowedCommands: args.policy.commands,
        enforcement: "enforced",
      },
      network: enforcedPolicyField(args.policy.network),
      filesystem: enforcedPolicyField(args.policy.filesystem),
      secrets: enforcedPolicyField(args.policy.secrets),
      approvals: enforcedPolicyField(args.policy.approvals),
      workspace: stripUndefined({
        enabled: args.workspacePolicy.enabled,
        strict: args.workspacePolicy.strict,
        enforcement: workspacePolicyEnforcement,
        sha256: args.workspacePolicyFile?.sha256,
        resultRef: workspacePolicyRef,
      }),
      artifactVerifier: stripUndefined({
        enabled: args.verifier.enabled,
        strict: args.verifier.strict,
        enforcement: verifierEnforcement,
        sha256: args.artifactVerificationFile?.sha256,
        resultRef: artifactVerificationRef,
      }),
    },
    secretEnvelope: {
      schema: "wp-codebox/redacted-secret-envelope/v1",
      provided: Object.keys(args.secretEnv).length > 0,
      count: Object.keys(args.secretEnv).length,
      secrets: Object.keys(args.secretEnv).sort().map((name) => ({ name, status: "available", source: "recipe-secret-env" })),
      redaction: "names-only",
    },
    evidenceRefs: stripUndefined({
      workspacePolicyResult: workspacePolicyRef,
      artifactVerifierResult: artifactVerificationRef,
    }),
    sealed: {
      enforced: [
        "command-policy",
        "network-policy",
        "filesystem-policy",
        "secret-policy",
        "approval-policy",
        ...(args.workspacePolicy.strict ? ["workspace-policy"] : []),
        ...(args.verifier.strict ? ["artifact-verifier"] : []),
      ],
      declarative: [
        ...(!args.workspacePolicy.enabled || args.workspacePolicy.strict ? [] : ["workspace-policy"]),
        ...(!args.verifier.enabled || args.verifier.strict ? [] : ["artifact-verifier"]),
      ],
    },
  }
}

function enforcedPolicyField(value: RuntimePolicy[keyof RuntimePolicy]): RunAttestationPolicyField {
  return { value, enforcement: "enforced" }
}

function evidencePolicyEnforcement(enabled: boolean, strict: boolean): RunAttestationEvidencePolicy["enforcement"] {
  if (!enabled) {
    return "not-configured"
  }
  return strict ? "enforced" : "declarative"
}

function evidenceRef(file: RecipeArtifactEvidenceFile): RunAttestationEvidenceRef {
  return {
    path: file.path,
    sha256: file.sha256,
    kind: file.kind,
  }
}

async function readPackageJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function packageDependencyVersion(packageJson: Record<string, unknown>, name: string): string | undefined {
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const dependencies = packageJson[key]
    if (isRecord(dependencies) && typeof dependencies[name] === "string") {
      return dependencies[name]
    }
  }
  return undefined
}

async function readGitCommit(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
    const commit = stdout.trim()
    return /^[a-f0-9]{40}$/i.test(commit) ? commit : undefined
  } catch {
    return undefined
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(`${stableJson(value)}\n`).digest("hex")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function recipeArtifactEvidenceFailure(evidence: RecipeArtifactEvidenceResult): RunOutput["error"] | undefined {
  if (evidence.artifactVerification?.strict && !evidence.artifactVerification.valid) {
    return {
      name: "ArtifactVerificationError",
      code: "artifact-verification-failed",
      message: `Artifact verification failed with ${evidence.artifactVerification.violations.length} violation${evidence.artifactVerification.violations.length === 1 ? "" : "s"}.`,
    }
  }

  if (evidence.workspacePolicy?.strict && !evidence.workspacePolicy.passed) {
    const violations = evidence.workspacePolicy.checks.reduce((count, check) => count + check.result.violations.length, 0)
    return {
      name: "WorkspacePolicyError",
      code: "workspace-policy-failed",
      message: `Workspace policy failed with ${violations} violation${violations === 1 ? "" : "s"}.`,
    }
  }

  return undefined
}

function normalizeArtifactToggle(value: boolean | { enabled?: boolean; strict?: boolean } | undefined): { enabled: boolean; strict: boolean } {
  if (value === undefined || value === false) {
    return { enabled: false, strict: false }
  }
  if (value === true) {
    return { enabled: true, strict: false }
  }
  if (value && typeof value === "object") {
    return { enabled: value.enabled !== false, strict: value.strict === true }
  }
  return { enabled: false, strict: false }
}

function normalizeWorkspacePolicyArtifact(value: boolean | { enabled?: boolean; strict?: boolean; writableRoots?: string[]; hiddenPaths?: string[]; gitBacked?: boolean } | undefined): {
  enabled: boolean
  strict: boolean
  writableRoots: string[]
  hiddenPaths: string[]
  gitBacked: boolean
} {
  if (value === undefined || value === false) {
    return { enabled: false, strict: false, writableRoots: ["."], hiddenPaths: [], gitBacked: false }
  }
  if (value === true) {
    return { enabled: true, strict: false, writableRoots: ["."], hiddenPaths: [], gitBacked: false }
  }
  if (value && typeof value === "object") {
    return {
      enabled: value.enabled !== false,
      strict: value.strict === true,
      writableRoots: Array.isArray(value.writableRoots) && value.writableRoots.length > 0 ? value.writableRoots : ["."],
      hiddenPaths: Array.isArray(value.hiddenPaths) ? value.hiddenPaths : [],
      gitBacked: value.gitBacked === true,
    }
  }
  return { enabled: false, strict: false, writableRoots: ["."], hiddenPaths: [], gitBacked: false }
}

async function buildRecipeWorkspacePolicyResult(
  recipe: WorkspaceRecipe,
  workspaceMounts: PreparedWorkspaceMount[],
  stagedFiles: PreparedStagedFile[],
  policy: { writableRoots: string[]; hiddenPaths: string[]; gitBacked: boolean },
): Promise<RecipeWorkspacePolicyArtifactResult> {
  const checks = []
  for (const workspace of workspaceMounts.filter((mount) => mount.mode === "readwrite")) {
    checks.push({
      workspace: {
        target: workspace.target,
        mode: workspace.mode,
        metadata: workspace.metadata,
      },
      result: await checkWorkspacePolicy({
        workspaceRoot: workspace.source,
        writableRoots: policy.writableRoots,
        hiddenPaths: policy.hiddenPaths,
        gitBacked: policy.gitBacked,
      }),
    })
  }

  for (const [index, mount] of (recipe.inputs?.mounts ?? []).entries()) {
    if ((mount.mode ?? "readwrite") !== "readwrite") {
      continue
    }
    checks.push(uncheckedReadwriteInputPolicyCheck(`inputs.mounts[${index}]`, mount.target, mount.metadata))
  }

  for (const [index, stagedFile] of stagedFiles.entries()) {
    checks.push(uncheckedReadwriteInputPolicyCheck(`inputs.stagedFiles[${index}]`, stagedFile.target, stagedFile.metadata))
  }

  return {
    schema: "wp-codebox/workspace-policy-artifacts/v1",
    passed: checks.every((check) => check.result.passed),
    checks,
  }
}

function uncheckedReadwriteInputPolicyCheck(sourceField: string, target: string, metadata?: Record<string, unknown>): RecipeWorkspacePolicyArtifactResult["checks"][number] {
  return {
    workspace: {
      target,
      mode: "readwrite",
      metadata: { ...(metadata ?? {}), sourceField },
    },
    result: {
      schema: "wp-codebox/workspace-policy-result/v1",
      passed: false,
      policy_sha256: createHash("sha256").update(JSON.stringify({ sourceField, target })).digest("hex"),
      violations: [
        {
          code: "path-outside-workspace",
          path: target,
          message: `${sourceField} is mounted readwrite but is not a declared workspace policy root. Use inputs.workspaces for policy-checked writable sources or make the mount readonly.`,
          details: { sourceField, target },
        },
      ],
    },
  }
}

async function writeRecipeEvidenceJson(artifactRoot: string, path: string, value: unknown, kind: string): Promise<RecipeArtifactEvidenceFile> {
  const json = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(path, json)
  return {
    path: relative(artifactRoot, path),
    sha256: createHash("sha256").update(json).digest("hex"),
    kind,
    contentType: "application/json",
  }
}

async function updateRecipeArtifactEvidenceReferences(artifacts: ArtifactBundle, evidenceFiles: RecipeArtifactEvidenceFile[]): Promise<void> {
  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  manifest.files = Array.isArray(manifest.files) ? manifest.files : []
  for (const file of evidenceFiles) {
    const existing = manifest.files.find((entry) => entry.path === file.path)
    const manifestFile = { path: file.path, kind: file.kind, contentType: file.contentType, sha256: { algorithm: "sha256" as const, value: file.sha256 } }
    if (existing) {
      Object.assign(existing, manifestFile)
    } else {
      manifest.files.push(manifestFile)
    }
  }

  const evidence = Object.fromEntries(evidenceFiles.map((file) => [file.kind, { path: file.path, sha256: file.sha256 }]))
  const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8")) as Record<string, unknown>
  const metadataArtifacts = isRecord(metadata.artifacts) ? metadata.artifacts : {}
  const metadataEvidence = isRecord(metadata.evidence) ? metadata.evidence : {}
  metadata.artifacts = { ...metadataArtifacts, runtimeEvidence: { ...(isRecord(metadataArtifacts.runtimeEvidence) ? metadataArtifacts.runtimeEvidence : {}), ...evidence } }
  metadata.evidence = { ...metadataEvidence, runtimeEvidence: { ...(isRecord(metadataEvidence.runtimeEvidence) ? metadataEvidence.runtimeEvidence : {}), ...evidence } }
  await writeFile(artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8")) as Record<string, unknown>
  const reviewEvidence = isRecord(review.evidence) ? review.evidence : {}
  review.evidence = { ...reviewEvidence, runtimeEvidence: { ...(isRecord(reviewEvidence.runtimeEvidence) ? reviewEvidence.runtimeEvidence : {}), ...evidence } }
  await writeFile(artifacts.reviewPath, `${JSON.stringify(review, null, 2)}\n`)

  for (const file of manifest.files) {
    if (file.path !== "manifest.json") {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(artifacts.directory, manifest, file) }
    }
  }
  for (const file of manifest.files) {
    if (file.path === "manifest.json") {
      file.sha256 = { algorithm: "sha256", value: await calculateArtifactManifestFileSha256(artifacts.directory, manifest, file) }
    }
  }
  await writeFile(artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function validateRecipe(options: RecipeValidateOptions): Promise<RecipeValidateOutput> {
  const recipePath = resolve(options.recipePath)
  try {
    const raw = await readFile(recipePath, "utf8")
    const recipe = parseWorkspaceRecipe(raw, recipePath)
    const issues = await validateWorkspaceRecipe(recipe, recipePath)

    return {
      success: issues.length === 0,
      schema: "wp-codebox/recipe-validation/v1",
      recipePath,
      valid: issues.length === 0,
      issues,
      summary: {
        steps: recipeWorkflowSteps(recipe).length,
        mounts: recipe.inputs?.mounts?.length ?? 0,
        workspaces: recipe.inputs?.workspaces?.length ?? 0,
        extraPlugins: recipeExtraPlugins(recipe).length,
        stagedFiles: recipe.inputs?.stagedFiles?.length ?? 0,
      },
    }
  } catch (error) {
    return {
      success: false,
      schema: "wp-codebox/recipe-validation/v1",
      recipePath,
      valid: false,
      issues: [
        {
          code: "invalid-recipe",
          path: "$",
          message: error instanceof SyntaxError ? `Recipe JSON is invalid: ${error.message}` : error instanceof Error ? error.message : String(error),
        },
      ],
      error: serializeError(error),
    }
  }
}

async function verifyArtifacts(options: ArtifactVerifyOptions): Promise<ArtifactBundleVerificationResult> {
  return verifyArtifactBundle(resolve(options.bundleDirectory))
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, callback: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await callback(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function agentRuntimeMounts(options: AgentRuntimeProbeOptions): RunOptions["mounts"] {
  return [
    componentMount(options.agentsApiPath, "/wordpress/wp-content/plugins/agents-api", "agents-api"),
    componentMount(options.dataMachinePath, "/wordpress/wp-content/plugins/data-machine", "data-machine"),
    componentMount(options.dataMachineCodePath, "/wordpress/wp-content/plugins/data-machine-code", "data-machine-code"),
    ...providerPluginMounts(options).map((plugin) => ({
      source: plugin.source,
      target: `/wordpress/wp-content/plugins/${plugin.slug}`,
      mode: "readonly" as const,
      metadata: {
        kind: "provider-plugin",
        slug: plugin.slug,
      },
    })),
    ...options.mounts,
  ]
}

function componentMount(source: string, target: string, slug: string): RunOptions["mounts"][number] {
  return {
    source: resolve(source),
    target,
    mode: "readonly",
    metadata: {
      kind: "component",
      slug,
    },
  }
}

async function recipeExecutionSpec(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string): Promise<{ command: string; args: string[] }> {
  if (step.command === "wp-codebox.agent-runtime-probe") {
    return {
      command: "wordpress.run-php",
      args: [`code=${agentRuntimeProbeCode(providerPluginSlugs(step.args ?? []).map((slug) => ({ source: "", slug })))}`],
    }
  }

  if (step.command === "wp-codebox.agent-sandbox-run") {
    const args = step.args ?? []
    const task = argValue(args, "task")
    if (!task) {
      throw new Error("wp-codebox.agent-sandbox-run requires task=<task>")
    }

    const codeFile = argValue(args, "code-file")
    const code = argValue(args, "code")
    if (code && codeFile) {
      throw new Error("Use either code=<php> or code-file=<path>, not both")
    }
    const body = codeFile ? await readFile(resolve(recipeDirectory, codeFile), "utf8") : (code ?? await resolveSandboxTaskCode({
      task,
      agent: argValue(args, "agent"),
      mode: argValue(args, "mode"),
      provider: argValue(args, "provider"),
      model: argValue(args, "model"),
      sessionId: argValue(args, "session-id"),
      maxTurns: argValue(args, "max-turns"),
      timeoutSeconds: argValue(args, "timeout-seconds"),
    }))

    return {
      command: "wordpress.run-php",
      args: [
        `code=${agentSandboxRunCode(task, body, providerPluginSlugs(args).map((slug) => ({ source: "", slug })))}`,
        "wp-cli-bridge=1",
      ],
    }
  }

  return { command: step.command, args: step.args ?? [] }
}

function argValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function providerPluginSlugs(args: string[]): string[] {
  const csv = argValue(args, "provider-plugin-slugs") ?? ""
  return csv.split(",").map((slug) => slug.trim()).filter(Boolean)
}

function providerPluginMounts(options: AgentRuntimeProbeOptions): Array<{ source: string; slug: string }> {
  return options.providerPluginPaths.map((pluginPath) => {
    const source = resolve(pluginPath)
    return { source, slug: basename(source) }
  })
}

function runtimeMetadata(artifactsDirectory: string | undefined, wpVersion: string): Record<string, unknown> {
  return {
    runtime: {
      version: WP_CODEBOX_RUNTIME_VERSION,
      wordpressVersion: wpVersion,
    },
    task: {
      artifactsDirectory,
    },
  }
}

function previewSpec(publicUrl: string | undefined, port: number | undefined, bind: string | undefined): { publicUrl?: string; siteUrl?: string; port?: number; bind?: string } | undefined {
  if (bind && port === undefined) {
    throw new Error("--preview-bind requires --preview-port because upstream Playground does not expose bind-host control yet")
  }

  if (!publicUrl && port === undefined && !bind) {
    return undefined
  }

  return stripUndefined({
    publicUrl,
    siteUrl: publicUrl,
    port,
    bind,
  })
}

function runMetadata(options: RunOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "cli-run",
      command: options.command,
      args: options.args,
      artifactsDirectory: options.artifactsDirectory,
      previewPublicUrl: options.previewPublicUrl,
      previewPort: options.previewPort,
      previewBind: options.previewBind,
    }),
  }
}

function bootMetadata(options: BootOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "cli-boot",
      artifactsDirectory: options.artifactsDirectory,
      previewPublicUrl: options.previewPublicUrl,
      previewPort: options.previewPort,
      previewBind: options.previewBind,
    }),
  }
}

function blueprintValidationMetadata(options: BlueprintValidateOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "blueprint-validation",
      blueprintPath: options.blueprintPath,
      artifactsDirectory: options.artifactsDirectory,
      previewPublicUrl: options.previewPublicUrl,
      previewPort: options.previewPort,
      previewBind: options.previewBind,
    }),
  }
}

function agentRuntimeMetadata(options: AgentRuntimeProbeOptions): Record<string, unknown> {
  const base = runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION)

  return {
    ...base,
    task: {
      ...(base.task as Record<string, unknown>),
      kind: "agent-runtime-probe",
      secretEnv: options.secretEnvNames ?? [],
    },
  }
}

function agentSandboxRunMetadata(options: AgentSandboxRunOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "agent-sandbox-run",
      input: options.task,
      sessionId: options.sessionId,
      maxTurns: options.maxTurns,
      timeoutSeconds: options.timeoutSeconds,
      hasCodeOverride: Boolean(options.code || options.codeFile),
      secretEnv: options.secretEnvNames ?? [],
    }),
    agent: stripUndefined({
      agent: options.agent,
      mode: options.mode,
      provider: options.provider,
      model: options.model,
    }),
  }
}

function parseAgentRuntimeProbeOptions(args: string[], extraOptions: string[] = []): AgentRuntimeProbeOptions {
  const options: Partial<AgentRuntimeProbeOptions> = { json: false, mounts: [] }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--agents-api":
        options.agentsApiPath = value
        break
      case "--data-machine":
        options.dataMachinePath = value
        break
      case "--data-machine-code":
        options.dataMachineCodePath = value
        break
      case "--provider-plugin":
        options.providerPluginPaths = [...(options.providerPluginPaths ?? []), value]
        break
      case "--mount":
        options.mounts = [...(options.mounts ?? []), parseMount(value)]
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--secret-env":
        options.secretEnvNames = [...(options.secretEnvNames ?? []), value]
        break
      default:
        if (extraOptions.includes(name)) {
          break
        }
        throw new Error(`Unknown option: ${name}`)
    }
  }

  for (const [key, option] of [
    ["--agents-api", options.agentsApiPath],
    ["--data-machine", options.dataMachinePath],
    ["--data-machine-code", options.dataMachineCodePath],
  ] as const) {
    if (!option) {
      throw new Error(`Missing required option: ${key}`)
    }
  }

  options.providerPluginPaths = options.providerPluginPaths ?? []
  options.mounts = options.mounts ?? []

  return options as AgentRuntimeProbeOptions
}

function parseAgentSandboxRunOptions(args: string[]): AgentSandboxRunOptions {
  const options = parseAgentRuntimeProbeOptions(args, ["--task", "--agent", "--mode", "--provider", "--model", "--session-id", "--max-turns", "--timeout-seconds", "--code", "--code-file", "--secret-env", "--mount"]) as Partial<AgentSandboxRunOptions>

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[index + 1]

    switch (name) {
      case "--task":
        options.task = value
        break
      case "--agent":
        options.agent = value
        break
      case "--mode":
        options.mode = value
        break
      case "--provider":
        options.provider = value
        break
      case "--model":
        options.model = value
        break
      case "--session-id":
        options.sessionId = value
        break
      case "--max-turns":
        options.maxTurns = value
        break
      case "--timeout-seconds":
        options.timeoutSeconds = value
        break
      case "--code":
        options.code = value
        break
      case "--code-file":
        options.codeFile = value
        break
    }
  }

  if (!options.task) {
    throw new Error("Missing required option: --task")
  }

  if (options.code && options.codeFile) {
    throw new Error("Use either --code or --code-file, not both")
  }

  return options as AgentSandboxRunOptions
}

function parseBenchResults(raw: string): BenchResults {
  const parsed = JSON.parse(raw) as BenchResults
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.scenarios)) {
    throw new Error("Bench command did not emit a BenchResults envelope")
  }

  return parsed
}

async function parseAgentSandboxBatchOptions(args: string[]): Promise<AgentSandboxBatchOptions> {
  const options = parseAgentRuntimeProbeOptions(args, ["--task", "--tasks-json", "--tasks-file", "--agent", "--mode", "--provider", "--model", "--max-turns", "--concurrency", "--secret-env", "--mount"]) as Partial<AgentSandboxBatchOptions>
  options.tasks = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[index + 1]

    switch (name) {
      case "--task":
        if (value) {
          options.tasks.push(value)
        }
        break
      case "--tasks-json":
        if (value) {
          options.tasks.push(...parseTaskList(value))
        }
        break
      case "--tasks-file":
        if (value) {
          options.tasks.push(...parseTaskList(await readFile(resolve(value), "utf8")))
        }
        break
      case "--agent":
        options.agent = value
        break
      case "--mode":
        options.mode = value
        break
      case "--provider":
        options.provider = value
        break
      case "--model":
        options.model = value
        break
      case "--max-turns":
        options.maxTurns = value
        break
      case "--concurrency":
        options.concurrency = value
        break
    }
  }

  options.tasks = options.tasks.map((task) => task.trim()).filter(Boolean)
  if (options.tasks.length === 0) {
    throw new Error("Missing required option: --task, --tasks-json, or --tasks-file")
  }

  return options as AgentSandboxBatchOptions
}

function parseTaskList(raw: string): string[] {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error("Task list must be a JSON array")
  }

  return parsed.map((task) => {
    if (typeof task === "string") {
      return task
    }

    if (task && typeof task === "object" && "task" in task && typeof task.task === "string") {
      return task.task
    }

    throw new Error("Task list entries must be strings or objects with a task string")
  })
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolveSecretEnv(names: string[]): Record<string, string> {
  const secretEnv: Record<string, string> = {}
  for (const name of names) {
    const normalized = name.trim()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
      throw new Error(`Invalid --secret-env name: ${name}`)
    }

    const value = process.env[normalized]
    if (value) {
      secretEnv[normalized] = value
    }
  }

  return secretEnv
}

async function runSecretEnvOptions(options: AgentRuntimeProbeOptions): Promise<Pick<RunOptions, "policy" | "secretEnv">> {
  const secretEnv = resolveSecretEnv(options.secretEnvNames ?? [])
  if (Object.keys(secretEnv).length === 0) {
    return {}
  }

  return {
    policy: secretEnvPolicy,
    secretEnv,
  }
}

async function run(options: RunOptions): Promise<RunOutput> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let execution: ExecutionResult | undefined
  let artifacts: ArtifactBundle | undefined

  try {
    runtime = await createRuntime(
      {
        backend: "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: "wp-codebox-cli",
          version: options.wpVersion ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: options.blueprint ?? { steps: [] },
        },
        policy: options.policy ?? runPolicy(options.command),
        secretEnv: options.secretEnv,
        artifactsDirectory: options.artifactsDirectory,
        metadata: options.metadata ?? runMetadata(options),
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    )

    for (const mount of options.mounts) {
      await runtime.mount({ type: "directory", source: mount.source, target: mount.target, mode: mount.mode, metadata: mount.metadata })
    }

    execution = await runtime.execute({ command: options.command, args: options.args })
    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds)

    return {
      success: true,
      runtime: runtimeInfo ?? await runtime.info(),
      execution,
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      try {
        artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
      } catch {
        // Preserve the original failure as the CLI result.
      }

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    return {
      success: false,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(execution ? { execution } : {}),
      ...(artifacts ? { artifacts } : {}),
      error: serializeError(error),
    }
  }
}

async function boot(options: BootOptions): Promise<BootOutput> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let artifacts: ArtifactBundle | undefined

  try {
    runtime = await createRuntime(
      {
        backend: "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: "wp-codebox-boot",
          version: options.wpVersion ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: options.blueprint ?? { steps: [] },
        },
        policy: options.policy ?? defaultPolicy,
        artifactsDirectory: options.artifactsDirectory,
        metadata: bootMetadata(options),
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    )

    for (const mount of options.mounts) {
      await runtime.mount({ type: "directory", source: mount.source, target: mount.target, mode: mount.mode, metadata: mount.metadata })
    }

    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds)

    return {
      success: true,
      schema: "wp-codebox/boot/v1",
      runtime: runtimeInfo ?? await runtime.info(),
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      try {
        artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
      } catch {
        // Preserve the original failure as the CLI result.
      }

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    return {
      success: false,
      schema: "wp-codebox/boot/v1",
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(artifacts ? { artifacts } : {}),
      error: serializeError(error),
    }
  }
}

async function validateBlueprint(options: BlueprintValidateOptions): Promise<BlueprintValidateOutput> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let artifacts: ArtifactBundle | undefined

  try {
    runtime = await createRuntime(
      {
        backend: "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: "wp-codebox-blueprint-validation",
          version: options.wpVersion ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: options.blueprint,
        },
        policy: options.policy ?? defaultPolicy,
        artifactsDirectory: options.artifactsDirectory,
        metadata: blueprintValidationMetadata(options),
        preview: previewSpec(options.previewPublicUrl, options.previewPort, options.previewBind),
      },
      createPlaygroundRuntimeBackend(),
    )

    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds)

    return {
      success: true,
      schema: "wp-codebox/blueprint-validation/v1",
      ...(options.blueprintPath ? { blueprintPath: options.blueprintPath } : {}),
      runtime: runtimeInfo ?? await runtime.info(),
      artifacts,
    }
  } catch (error) {
    if (runtime) {
      try {
        artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
      } catch {
        // Preserve the original failure as the CLI result.
      }

      try {
        await runtime.destroy()
      } catch {
        // Preserve the original failure as the CLI result.
      }
    }

    return {
      success: false,
      schema: "wp-codebox/blueprint-validation/v1",
      ...(options.blueprintPath ? { blueprintPath: options.blueprintPath } : {}),
      ...(runtime ? { runtime: await runtime.info() } : {}),
      ...(artifacts ? { artifacts } : {}),
      error: serializeError(error),
    }
  }
}

async function releaseRuntime(runtime: Runtime, previewHoldSeconds = 0, afterDestroy?: () => Promise<void>, interruption?: RecipeInterruptionController): Promise<void> {
  const holdSeconds = Math.max(0, Math.floor(previewHoldSeconds))
  if (holdSeconds === 0) {
    await runtime.destroy()
    await afterDestroy?.()
    return
  }

  try {
    await (interruption ? interruption.interruptible(new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000))) : new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000)))
  } finally {
    await runtime.destroy()
    await afterDestroy?.()
  }
}

async function parseRunOptions(args: string[]): Promise<RunOptions> {
  const options: RunOptions = {
    mounts: [],
    command: "",
    args: [],
    json: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--mount":
        options.mounts.push(parseMount(value))
        break
      case "--command":
        options.command = value
        break
      case "--arg":
        options.args.push(value)
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--preview-hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--policy":
        options.policy = await parsePolicy(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.command) {
    throw new Error("Missing required option: --command")
  }

  if (options.mounts.length === 0) {
    throw new Error("At least one --mount host:vfs value is required")
  }

  return options
}

async function parseBootOptions(args: string[]): Promise<BootOptions> {
  const options: BootOptions = {
    mounts: [],
    json: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--mount":
        options.mounts.push(parseMount(value))
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--blueprint":
        options.blueprint = await parseJsonOption(value)
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--policy":
        options.policy = await parsePolicy(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  return options
}

async function parseBlueprintValidateOptions(args: string[]): Promise<BlueprintValidateOptions> {
  const options: Partial<BlueprintValidateOptions> = { json: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--blueprint":
        options.blueprint = await parseJsonOption(value)
        options.blueprintPath = jsonOptionPath(value)
        break
      case "--wp":
        options.wpVersion = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--preview-hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      case "--policy":
        options.policy = await parsePolicy(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (options.blueprint === undefined) {
    throw new Error("Missing required option: --blueprint")
  }

  return options as BlueprintValidateOptions
}

function parseRecipeRunOptions(args: string[]): RecipeRunOptions {
  const options: Partial<RecipeRunOptions> = { json: false, dryRun: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    if (arg === "--dry-run") {
      options.dryRun = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--recipe":
        options.recipePath = value
        break
      case "--artifacts":
        options.artifactsDirectory = value
        break
      case "--preview-hold":
        options.previewHoldSeconds = parsePreviewHoldSeconds(value)
        break
      case "--preview-public-url":
        options.previewPublicUrl = parsePreviewPublicUrl(value)
        break
      case "--preview-port":
        options.previewPort = parsePreviewPort(value)
        break
      case "--preview-bind":
        options.previewBind = parsePreviewBind(value)
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.recipePath) {
    throw new Error("Missing required option: --recipe")
  }

  return options as RecipeRunOptions
}

function parseRecipeValidateOptions(args: string[]): RecipeValidateOptions {
  const options: Partial<RecipeValidateOptions> = { json: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--recipe":
        options.recipePath = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.recipePath) {
    throw new Error("Missing required option: --recipe")
  }

  return options as RecipeValidateOptions
}

function parseArtifactVerifyOptions(args: string[]): ArtifactVerifyOptions {
  const options: Partial<ArtifactVerifyOptions> = { json: false }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === "--json") {
      options.json = true
      continue
    }

    const [name, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? args[++index]

    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (name) {
      case "--bundle":
      case "--artifacts":
        options.bundleDirectory = value
        break
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.bundleDirectory) {
    throw new Error("Missing required option: --bundle")
  }

  return options as ArtifactVerifyOptions
}

function parseWorkspaceRecipe(raw: string, recipePath: string): WorkspaceRecipe {
  const recipe = JSON.parse(raw) as WorkspaceRecipe

  if (recipe.schema !== "wp-codebox/workspace-recipe/v1") {
    throw new Error(`Unsupported recipe schema in ${recipePath}`)
  }

  if (!recipe.workflow || !Array.isArray(recipe.workflow.steps) || recipe.workflow.steps.length === 0) {
    throw new Error(`Recipe must include at least one workflow step: ${recipePath}`)
  }

  for (const phase of ["before", "after"] as const) {
    if (recipe.workflow[phase] !== undefined && !Array.isArray(recipe.workflow[phase])) {
      throw new Error(`Recipe workflow ${phase} must be an array: ${recipePath}`)
    }
  }

  for (const { phase, step } of recipeWorkflowSteps(recipe)) {
    if (!step || typeof step.command !== "string" || step.command === "") {
      throw new Error(`Recipe workflow ${phase} entries must include a command: ${recipePath}`)
    }

    if (step.args && !Array.isArray(step.args)) {
      throw new Error(`Recipe workflow ${phase} args must be arrays: ${recipePath}`)
    }
  }

  for (const mount of recipe.inputs?.mounts ?? []) {
    if (!mount.source || !mount.target) {
      throw new Error(`Recipe mounts must include source and target: ${recipePath}`)
    }

    if (mount.mode && mount.mode !== "readonly" && mount.mode !== "readwrite") {
      throw new Error(`Recipe mount mode must be readonly or readwrite: ${recipePath}`)
    }

    if (mount.metadata !== undefined && (!mount.metadata || typeof mount.metadata !== "object" || Array.isArray(mount.metadata))) {
      throw new Error(`Recipe mount metadata must be an object when provided: ${recipePath}`)
    }
  }

  const workspaces = recipe.inputs?.workspaces ?? []
  if (!Array.isArray(workspaces)) {
    throw new Error(`Recipe workspaces must be an array: ${recipePath}`)
  }

  for (const workspace of workspaces) {
    if (!workspace.seed || typeof workspace.seed !== "object") {
      throw new Error(`Recipe workspaces entries must include a seed object: ${recipePath}`)
    }

    if (!["plugin_scaffold", "theme_scaffold", "directory"].includes(workspace.seed.type)) {
      throw new Error(`Recipe workspace seed type is unsupported: ${recipePath}`)
    }

    if ((workspace.seed.type === "plugin_scaffold" || workspace.seed.type === "theme_scaffold") && !workspace.seed.slug) {
      throw new Error(`Recipe ${workspace.seed.type} workspace seeds require slug: ${recipePath}`)
    }

    if (workspace.seed.type === "directory" && !workspace.seed.source) {
      throw new Error(`Recipe directory workspace seeds require source: ${recipePath}`)
    }

    if (workspace.mode && workspace.mode !== "readonly" && workspace.mode !== "readwrite") {
      throw new Error(`Recipe workspace mode must be readonly or readwrite: ${recipePath}`)
    }

    if (workspace.sourceMode && workspace.sourceMode !== "repo-backed" && workspace.sourceMode !== "site-backed") {
      throw new Error(`Recipe workspace sourceMode must be repo-backed or site-backed: ${recipePath}`)
    }
  }

  const rawExtraPlugins = recipe.inputs?.extra_plugins ?? recipe.inputs?.extraPlugins
  if (rawExtraPlugins && !Array.isArray(rawExtraPlugins)) {
    throw new Error(`Recipe extra_plugins must be an array: ${recipePath}`)
  }

  for (const plugin of recipeExtraPlugins(recipe)) {
    if (!plugin.source) {
      throw new Error(`Recipe extra_plugins entries must include source: ${recipePath}`)
    }

    if (plugin.slug && !/^[a-z0-9][a-z0-9-_]*$/i.test(plugin.slug)) {
      throw new Error(`Recipe extra_plugins slug must be a plugin-directory slug: ${recipePath}`)
    }

    if (plugin.loadAs && plugin.loadAs !== "plugin" && plugin.loadAs !== "mu-plugin") {
      throw new Error(`Recipe extra_plugins loadAs must be plugin or mu-plugin: ${recipePath}`)
    }
  }

  const pluginRuntime = recipe.inputs?.pluginRuntime
  if (pluginRuntime) {
    if (pluginRuntime.setup && !Array.isArray(pluginRuntime.setup)) {
      throw new Error(`Recipe pluginRuntime setup must be an array: ${recipePath}`)
    }
    if (pluginRuntime.healthProbes && !Array.isArray(pluginRuntime.healthProbes)) {
      throw new Error(`Recipe pluginRuntime healthProbes must be an array: ${recipePath}`)
    }
  }

  const siteSeeds = recipe.inputs?.siteSeeds ?? []
  if (!Array.isArray(siteSeeds)) {
    throw new Error(`Recipe siteSeeds must be an array: ${recipePath}`)
  }

  for (const siteSeed of siteSeeds) {
    if (!siteSeed || typeof siteSeed !== "object") {
      throw new Error(`Recipe siteSeeds entries must be objects: ${recipePath}`)
    }

    if (siteSeed.type !== "fixture" && siteSeed.type !== "parent_site") {
      throw new Error(`Recipe siteSeeds type is unsupported: ${recipePath}`)
    }

    if (!siteSeed.name || typeof siteSeed.name !== "string") {
      throw new Error(`Recipe siteSeeds entries must include name: ${recipePath}`)
    }

    if (siteSeed.type === "fixture" && !siteSeed.source) {
      throw new Error(`Recipe fixture siteSeeds require source: ${recipePath}`)
    }

    if (!siteSeed.scopes || typeof siteSeed.scopes !== "object" || Array.isArray(siteSeed.scopes)) {
      throw new Error(`Recipe siteSeeds entries must include scopes: ${recipePath}`)
    }
  }

  const stagedFiles = recipe.inputs?.stagedFiles ?? []
  if (!Array.isArray(stagedFiles)) {
    throw new Error(`Recipe stagedFiles must be an array: ${recipePath}`)
  }

  for (const stagedFile of stagedFiles) {
    if (!stagedFile || typeof stagedFile !== "object") {
      throw new Error(`Recipe stagedFiles entries must be objects: ${recipePath}`)
    }

    if (!stagedFile.source || typeof stagedFile.source !== "string") {
      throw new Error(`Recipe stagedFiles entries must include source: ${recipePath}`)
    }

    if (!stagedFile.target || typeof stagedFile.target !== "string") {
      throw new Error(`Recipe stagedFiles entries must include target: ${recipePath}`)
    }
  }

  return recipe
}

async function validateWorkspaceRecipe(recipe: WorkspaceRecipe, recipePath: string): Promise<RecipeValidationIssue[]> {
  const recipeDirectory = dirname(recipePath)
  const issues: RecipeValidationIssue[] = []
  const addIssue = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message })
  }

  if (recipe.runtime?.backend && recipe.runtime.backend !== "wordpress-playground") {
    addIssue("unsupported-backend", "$.runtime.backend", `Unsupported recipe backend: ${recipe.runtime.backend}`)
  }

  for (const { phase, index, step } of recipeWorkflowSteps(recipe)) {
    const path = `$.workflow.${phase}[${index}]`
    if (!supportedRecipeCommands.has(step.command)) {
      addIssue("unsupported-command", `${path}.command`, `Unsupported recipe command: ${step.command}`)
      continue
    }

    await validateRecipeStepArgs(step, path, addIssue)
  }

  for (const [index, mount] of (recipe.inputs?.mounts ?? []).entries()) {
    const path = `$.inputs.mounts[${index}]`
    await validateExistingDirectory(resolve(recipeDirectory, mount.source), `${path}.source`, addIssue)
    validateAbsoluteSandboxPath(mount.target, `${path}.target`, addIssue)
  }

  for (const [index, workspace] of (recipe.inputs?.workspaces ?? []).entries()) {
    const path = `$.inputs.workspaces[${index}]`
    if (workspace.seed.type === "directory") {
      await validateExistingDirectory(resolve(recipeDirectory, workspace.seed.source ?? ""), `${path}.seed.source`, addIssue)
    }

    if (workspace.target) {
      validateAbsoluteSandboxPath(workspace.target, `${path}.target`, addIssue)
    }

    if (workspace.seed.slug && !/^[a-z0-9][a-z0-9-_]*$/i.test(workspace.seed.slug)) {
      addIssue("invalid-slug", `${path}.seed.slug`, `Workspace slug must be a plugin/theme directory slug: ${workspace.seed.slug}`)
    }
  }

  for (const [index, plugin] of recipeExtraPlugins(recipe).entries()) {
    const path = `$.inputs.extra_plugins[${index}]`
    let source: ReturnType<typeof recipeSource>
    try {
      source = recipeSource(plugin.source, plugin.sha256)
    } catch (error) {
      addIssue("invalid-source", `${path}.source`, error instanceof Error ? error.message : String(error))
      continue
    }
    const pluginSource = source.type === "local" ? resolve(recipeDirectory, plugin.source) : undefined
    let slug: string
    try {
      slug = recipeExtraPluginSlug(plugin)
    } catch (error) {
      addIssue("invalid-slug", `${path}.slug`, error instanceof Error ? error.message : String(error))
      continue
    }
    const pluginFile = await resolveRecipeExtraPluginFile(plugin, recipeDirectory)

    validateRecipeSource(source, `${path}.source`, addIssue, plugin.sha256)
    if (pluginSource) {
      await validateExistingDirectory(pluginSource, `${path}.source`, addIssue)
    }

    if (!pluginFile.startsWith(`${slug}/`)) {
      addIssue("invalid-plugin-file", `${path}.pluginFile`, `Plugin file must be relative to the mounted plugin slug (${slug}/...).`)
      continue
    }

    if (pluginSource) {
      await validateExistingFile(join(pluginSource, pluginFile.slice(slug.length + 1)), `${path}.pluginFile`, addIssue)
    }
  }

  await validateRecipePluginRuntime(recipe.inputs?.pluginRuntime, addIssue)

  for (const [index, name] of (recipe.inputs?.secretEnv ?? []).entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-secret-env", `$.inputs.secretEnv[${index}]`, `Secret environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
    }
  }

  for (const [index, siteSeed] of (recipe.inputs?.siteSeeds ?? []).entries()) {
    await validateRecipeSiteSeed(siteSeed, recipeDirectory, `$.inputs.siteSeeds[${index}]`, addIssue)
  }

  for (const [index, stagedFile] of (recipe.inputs?.stagedFiles ?? []).entries()) {
    const path = `$.inputs.stagedFiles[${index}]`
    await validateExistingFileOrDirectory(resolve(recipeDirectory, stagedFile.source), `${path}.source`, addIssue)
    validateAbsoluteSandboxPath(stagedFile.target, `${path}.target`, addIssue)
  }

  return issues
}

async function validateRecipePluginRuntime(pluginRuntime: WorkspaceRecipePluginRuntime | undefined, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (!pluginRuntime) {
    return
  }

  const memoryLimit = pluginRuntime.php?.memoryLimit
  if (memoryLimit !== undefined && !/^[0-9]+[KMG]?$/.test(memoryLimit)) {
    addIssue("invalid-plugin-runtime-memory-limit", "$.inputs.pluginRuntime.php.memoryLimit", "Plugin runtime memoryLimit must be a PHP shorthand size such as 256M.")
  }

  const maxExecutionTime = pluginRuntime.php?.maxExecutionTime
  if (maxExecutionTime !== undefined && (!Number.isInteger(maxExecutionTime) || maxExecutionTime < 0 || maxExecutionTime > 3600)) {
    addIssue("invalid-plugin-runtime-max-execution-time", "$.inputs.pluginRuntime.php.maxExecutionTime", "Plugin runtime maxExecutionTime must be an integer from 0 through 3600.")
  }

  for (const [name, value] of Object.entries(pluginRuntime.wpConfigDefines ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      addIssue("invalid-plugin-runtime-wp-config-define", `$.inputs.pluginRuntime.wpConfigDefines.${name}`, "wpConfigDefines keys must be valid PHP constant names.")
    }
    if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
      addIssue("invalid-plugin-runtime-wp-config-define-value", `$.inputs.pluginRuntime.wpConfigDefines.${name}`, "wpConfigDefines values must be string, number, boolean, or null.")
    }
  }

  for (const [index, step] of (pluginRuntime.setup ?? []).entries()) {
    const path = `$.inputs.pluginRuntime.setup[${index}]`
    if (!supportedRecipeCommands.has(step.command)) {
      addIssue("unsupported-plugin-runtime-setup-command", `${path}.command`, `Unsupported plugin runtime setup command: ${step.command}`)
      continue
    }
    await validateRecipeStepArgs(step, path, addIssue)
  }

  for (const [index, probe] of (pluginRuntime.healthProbes ?? []).entries()) {
    const path = `$.inputs.pluginRuntime.healthProbes[${index}]`
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(probe.name)) {
      addIssue("invalid-plugin-runtime-health-probe-name", `${path}.name`, `Plugin runtime health probe names must be stable identifiers: ${probe.name}`)
    }
    if (probe.type === "plugin-active") {
      if (!probe.pluginFile || !/^[^/][^:]*\.php$/.test(probe.pluginFile) || probe.pluginFile.includes("..")) {
        addIssue("invalid-plugin-runtime-health-probe-plugin", `${path}.pluginFile`, "plugin-active health probes require a relative pluginFile ending in .php.")
      }
      continue
    }
    if (probe.type === "php") {
      if (!probe.code || typeof probe.code !== "string") {
        addIssue("missing-plugin-runtime-health-probe-code", `${path}.code`, "php health probes require inline code.")
      }
      continue
    }
    if (probe.type === "wp-cli") {
      if (!probe.command || typeof probe.command !== "string") {
        addIssue("missing-plugin-runtime-health-probe-command", `${path}.command`, "wp-cli health probes require a command.")
      }
      continue
    }
    addIssue("unsupported-plugin-runtime-health-probe", `${path}.type`, `Unsupported plugin runtime health probe type: ${probe.type}`)
  }
}

async function validateRecipeSiteSeed(siteSeed: WorkspaceRecipeSiteSeed, recipeDirectory: string, path: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(siteSeed.name)) {
    addIssue("invalid-site-seed-name", `${path}.name`, `Site seed names must be stable identifiers: ${siteSeed.name}`)
  }

  if (siteSeed.type === "fixture") {
    await validateExistingFile(resolve(recipeDirectory, siteSeed.source ?? ""), `${path}.source`, addIssue)
  }

  if (siteSeed.type === "parent_site" && siteSeed.source) {
    addIssue("invalid-site-seed-source", `${path}.source`, "Parent-site seed declarations must not name a source file until explicit parent export support lands.")
  }

  const scopeEntries = Object.entries(siteSeed.scopes).filter(([, value]) => value !== undefined && value !== false)
  if (scopeEntries.length === 0) {
    addIssue("missing-site-seed-scopes", `${path}.scopes`, "Site seed declarations must opt in to at least one bounded scope.")
  }

  for (const [scopeName, scope] of scopeEntries) {
    if (scope === true) {
      continue
    }

    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      addIssue("invalid-site-seed-scope", `${path}.scopes.${scopeName}`, "Site seed scopes must be objects or explicit true flags where supported.")
      continue
    }

    validateSiteSeedScopeBounds(scope as NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>, `${path}.scopes.${scopeName}`, scopeName, siteSeed.type, addIssue)
  }
}

function validateSiteSeedScopeBounds(scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>, path: string, scopeName: string, seedType: WorkspaceRecipeSiteSeed["type"], addIssue: (code: string, path: string, message: string) => void): void {
  const maxRecords = scope.maxRecords
  if (maxRecords !== undefined && (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100)) {
    addIssue("invalid-site-seed-bound", `${path}.maxRecords`, "Site seed maxRecords must be an integer from 1 through 100.")
  }

  if (seedType === "parent_site" && maxRecords === undefined && !hasExplicitSiteSeedSelectors(scope)) {
    addIssue("unbounded-site-seed-scope", path, "Parent-site scopes require maxRecords or explicit ids/slugs/names selectors before any future export can run.")
  }

  if (scopeName === "options" && (!scope.names || scope.names.length === 0)) {
    addIssue("unbounded-site-seed-options", `${path}.names`, "Option seed scopes must name explicit option keys; wildcard option export is not supported.")
  }

  if (scopeName === "users" && scope.anonymize === false) {
    addIssue("unsafe-site-seed-users", `${path}.anonymize`, "User seed scopes must keep anonymization enabled unless a future importer explicitly supports reviewed identities.")
  }

  if (scopeName === "media" && scope.includeFiles === true && seedType === "parent_site") {
    addIssue("unsafe-site-seed-media-files", `${path}.includeFiles`, "Parent-site media file copying is outside this dry-run-only slice; declare metadata selectors without includeFiles.")
  }
}

function hasExplicitSiteSeedSelectors(scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>): boolean {
  return [scope.ids, scope.slugs, scope.names].some((values) => Array.isArray(values) && values.length > 0)
}

async function validateRecipeStepArgs(step: WorkspaceRecipe["workflow"]["steps"][number], path: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (step.command === "wordpress.run-php" || step.command === "wordpress.phpunit" || step.command === "wordpress.core-phpunit") {
    const code = recipeStepArgValue(step.args ?? [], "code")
    const codeFile = recipeStepArgValue(step.args ?? [], "code-file")
    const pluginSlug = recipeStepArgValue(step.args ?? [], "plugin-slug")
    if (!code && !codeFile && step.command === "wordpress.run-php") {
      addIssue("missing-code", `${path}.args`, `${step.command} requires code=<php> or code-file=<path>.`)
    }
    if (!code && !codeFile && step.command === "wordpress.phpunit" && !pluginSlug) {
      addIssue("missing-plugin-slug", `${path}.args`, "wordpress.phpunit requires plugin-slug=<slug> when code/code-file is not provided.")
    }
    if (code && codeFile) {
      addIssue("ambiguous-code", `${path}.args`, `${step.command} accepts either code=<php> or code-file=<path>, not both.`)
    }
    if (codeFile) {
      await validateExistingFile(resolve(codeFile), `${path}.args`, addIssue)
    }
    return
  }

  if (step.command === "wordpress.wp-cli" && recipeWpCliCommandFromArgs(step.args ?? []).length === 0) {
    addIssue("missing-command", `${path}.args`, "wordpress.wp-cli requires a non-empty command.")
    return
  }

  if (step.command === "wordpress.browser-probe") {
    if (!recipeStepArgValue(step.args ?? [], "url")?.trim()) {
      addIssue("missing-url", `${path}.args`, "wordpress.browser-probe requires url=<path-or-url>.")
    }

    const waitFor = recipeStepArgValue(step.args ?? [], "wait-for")
    if (waitFor && !["domcontentloaded", "load", "networkidle", "duration"].includes(waitFor) && !waitFor.startsWith("selector:")) {
      addIssue("invalid-wait-for", `${path}.args`, "wordpress.browser-probe wait-for must be domcontentloaded, load, networkidle, selector:<selector>, or duration.")
    }

    const duration = recipeStepArgValue(step.args ?? [], "duration")
    if (duration && !/^(\d+(?:\.\d+)?)(ms|s)$/.test(duration)) {
      addIssue("invalid-duration", `${path}.args`, "wordpress.browser-probe duration must look like 500ms or 2s.")
    }

    const capture = recipeStepArgValue(step.args ?? [], "capture")
    if (capture) {
      for (const item of capture.split(",").map((value) => value.trim()).filter(Boolean)) {
        if (!["console", "errors", "html", "network", "screenshot"].includes(item)) {
          addIssue("invalid-capture", `${path}.args`, `wordpress.browser-probe capture does not support: ${item}`)
        }
      }
    }
    return
  }

  if (step.command === "wordpress.ability") {
    if (!recipeStepArgValue(step.args ?? [], "name")?.trim()) {
      addIssue("missing-ability-name", `${path}.args`, "wordpress.ability requires name=<ability-name>.")
    }

    const input = recipeStepArgValue(step.args ?? [], "input")
    if (input) {
      try {
        JSON.parse(input)
      } catch (error) {
        addIssue("invalid-ability-input", `${path}.args`, `wordpress.ability input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

async function validateExistingDirectory(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  try {
    const result = await stat(path)
    if (!result.isDirectory()) {
      addIssue("not-directory", issuePath, `Expected directory: ${path}`)
    }
  } catch {
    addIssue("missing-path", issuePath, `Directory does not exist: ${path}`)
  }
}

async function validateExistingFile(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  try {
    const result = await stat(path)
    if (!result.isFile()) {
      addIssue("not-file", issuePath, `Expected file: ${path}`)
    }
  } catch {
    addIssue("missing-path", issuePath, `File does not exist: ${path}`)
  }
}

async function validateExistingFileOrDirectory(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  try {
    const result = await stat(path)
    if (!result.isFile() && !result.isDirectory()) {
      addIssue("unsupported-path", issuePath, `Expected file or directory: ${path}`)
    }
  } catch {
    addIssue("missing-path", issuePath, `File or directory does not exist: ${path}`)
  }
}

function validateAbsoluteSandboxPath(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): void {
  if (!path.startsWith("/")) {
    addIssue("invalid-sandbox-path", issuePath, `Sandbox paths must be absolute: ${path}`)
  }
}

function validateRecipeSource(source: ReturnType<typeof recipeSource>, issuePath: string, addIssue: (code: string, path: string, message: string) => void, expectedSha256?: string): void {
  if (source.type === "local") {
    return
  }

  if (process.env[ALLOW_NETWORK_DOWNLOADS_ENV] !== "1") {
    addIssue(
      "network-downloads-disabled",
      issuePath,
      `External recipe sources require ${ALLOW_NETWORK_DOWNLOADS_ENV}=1 before WP Codebox downloads anything.`,
    )
  }

  if (!allowedDownloadHosts().includes(source.host)) {
    addIssue("download-host-not-allowed", issuePath, `External recipe source host is not allowed: ${source.host}`)
  }

  if (expectedSha256 !== undefined && !isSha256(expectedSha256)) {
    addIssue("invalid-source-sha256", issuePath, "External recipe source sha256 must be a 64-character hex digest.")
  }

  if (sourceSha256Required() && !expectedSha256) {
    addIssue("missing-source-sha256", issuePath, `External recipe sources require sha256 when ${REQUIRE_SOURCE_SHA256_ENV}=1.`)
  }
}

function recipeStepArgValue(args: string[], key: string): string | undefined {
  const prefix = `${key}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function recipeWpCliCommandFromArgs(args: string[]): string {
  return recipeStepArgValue(args, "command")?.trim() ?? args.join(" ").trim()
}

function recipeWorkflowSteps(recipe: WorkspaceRecipe): Array<{ phase: Exclude<RecipeWorkflowPhase, "setup">; index: number; step: WorkspaceRecipe["workflow"]["steps"][number] }> {
  return [
    ...(recipe.workflow.before ?? []).map((step, index) => ({ phase: "before" as const, index, step })),
    ...recipe.workflow.steps.map((step, index) => ({ phase: "steps" as const, index, step })),
    ...(recipe.workflow.after ?? []).map((step, index) => ({ phase: "after" as const, index, step })),
  ]
}

function withRecipeExecutionPhase(execution: ExecutionResult, recipePhase: RecipeWorkflowPhase, recipeStepIndex: number, recipeCommand?: string): RecipeExecutionResult {
  return {
    ...execution,
    recipePhase,
    recipeStepIndex,
    recipeCommand,
  }
}

async function executeRecipeWorkflowStep(runtime: Runtime, workflowStep: ReturnType<typeof recipeWorkflowSteps>[number], recipeDirectory: string): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(workflowStep.step, recipeDirectory))
    return withRecipeExecutionPhase(execution, workflowStep.phase, workflowStep.index, workflowStep.step.command)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe workflow ${workflowStep.phase}[${workflowStep.index}] failed: ${message}`, { cause: error })
  }
}

async function executeRecipePluginRuntimeStep(runtime: Runtime, step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, phase: "setup", index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(step, recipeDirectory))
    return withRecipeExecutionPhase(execution, phase, pluginRuntimeSetupStepIndex(index), `plugin-runtime.setup:${index}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe plugin runtime setup[${index}] failed: ${message}`, { cause: error })
  }
}

async function executeRecipePluginRuntimeHealthProbe(runtime: Runtime, probe: WorkspaceRecipePluginRuntimeHealthProbe, recipeDirectory: string, index: number): Promise<RecipeExecutionResult> {
  try {
    const execution = await runtime.execute(await recipeExecutionSpec(pluginRuntimeHealthProbeStep(probe), recipeDirectory))
    return withRecipeExecutionPhase(execution, "setup", pluginRuntimeHealthProbeStepIndex(index), `plugin-runtime.health:${probe.name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Recipe plugin runtime health probe "${probe.name}" failed: ${message}`, { cause: error })
  }
}

function pluginRuntimeSetupStepIndex(index: number): number {
  return -1000 - index
}

function pluginRuntimeHealthProbeStepIndex(index: number): number {
  return -2000 - index
}

function pluginRuntimeHealthProbeStep(probe: WorkspaceRecipePluginRuntimeHealthProbe): WorkspaceRecipe["workflow"]["steps"][number] {
  if (probe.type === "plugin-active") {
    return {
      command: "wordpress.run-php",
      args: [`code=${pluginRuntimePluginActiveProbeCode(probe.pluginFile ?? "")}`],
    }
  }

  if (probe.type === "wp-cli") {
    return {
      command: "wordpress.wp-cli",
      args: [`command=${probe.command ?? ""}`],
    }
  }

  return {
    command: "wordpress.run-php",
    args: [`code=${probe.code ?? ""}`],
  }
}

function pluginRuntimePluginActiveProbeCode(pluginFile: string): string {
  return `require_once ABSPATH . 'wp-admin/includes/plugin.php';
$plugin = ${JSON.stringify(pluginFile)};
if (!is_plugin_active($plugin)) {
    throw new RuntimeException(sprintf('Plugin runtime health probe failed: plugin is not active: %s', $plugin));
}
echo wp_json_encode(array('command' => 'plugin-runtime.health', 'type' => 'plugin-active', 'pluginFile' => $plugin, 'active' => true), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function recipeRuntimeDiagnostics(recipe: WorkspaceRecipe, executions: RecipeExecutionResult[], error: unknown): RecipeRuntimeDiagnostic[] | undefined {
  const diagnostics: RecipeRuntimeDiagnostic[] = executions
    .map((execution, executionIndex) => ({ execution, executionIndex }))
    .filter(({ execution }) => execution.recipeCommand?.startsWith("plugin-runtime.") && execution.exitCode !== 0)
    .map(({ execution, executionIndex }) => ({
      schema: "wp-codebox/plugin-runtime-diagnostic/v1" as const,
      severity: "error" as const,
      phase: execution.recipeCommand?.startsWith("plugin-runtime.health:") ? "health-probe" as const : "setup" as const,
      name: execution.recipeCommand?.split(":").slice(1).join(":"),
      command: execution.command,
      exitCode: execution.exitCode,
      message: execution.stderr || execution.stdout || `Plugin runtime command failed with exit code ${execution.exitCode}`,
      executionIndex,
    }))

  const message = error instanceof Error ? error.message : String(error)
  if ((recipe.inputs?.pluginRuntime || message.includes("plugin runtime")) && diagnostics.length === 0) {
    diagnostics.push({
      schema: "wp-codebox/plugin-runtime-diagnostic/v1",
      severity: "error",
      phase: message.includes("health probe") ? "health-probe" : message.includes("setup") ? "setup" : "runtime",
      message,
    })
  }

  return diagnostics.length > 0 ? diagnostics : undefined
}

function recipeWorkflowMetadata(recipe: WorkspaceRecipe): { before?: Array<{ command: string; args: string[] }>; steps: Array<{ command: string; args: string[] }>; after?: Array<{ command: string; args: string[] }> } {
  return {
    ...(recipe.workflow.before ? { before: recipe.workflow.before.map(recipeStepMetadata) } : {}),
    steps: recipe.workflow.steps.map(recipeStepMetadata),
    ...(recipe.workflow.after ? { after: recipe.workflow.after.map(recipeStepMetadata) } : {}),
  }
}

function recipeStepMetadata(step: WorkspaceRecipe["workflow"]["steps"][number]): { command: string; args: string[] } {
  return { command: step.command, args: step.args ?? [] }
}

async function recipeDryRunSteps(recipe: WorkspaceRecipe, recipeDirectory: string, policy: RuntimePolicy): Promise<RecipeDryRunStep[]> {
  const steps: Array<Promise<RecipeDryRunStep>> = []
  const dryRunExtraPlugins = await Promise.all(recipeExtraPlugins(recipe).map(async (plugin) => {
    const slug = recipeExtraPluginSlug(plugin)
    return {
      source: plugin.source,
      slug,
      target: pluginTarget(slug, plugin.loadAs ?? "plugin"),
      pluginFile: await resolveRecipeExtraPluginFile(plugin, recipeDirectory),
      activate: plugin.activate !== false,
      loadAs: plugin.loadAs ?? "plugin",
      cleanupPaths: [],
      provenance: recipeSourceProvenance(recipeSource(plugin.source, plugin.sha256), recipeDirectory),
    }
  }))
  const muPluginInstallCode = installMuPluginsCode(dryRunExtraPlugins)
  if (muPluginInstallCode) {
    steps.push(recipeDryRunStep({ command: "wordpress.run-php", args: [`code=${muPluginInstallCode}`] }, recipeDirectory, policy, "setup", -2, "install-mu-plugins"))
  }
  const pluginActivationCode = activateExtraPluginsCode(dryRunExtraPlugins)
  if (pluginActivationCode) {
    steps.push(recipeDryRunStep({ command: "wordpress.run-php", args: [`code=${pluginActivationCode}`] }, recipeDirectory, policy, "setup", -1, "activate-extra-plugins"))
  }

  for (const workflowStep of recipeWorkflowSteps(recipe)) {
    steps.push(recipeDryRunStep(workflowStep.step, recipeDirectory, policy, workflowStep.phase, workflowStep.index))
  }

  return Promise.all(steps)
}

async function recipeDryRunStep(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, policy: RuntimePolicy, phase: RecipeWorkflowPhase, index: number, label?: string): Promise<RecipeDryRunStep> {
  const resolved = await recipeExecutionSpec(step, recipeDirectory)
  const allowed = policy.commands.includes(resolved.command)
  return {
    phase,
    index,
    command: label ?? step.command,
    args: step.args ?? [],
    parsedArgs: parseRecipeArgs(step.args ?? []),
    resolvedCommand: resolved.command,
    resolvedArgs: resolved.args,
    resolvedParsedArgs: parseRecipeArgs(resolved.args),
    policy: {
      status: allowed ? "allowed" : "denied",
      command: resolved.command,
      allowedCommands: policy.commands,
      approvals: policy.approvals,
      filesystem: policy.filesystem,
      secrets: policy.secrets,
    },
  }
}

function parseRecipeArgs(args: string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {}
  for (const arg of args) {
    const separator = arg.indexOf("=")
    if (separator === -1) {
      parsed[arg] = true
      continue
    }

    parsed[arg.slice(0, separator)] = arg.slice(separator + 1)
  }

  return parsed
}

function recipePolicy(recipe: WorkspaceRecipe): RuntimePolicy {
  const pluginRuntimeCommands = [
    ...(recipe.inputs?.pluginRuntime?.setup ?? []),
    ...(recipe.inputs?.pluginRuntime?.healthProbes ?? []).map(pluginRuntimeHealthProbeStep),
  ].map((step) => step.command)
  const commands = [
    ...recipeWorkflowSteps(recipe).map(({ step }) => step.command.startsWith("wp-codebox.agent-") ? "wordpress.run-php" : step.command),
    ...pluginRuntimeCommands,
  ]
  if (recipeWorkflowSteps(recipe).some(({ step }) => step.command === "wp-codebox.agent-sandbox-run")) {
    commands.unshift("wordpress.wp-cli")
  }
  if (recipeExtraPlugins(recipe).some((plugin) => plugin.activate !== false)) {
    commands.unshift("wordpress.run-php")
  }
  if ((recipe.inputs?.siteSeeds ?? []).some((siteSeed) => siteSeed.type === "fixture")) {
    commands.unshift("wordpress.run-php")
  }

  return {
    ...defaultPolicy,
    commands: [...new Set(commands)],
  }
}

function runPolicy(command: string): RuntimePolicy {
  return {
    ...defaultPolicy,
    commands: [...new Set([...defaultPolicy.commands, command])],
  }
}

function recipeRunMetadata(recipe: WorkspaceRecipe, recipePath: string, workspaceMounts: PreparedWorkspaceMount[], extraPlugins: PreparedExtraPlugin[], stagedFiles: PreparedStagedFile[], previewPublicUrl: string | undefined, previewPort: number | undefined, previewBind: string | undefined): Record<string, unknown> {
  const extraPluginMetadata = extraPlugins.map((plugin) => ({
    source: plugin.source,
    slug: plugin.slug,
    target: plugin.target,
    pluginFile: plugin.pluginFile,
    activate: plugin.activate,
    loadAs: plugin.loadAs,
    provenance: plugin.provenance,
  }))
  const siteSeedProvenance = recipeDryRunSiteSeeds(recipe, dirname(recipePath))
  const stagedFileProvenance = stagedFiles.map(recipeRunStagedFile)
  const workflow = recipeWorkflowMetadata(recipe)

  return {
    recipe: {
      path: recipePath,
      schema: recipe.schema,
      runtime: recipe.runtime ?? {},
      artifacts: recipe.artifacts ?? {},
      workflow,
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: extraPluginMetadata,
        pluginRuntime: recipe.inputs?.pluginRuntime ?? {},
        siteSeeds: recipe.inputs?.siteSeeds ?? [],
        siteSeedProvenance,
        stagedFiles: recipe.inputs?.stagedFiles ?? [],
        stagedFileProvenance,
        secretEnv: recipe.inputs?.secretEnv ?? [],
        inherit: recipe.inputs?.inherit ?? {},
        inheritance: recipe.inputs?.inheritance ?? {},
      },
    },
    workspace: sandboxWorkspaceContract(workspaceMounts, recipe.inputs?.mounts ?? []),
    task: {
      kind: "recipe-run",
      recipePath,
      previewPublicUrl,
      previewPort,
      previewBind,
      workflow,
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: extraPluginMetadata,
        pluginRuntime: recipe.inputs?.pluginRuntime ?? {},
        siteSeeds: recipe.inputs?.siteSeeds ?? [],
        siteSeedProvenance,
        stagedFiles: recipe.inputs?.stagedFiles ?? [],
        stagedFileProvenance,
        secretEnv: recipe.inputs?.secretEnv ?? [],
        inherit: recipe.inputs?.inherit ?? {},
        inheritance: recipe.inputs?.inheritance ?? {},
      },
    },
    preparedWorkspaces: workspaceMounts.map((workspace) => ({
      target: workspace.target,
      mode: workspace.mode,
      metadata: workspace.metadata,
    })),
    preparedStagedFiles: stagedFiles.map((stagedFile) => ({
      sourceRef: stagedFile.sourceRef,
      target: stagedFile.target,
      type: stagedFile.type,
      provenance: stagedFile.provenance,
      metadata: stagedFile.metadata,
    })),
  }
}

function recipeDryRunWorkspaces(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunWorkspace[] {
  return (recipe.inputs?.workspaces ?? []).map((workspace, index) => {
    const slug = workspace.seed.slug ?? basename(resolve(recipeDirectory, workspace.seed.source ?? `workspace-${index}`))
    const target = workspace.target ?? defaultWorkspaceTarget(workspace, slug)
    const generated = workspace.seed.type !== "directory"
    const sourceMode = workspace.sourceMode ?? "repo-backed"
    const metadata = {
      kind: "recipe-workspace",
      index,
      seed: workspace.seed,
      target,
      workspaceRoot: SANDBOX_WORKSPACE_ROOT,
      sourceMode,
      dryRun: true,
    }

    return {
      index,
      ...(generated ? {} : { source: resolve(recipeDirectory, workspace.seed.source ?? "") }),
      target,
      mode: workspace.mode ?? "readwrite",
      sourceMode,
      seed: workspace.seed,
      generated,
      metadata,
    }
  })
}

function recipeDryRunExtraPlugins(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunExtraPlugin[] {
  return recipeExtraPlugins(recipe).map((plugin) => {
    const slug = recipeExtraPluginSlug(plugin)
    const source = recipeSource(plugin.source, plugin.sha256)
    const provenance = recipeSourceProvenance(source, recipeDirectory)
    return {
      source: source.type === "local" ? resolve(recipeDirectory, plugin.source) : source.resolvedUrl,
      sourceRef: plugin.source,
      sourceType: source.type,
      slug,
      target: pluginTarget(slug, plugin.loadAs ?? "plugin"),
      pluginFile: recipeExtraPluginFile(plugin),
      activate: plugin.activate !== false,
      loadAs: plugin.loadAs ?? "plugin",
      provenance,
    }
  })
}

async function recipeDryRunPluginRuntime(recipe: WorkspaceRecipe, recipeDirectory: string, policy: RuntimePolicy): Promise<RecipeDryRunPluginRuntime | undefined> {
  const pluginRuntime = recipe.inputs?.pluginRuntime
  if (!pluginRuntime) {
    return undefined
  }

  const setup = await Promise.all((pluginRuntime.setup ?? []).map((step, index) => recipeDryRunStep(step, recipeDirectory, policy, "setup", pluginRuntimeSetupStepIndex(index), `plugin-runtime.setup:${index}`)))
  const healthProbes = await Promise.all((pluginRuntime.healthProbes ?? []).map(async (probe, index) => {
    const step = pluginRuntimeHealthProbeStep(probe)
    const dryRunStep = await recipeDryRunStep(step, recipeDirectory, policy, "setup", pluginRuntimeHealthProbeStepIndex(index), `plugin-runtime.health:${probe.name}`)
    return {
      index,
      name: probe.name,
      type: probe.type,
      command: dryRunStep.command,
      args: dryRunStep.args,
      resolvedCommand: dryRunStep.resolvedCommand,
      resolvedArgs: dryRunStep.resolvedArgs,
      policy: dryRunStep.policy,
    }
  }))

  return stripUndefined({
    label: pluginRuntime.label,
    php: pluginRuntime.php,
    wpConfigDefines: pluginRuntime.wpConfigDefines,
    setup,
    healthProbes,
  })
}

function recipeDryRunSiteSeeds(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunSiteSeed[] {
  return (recipe.inputs?.siteSeeds ?? []).map((siteSeed, index) => ({
    index,
    type: siteSeed.type,
    name: siteSeed.name,
    ...(siteSeed.source ? { source: resolve(recipeDirectory, siteSeed.source) } : {}),
    ...(siteSeed.format ? { format: siteSeed.format } : {}),
    ...(siteSeed.type === "fixture" ? { importer: siteSeed.format ?? "json" } : {}),
    scopes: siteSeed.scopes,
    bounded: siteSeedScopesAreBounded(siteSeed),
    dryRunOnly: siteSeed.type !== "fixture",
    privacy: {
      exportsParentSiteData: false,
      importsIntoSandbox: siteSeed.type === "fixture",
      includesRecordData: siteSeed.type === "fixture",
      secrets: "excluded-by-default",
    },
  }))
}

async function recipeDryRunStagedFiles(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<RecipeDryRunStagedFile[]> {
  return Promise.all((recipe.inputs?.stagedFiles ?? []).map(async (stagedFile, index) => {
    const source = resolve(recipeDirectory, stagedFile.source)
    return {
      index,
      source,
      sourceRef: stagedFile.source,
      target: stagedFile.target,
      type: await stagedFileMountType(source),
      provenance: stagedFileProvenance(stagedFile, recipeDirectory),
    }
  }))
}

function recipeRunStagedFile(stagedFile: PreparedStagedFile): RecipeRunStagedFile {
  const index = typeof stagedFile.metadata.index === "number" ? stagedFile.metadata.index : 0
  return {
    index,
    source: stagedFile.originalSource,
    sourceRef: stagedFile.sourceRef,
    target: stagedFile.target,
    type: stagedFile.type,
    provenance: stagedFile.provenance,
    action: "staged",
  }
}

async function importRecipeSiteSeeds(recipe: WorkspaceRecipe, recipeDirectory: string, runtime: Runtime, executions: RecipeExecutionResult[]): Promise<RecipeRunSiteSeed[]> {
  const results: RecipeRunSiteSeed[] = []

  for (const [index, siteSeed] of (recipe.inputs?.siteSeeds ?? []).entries()) {
    const base = recipeSiteSeedRunBase(siteSeed, recipeDirectory, index)
    if (siteSeed.type !== "fixture") {
      results.push({
        ...base,
        action: "skipped",
        reason: "parent-site export is not implemented in this first executable site seed slice",
      })
      continue
    }

    const format = siteSeed.format ?? "json"
    const source = resolve(recipeDirectory, siteSeed.source ?? "")
    if (format === "json") {
      const rawSeed = JSON.parse(await readFile(source, "utf8"))
      const bounded = boundedFixtureSeed(rawSeed, siteSeed.scopes)
      const execution = await runtime.execute({
        command: "wordpress.run-php",
        args: [`code=${siteSeedJsonImportCode(siteSeed.name, bounded.seed)}`],
      })
      executions.push(withRecipeExecutionPhase(execution, "setup", index))
      const imported = parseSiteSeedImportResult(execution.stdout)
      results.push({
        ...base,
        action: "imported",
        counts: {
          ...bounded.counts,
          ...imported.counts,
        },
        ...(imported.warnings.length > 0 ? { warnings: imported.warnings } : {}),
        provenance: {
          importer: "json",
          source,
          ...(imported.provenance ?? {}),
        },
      })
      continue
    }

    const sourceContents = await readFile(source, "utf8")
    const execution = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=${siteSeedRegistryImportCode(siteSeed, format, source, sourceContents)}`],
    })
    executions.push(withRecipeExecutionPhase(execution, "setup", index))
    const imported = parseSiteSeedImportResult(execution.stdout)
    results.push({
      ...base,
      action: "imported",
      counts: imported.counts,
      ...(imported.warnings.length > 0 ? { warnings: imported.warnings } : {}),
      provenance: {
        importer: format,
        source,
        ...(imported.provenance ?? {}),
      },
    })
  }

  return results
}

function recipeSiteSeedRunBase(siteSeed: WorkspaceRecipeSiteSeed, recipeDirectory: string, index: number): Omit<RecipeRunSiteSeed, "action" | "reason" | "counts"> {
  return {
    index,
    type: siteSeed.type,
    name: siteSeed.name,
    ...(siteSeed.source ? { source: resolve(recipeDirectory, siteSeed.source) } : {}),
    ...(siteSeed.format ? { format: siteSeed.format } : {}),
    ...(siteSeed.type === "fixture" ? { importer: siteSeed.format ?? "json" } : {}),
    scopes: siteSeed.scopes,
    bounded: siteSeedScopesAreBounded(siteSeed),
    privacy: {
      exportsParentSiteData: false,
      importsIntoSandbox: siteSeed.type === "fixture",
      includesRecordData: siteSeed.type === "fixture",
      secrets: "excluded-by-default",
    },
  }
}

function parseSiteSeedImportResult(stdout: string): { counts: Record<string, number>; warnings: string[]; provenance?: Record<string, unknown> } {
  const parsed = JSON.parse(stdout.trim() || "{}") as { counts?: Record<string, unknown>; warnings?: unknown[]; provenance?: unknown }
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed.counts ?? {})) {
    if (typeof value === "number") {
      counts[key] = value
    }
  }
  const warnings = (parsed.warnings ?? []).filter((warning): warning is string => typeof warning === "string")
  return {
    counts,
    warnings,
    ...(parsed.provenance && typeof parsed.provenance === "object" && !Array.isArray(parsed.provenance) ? { provenance: parsed.provenance as Record<string, unknown> } : {}),
  }
}

function siteSeedJsonImportCode(seedName: string, seed: unknown): string {
  const encodedSeed = JSON.stringify(JSON.stringify(seed))
  const encodedName = JSON.stringify(seedName)
  return `
$seed_name = ${encodedName};
$seed = json_decode(${encodedSeed}, true);
if (!is_array($seed)) {
    throw new RuntimeException('Site seed fixture must decode to a JSON object.');
}

$counts = array('posts' => 0, 'options' => 0, 'terms' => 0, 'users' => 0, 'media' => 0, 'activePlugins' => 0, 'activeTheme' => 0);

foreach (($seed['posts'] ?? array()) as $post) {
    if (!is_array($post)) {
        continue;
    }
    $postarr = array(
        'post_type' => isset($post['post_type']) ? (string) $post['post_type'] : 'post',
        'post_status' => isset($post['post_status']) ? (string) $post['post_status'] : (isset($post['status']) ? (string) $post['status'] : 'publish'),
        'post_title' => isset($post['post_title']) ? (string) $post['post_title'] : (isset($post['title']) ? (string) $post['title'] : 'Seeded post'),
        'post_content' => isset($post['post_content']) ? (string) $post['post_content'] : (isset($post['content']) ? (string) $post['content'] : ''),
        'post_excerpt' => isset($post['post_excerpt']) ? (string) $post['post_excerpt'] : (isset($post['excerpt']) ? (string) $post['excerpt'] : ''),
    );
    if (isset($post['slug'])) {
        $postarr['post_name'] = (string) $post['slug'];
    } elseif (isset($post['post_name'])) {
        $postarr['post_name'] = (string) $post['post_name'];
    }
    $post_id = wp_insert_post($postarr, true);
    if (is_wp_error($post_id)) {
        throw new RuntimeException('Failed to import site seed post from ' . $seed_name . ': ' . $post_id->get_error_message());
    }
    $counts['posts']++;
}

$options = $seed['options'] ?? array();
if (is_array($options)) {
    foreach ($options as $key => $option) {
        if (is_array($option) && array_key_exists('name', $option)) {
            update_option((string) $option['name'], $option['value'] ?? '');
            $counts['options']++;
            continue;
        }
        if (is_string($key)) {
            update_option($key, $option);
            $counts['options']++;
        }
    }
}

foreach (($seed['terms'] ?? array()) as $term) {
    if (!is_array($term) || empty($term['name']) || empty($term['taxonomy'])) {
        continue;
    }
    $result = wp_insert_term((string) $term['name'], (string) $term['taxonomy'], array_filter(array(
        'slug' => isset($term['slug']) ? (string) $term['slug'] : null,
        'description' => isset($term['description']) ? (string) $term['description'] : null,
    ), static fn($value) => $value !== null));
    if (is_wp_error($result) && 'term_exists' !== $result->get_error_code()) {
        throw new RuntimeException('Failed to import site seed term from ' . $seed_name . ': ' . $result->get_error_message());
    }
    $counts['terms']++;
}

foreach (($seed['users'] ?? array()) as $user) {
    if (!is_array($user)) {
        continue;
    }
    $login = isset($user['user_login']) ? (string) $user['user_login'] : (isset($user['login']) ? (string) $user['login'] : '');
    if ('' === $login || !preg_match('/^[A-Za-z0-9_.@-]+$/', $login)) {
        throw new RuntimeException('Unsafe site seed user login from ' . $seed_name . '.');
    }
    if (username_exists($login)) {
        $counts['users']++;
        continue;
    }
    $email = isset($user['user_email']) ? (string) $user['user_email'] : (isset($user['email']) ? (string) $user['email'] : $login . '@example.invalid');
    if (!is_email($email)) {
        $email = $login . '@example.invalid';
    }
    $user_id = wp_insert_user(array(
        'user_login' => $login,
        'user_pass' => wp_generate_password(24, true, true),
        'user_email' => $email,
        'display_name' => isset($user['display_name']) ? (string) $user['display_name'] : $login,
        'role' => isset($user['role']) ? (string) $user['role'] : (is_array($user['roles'] ?? null) && count($user['roles']) > 0 ? (string) reset($user['roles']) : 'subscriber'),
    ));
    if (is_wp_error($user_id)) {
        throw new RuntimeException('Failed to import site seed user from ' . $seed_name . ': ' . $user_id->get_error_message());
    }
    $counts['users']++;
}

foreach (($seed['media'] ?? array()) as $media) {
    if (!is_array($media)) {
        continue;
    }
    $attachment = array(
        'post_type' => 'attachment',
        'post_status' => isset($media['post_status']) ? (string) $media['post_status'] : 'inherit',
        'post_title' => isset($media['post_title']) ? (string) $media['post_title'] : (isset($media['title']) ? (string) $media['title'] : 'Seeded media'),
        'post_content' => isset($media['post_content']) ? (string) $media['post_content'] : '',
        'post_excerpt' => isset($media['post_excerpt']) ? (string) $media['post_excerpt'] : '',
        'post_mime_type' => isset($media['post_mime_type']) ? (string) $media['post_mime_type'] : (isset($media['mime_type']) ? (string) $media['mime_type'] : ''),
    );
    if (isset($media['slug'])) {
        $attachment['post_name'] = (string) $media['slug'];
    } elseif (isset($media['post_name'])) {
        $attachment['post_name'] = (string) $media['post_name'];
    }
    $attachment_id = wp_insert_post($attachment, true);
    if (is_wp_error($attachment_id)) {
        throw new RuntimeException('Failed to import site seed media from ' . $seed_name . ': ' . $attachment_id->get_error_message());
    }
    $counts['media']++;
}

$active_plugins = $seed['activePlugins'] ?? array();
if (is_array($active_plugins) && count($active_plugins) > 0) {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    foreach ($active_plugins as $plugin) {
        $plugin_file = is_array($plugin) ? ($plugin['pluginFile'] ?? ($plugin['file'] ?? '')) : $plugin;
        $plugin_file = is_string($plugin_file) ? $plugin_file : '';
        if ('' === $plugin_file || str_starts_with($plugin_file, '/') || str_contains($plugin_file, '..') || !str_ends_with($plugin_file, '.php')) {
            throw new RuntimeException('Unsafe site seed active plugin entry from ' . $seed_name . '.');
        }
        if (!file_exists(WP_PLUGIN_DIR . '/' . $plugin_file)) {
            throw new RuntimeException('Site seed active plugin is not installed in sandbox: ' . $plugin_file);
        }
        $result = activate_plugin($plugin_file, '', false, true);
        if (is_wp_error($result)) {
            throw new RuntimeException('Failed to activate site seed plugin from ' . $seed_name . ': ' . $result->get_error_message());
        }
        $counts['activePlugins']++;
    }
}

$active_theme = $seed['activeTheme'] ?? null;
if (is_array($active_theme)) {
    $active_theme = $active_theme['stylesheet'] ?? ($active_theme['slug'] ?? null);
}
if (is_string($active_theme) && '' !== $active_theme) {
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $active_theme)) {
        throw new RuntimeException('Unsafe site seed active theme entry from ' . $seed_name . '.');
    }
    $theme = wp_get_theme($active_theme);
    if (!$theme->exists()) {
        throw new RuntimeException('Site seed active theme is not installed in sandbox: ' . $active_theme);
    }
    switch_theme($active_theme);
    $counts['activeTheme']++;
}

echo wp_json_encode(array('schema' => 'wp-codebox/site-seed-import/v1', 'name' => $seed_name, 'counts' => $counts));
`}

function siteSeedRegistryImportCode(siteSeed: WorkspaceRecipeSiteSeed, format: string, source: string, sourceContents: string): string {
  const encodedName = JSON.stringify(siteSeed.name)
  const encodedFormat = JSON.stringify(format)
  const encodedSource = JSON.stringify(source)
  const encodedSourceBasename = JSON.stringify(basename(source))
  const encodedSourceContents = JSON.stringify(sourceContents)
  const encodedScopes = JSON.stringify(JSON.stringify(siteSeed.scopes))
  return `
$seed_name = ${encodedName};
$format = ${encodedFormat};
$source = ${encodedSource};
$source_basename = ${encodedSourceBasename};
$source_contents = ${encodedSourceContents};
$scopes = json_decode(${encodedScopes}, true);
if (!is_array($scopes)) {
    throw new RuntimeException('Site seed scopes must decode to an object.');
}

$importers = apply_filters('wp_codebox_site_seed_importers', array());
if (!is_array($importers) || !array_key_exists($format, $importers)) {
    throw new RuntimeException('No WP Codebox site seed importer registered for format: ' . $format);
}

$importer = $importers[$format];
$callback = is_array($importer) && array_key_exists('callback', $importer) ? $importer['callback'] : $importer;
if (!is_callable($callback)) {
    throw new RuntimeException('WP Codebox site seed importer is not callable for format: ' . $format);
}

$result = call_user_func($callback, array(
    'schema' => 'wp-codebox/site-seed-import-request/v1',
    'name' => $seed_name,
    'format' => $format,
    'source' => $source,
    'source_basename' => $source_basename,
    'source_contents' => $source_contents,
    'scopes' => $scopes,
    'metadata' => array(
        'source_size' => strlen($source_contents),
    ),
));

if (!is_array($result)) {
    throw new RuntimeException('WP Codebox site seed importer must return an array for format: ' . $format);
}

$counts = array();
foreach (($result['counts'] ?? array()) as $key => $value) {
    if (is_int($value) || is_float($value)) {
        $counts[(string) $key] = $value;
    }
}

$warnings = array();
foreach (($result['warnings'] ?? array()) as $warning) {
    if (is_string($warning)) {
        $warnings[] = $warning;
    }
}

$provenance = isset($result['provenance']) && is_array($result['provenance']) ? $result['provenance'] : array();
$provenance['importer'] = $format;
$provenance['source'] = $source;

echo wp_json_encode(array(
    'schema' => 'wp-codebox/site-seed-import/v1',
    'name' => $seed_name,
    'importer' => $format,
    'counts' => $counts,
    'warnings' => $warnings,
    'provenance' => $provenance,
));
`}

function boundedFixtureSeed(rawSeed: unknown, scopes: WorkspaceRecipeSiteSeed["scopes"]): { seed: Record<string, unknown>; counts: Record<string, number> } {
  if (!rawSeed || typeof rawSeed !== "object" || Array.isArray(rawSeed)) {
    throw new Error("Recipe fixture siteSeed JSON must be an object")
  }

  const seed = rawSeed as Record<string, unknown>
  const posts = boundedRecords(arrayRecords(seed.posts), scopes.posts, (record, scope) => matchesPostScope(record, scope))
  const options = boundedOptions(seed.options, scopes.options)
  const terms = boundedRecords(arrayRecords(seed.terms), scopes.terms, (record, scope) => matchesTermScope(record, scope))
  const users = boundedRecords(arrayRecords(seed.users), scopes.users, (record, scope) => matchesUserScope(record, scope))
  const media = boundedRecords(arrayRecords(seed.media), scopes.media, (record, scope) => matchesMediaScope(record, scope))
  const activePlugins = boundedActivePlugins(seed.activePlugins, scopes.activePlugins)
  const activeTheme = boundedActiveTheme(seed.activeTheme, scopes.activeTheme)

  return {
    seed: stripUndefined({ posts: posts.records, options: options.records, terms: terms.records, users: users.records, media: media.records, activePlugins: activePlugins.records, activeTheme: activeTheme.record }),
    counts: {
      fixturePostsIncluded: posts.records.length,
      fixturePostsExcluded: posts.excluded,
      fixtureOptionsIncluded: options.count,
      fixtureOptionsExcluded: options.excluded,
      fixtureTermsIncluded: terms.records.length,
      fixtureTermsExcluded: terms.excluded,
      fixtureUsersIncluded: users.records.length,
      fixtureUsersExcluded: users.excluded,
      fixtureMediaIncluded: media.records.length,
      fixtureMediaExcluded: media.excluded,
      fixtureActivePluginsIncluded: activePlugins.records.length,
      fixtureActivePluginsExcluded: activePlugins.excluded,
      fixtureActiveThemeIncluded: activeTheme.record === undefined ? 0 : 1,
      fixtureActiveThemeExcluded: activeTheme.excluded,
    },
  }
}

function boundedActivePlugins(activePlugins: unknown, scope: boolean | undefined): { records: Array<string | Record<string, unknown>>; excluded: number } {
  const records = Array.isArray(activePlugins)
    ? activePlugins.filter((plugin): plugin is string | Record<string, unknown> => typeof plugin === "string" || (Boolean(plugin) && typeof plugin === "object" && !Array.isArray(plugin)))
    : []

  if (scope !== true) {
    return { records: [], excluded: records.length }
  }

  const included = records.slice(0, 100)
  return { records: included, excluded: records.length - included.length }
}

function boundedActiveTheme(activeTheme: unknown, scope: boolean | undefined): { record: unknown; excluded: number } {
  if (activeTheme === undefined || activeTheme === null) {
    return { record: undefined, excluded: 0 }
  }

  if (scope !== true) {
    return { record: undefined, excluded: 1 }
  }

  return { record: activeTheme, excluded: 0 }
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []
}

function boundedRecords(records: Array<Record<string, unknown>>, scope: WorkspaceRecipeSiteSeed["scopes"]["posts"], matches: (record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>) => boolean): { records: Array<Record<string, unknown>>; excluded: number } {
  if (!scope) {
    return { records: [], excluded: records.length }
  }

  const filtered = records.filter((record) => matches(record, scope))
  const maxRecords = scope.maxRecords ?? filtered.length
  return {
    records: filtered.slice(0, maxRecords),
    excluded: records.length - Math.min(filtered.length, maxRecords),
  }
}

function boundedOptions(options: unknown, scope: WorkspaceRecipeSiteSeed["scopes"]["options"]): { records: Record<string, unknown> | Array<Record<string, unknown>> | undefined; count: number; excluded: number } {
  if (!scope || !scope.names || scope.names.length === 0) {
    const count = Array.isArray(options) ? options.length : options && typeof options === "object" ? Object.keys(options).length : 0
    return { records: undefined, count: 0, excluded: count }
  }

  const allowed = new Set(scope.names)
  const maxRecords = scope.maxRecords ?? allowed.size
  if (Array.isArray(options)) {
    const filtered = options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object" && !Array.isArray(option) && typeof option.name === "string" && allowed.has(option.name)).slice(0, maxRecords)
    return { records: filtered, count: filtered.length, excluded: options.length - filtered.length }
  }

  if (!options || typeof options !== "object") {
    return { records: undefined, count: 0, excluded: 0 }
  }

  const entries = Object.entries(options as Record<string, unknown>).filter(([name]) => allowed.has(name)).slice(0, maxRecords)
  return { records: Object.fromEntries(entries), count: entries.length, excluded: Object.keys(options).length - entries.length }
}

function matchesPostScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["posts"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "ID"]) &&
    matchesStringSelector(record, scope.slugs, ["slug", "post_name"]) &&
    matchesStringSelector(record, scope.postTypes, ["post_type", "type"]) &&
    matchesStringSelector(record, scope.statuses, ["post_status", "status"])
}

function matchesTermScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["terms"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "term_id"]) &&
    matchesStringSelector(record, scope.slugs, ["slug"]) &&
    matchesStringSelector(record, scope.names, ["name"]) &&
    matchesStringSelector(record, scope.taxonomies, ["taxonomy"])
}

function matchesUserScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["users"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "ID"]) &&
    matchesStringSelector(record, scope.names, ["user_login", "login", "display_name", "name"]) &&
    matchesArrayStringSelector(record, scope.roles, ["roles"])
}

function matchesMediaScope(record: Record<string, unknown>, scope: NonNullable<WorkspaceRecipeSiteSeed["scopes"]["media"]>): boolean {
  return matchesNumberSelector(record, scope.ids, ["id", "ID"]) &&
    matchesStringSelector(record, scope.slugs, ["slug", "post_name"]) &&
    matchesStringSelector(record, scope.names, ["post_title", "title", "name"]) &&
    matchesStringSelector(record, scope.statuses, ["post_status", "status"])
}

function matchesStringSelector(record: Record<string, unknown>, allowed: string[] | undefined, keys: string[]): boolean {
  if (!allowed || allowed.length === 0) {
    return true
  }
  const values = keys.map((key) => record[key]).filter((value): value is string => typeof value === "string")
  return values.some((value) => allowed.includes(value))
}

function matchesArrayStringSelector(record: Record<string, unknown>, allowed: string[] | undefined, keys: string[]): boolean {
  if (!allowed || allowed.length === 0) {
    return true
  }
  const values = keys.flatMap((key) => Array.isArray(record[key]) ? record[key] : []).filter((value): value is string => typeof value === "string")
  return values.some((value) => allowed.includes(value))
}

function matchesNumberSelector(record: Record<string, unknown>, allowed: number[] | undefined, keys: string[]): boolean {
  if (!allowed || allowed.length === 0) {
    return true
  }
  const values = keys.map((key) => record[key]).filter((value): value is number => typeof value === "number")
  return values.some((value) => allowed.includes(value))
}

function siteSeedScopesAreBounded(siteSeed: WorkspaceRecipeSiteSeed): boolean {
  for (const [scopeName, scope] of Object.entries(siteSeed.scopes)) {
    if (!scope || scope === true) {
      continue
    }

    if (scopeName === "options" && (!scope.names || scope.names.length === 0)) {
      return false
    }

    if (siteSeed.type === "parent_site" && scope.maxRecords === undefined && !hasExplicitSiteSeedSelectors(scope)) {
      return false
    }

    if (scopeName === "users" && scope.anonymize === false) {
      return false
    }

    if (scopeName === "media" && scope.includeFiles === true && siteSeed.type === "parent_site") {
      return false
    }
  }

  return Object.values(siteSeed.scopes).some((scope) => scope !== undefined && scope !== false)
}

async function prepareRecipeWorkspaces(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedWorkspaceMount[]> {
  const workspaces = recipe.inputs?.workspaces ?? []
  const mounts: PreparedWorkspaceMount[] = []
  for (const [index, workspace] of workspaces.entries()) {
    const slug = workspace.seed.slug ?? basename(resolve(recipeDirectory, workspace.seed.source ?? `workspace-${index}`))
    const prepared = await prepareRecipeWorkspace(workspace, recipeDirectory, slug)
    const target = workspace.target ?? defaultWorkspaceTarget(workspace, slug)
    mounts.push({
      source: prepared.source,
      target,
      mode: workspace.mode ?? "readwrite",
      cleanupPaths: prepared.cleanupPaths,
      metadata: {
        kind: "recipe-workspace",
        index,
        seed: workspace.seed,
        baselineSource: prepared.baselineSource,
        target,
        workspaceRoot: SANDBOX_WORKSPACE_ROOT,
        sourceMode: workspace.sourceMode ?? "repo-backed",
      },
    })
  }

  return mounts
}

async function cleanupRecipeWorkspaces(workspaces: PreparedWorkspaceMount[]): Promise<void> {
  await Promise.all(workspaces.flatMap((workspace) => workspace.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })))
}

async function cleanupRecipePreparedSources(workspaces: PreparedWorkspaceMount[], extraPlugins: PreparedExtraPlugin[], stagedFiles: PreparedStagedFile[] = []): Promise<void> {
  await Promise.all([
    cleanupRecipeWorkspaces(workspaces),
    ...extraPlugins.flatMap((plugin) => plugin.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })),
    ...stagedFiles.flatMap((stagedFile) => stagedFile.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })),
  ])
}

async function prepareRecipeExtraPlugins(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedExtraPlugin[]> {
  const plugins: PreparedExtraPlugin[] = []
  for (const plugin of recipeExtraPlugins(recipe)) {
    const slug = recipeExtraPluginSlug(plugin)
    const resolved = await prepareRecipeSource(plugin.source, recipeDirectory, slug, plugin.sha256)
    const pluginFile = await resolveRecipeExtraPluginFile(plugin, recipeDirectory)
    const loadAs = plugin.loadAs ?? "plugin"
    await assertPreparedPluginFileExists(resolved.source, pluginFile.slice(slug.length + 1), plugin.source)
    plugins.push({
      source: resolved.source,
      slug,
      target: pluginTarget(slug, loadAs),
      pluginFile,
      activate: plugin.activate !== false,
      loadAs,
      cleanupPaths: resolved.cleanupPaths,
      provenance: resolved.provenance,
    })
  }

  return plugins
}

async function prepareRecipeStagedFiles(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedStagedFile[]> {
  const stagedFiles: PreparedStagedFile[] = []
  for (const [index, stagedFile] of (recipe.inputs?.stagedFiles ?? []).entries()) {
    const originalSource = resolve(recipeDirectory, stagedFile.source)
    const type = await stagedFileMountType(originalSource)
    const stagingRoot = await mkdtemp(join(tmpdir(), "wp-codebox-staged-file-"))
    const stagedSource = join(stagingRoot, basename(originalSource))
    await cp(originalSource, stagedSource, { recursive: type === "directory" })
    const provenance = stagedFileProvenance(stagedFile, recipeDirectory)
    stagedFiles.push({
      source: stagedSource,
      originalSource,
      sourceRef: stagedFile.source,
      target: stagedFile.target,
      type,
      cleanupPaths: [stagingRoot],
      provenance,
      metadata: {
        kind: "staged-file",
        index,
        source: provenance,
      },
    })
  }

  return stagedFiles
}

async function stagedFileMountType(source: string): Promise<MountSpec["type"]> {
  const result = await stat(source)
  if (result.isDirectory()) {
    return "directory"
  }
  if (result.isFile()) {
    return "file"
  }

  throw new Error(`Recipe stagedFiles source must be a file or directory: ${source}`)
}

function stagedFileProvenance(stagedFile: WorkspaceRecipeStagedFile, recipeDirectory: string): RecipeStagedFileProvenance {
  return {
    kind: "local",
    original: stagedFile.source,
    localPathCategory: resolve(recipeDirectory, stagedFile.source).startsWith(recipeDirectory) ? "recipe-relative" : undefined,
  }
}

async function assertPreparedPluginFileExists(sourceDirectory: string, pluginFileRelativeToSource: string, sourceRef: string): Promise<void> {
  try {
    const result = await stat(join(sourceDirectory, pluginFileRelativeToSource))
    if (result.isFile()) {
      return
    }
  } catch {
    // Throw a stable message below.
  }

  throw new Error(`Recipe extra plugin source did not contain expected plugin file ${pluginFileRelativeToSource}: ${sourceRef}`)
}

async function prepareRecipeSource(sourceRef: string, recipeDirectory: string, slug: string, expectedSha256?: string): Promise<PreparedExternalSource> {
  const source = recipeSource(sourceRef, expectedSha256)
  if (source.type === "local") {
    return {
      source: resolve(recipeDirectory, sourceRef),
      cleanupPaths: [],
      provenance: recipeSourceProvenance(source, recipeDirectory),
    }
  }

  if (process.env[ALLOW_NETWORK_DOWNLOADS_ENV] !== "1") {
    throw new Error(`External recipe sources require ${ALLOW_NETWORK_DOWNLOADS_ENV}=1 before WP Codebox downloads anything.`)
  }

  if (!allowedDownloadHosts().includes(source.host)) {
    throw new Error(`External recipe source host is not allowed: ${source.host}`)
  }

  const directory = await mkdtemp(join(tmpdir(), `wp-codebox-source-${slug}-`))
  const zipPath = join(directory, "source.zip")
  const extractDirectory = join(directory, "extracted")
  await mkdir(extractDirectory, { recursive: true })
  const digest = await downloadRecipeSourceZip(source.resolvedUrl, zipPath, source.expectedSha256)
  await assertSafeZipEntries(zipPath)
  await execFileAsync("unzip", ["-q", zipPath, "-d", extractDirectory])
  await assertExtractedSourceBounds(extractDirectory)

  return {
    source: await extractedPluginSourceDirectory(extractDirectory, slug),
    cleanupPaths: [directory],
    provenance: {
      ...recipeSourceProvenance(source, recipeDirectory),
      digest: { sha256: digest, ...(source.expectedSha256 ? { expected: source.expectedSha256, verified: true } : {}) },
      policy: {
        host: source.host,
        maxDownloadBytes: maxDownloadBytes(),
        maxExtractedBytes: maxExtractedBytes(),
        maxExtractedFiles: maxExtractedFiles(),
        sha256Required: sourceSha256Required(),
      },
      localPathCategory: "temporary-download",
    },
  }
}

async function downloadRecipeSourceZip(url: string, targetPath: string, expectedSha256?: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download recipe source ${url}: HTTP ${response.status}`)
  }

  const finalUrl = response.url || url
  let finalSource: ReturnType<typeof recipeSource>
  try {
    finalSource = recipeSource(finalUrl, expectedSha256)
  } catch (error) {
    throw new Error(`Recipe source redirected to an invalid URL: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (finalSource.type === "local" || !allowedDownloadHosts().includes(finalSource.host)) {
    throw new Error(`Recipe source redirected to a host that is not allowed: ${finalSource.host || finalUrl}`)
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0")
  if (contentLength > maxDownloadBytes()) {
    throw new Error(`Recipe source download exceeds ${maxDownloadBytes()} bytes: ${url}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxDownloadBytes()) {
    throw new Error(`Recipe source download exceeds ${maxDownloadBytes()} bytes: ${url}`)
  }

  const digest = createHash("sha256").update(buffer).digest("hex")
  if (expectedSha256 && digest !== expectedSha256.toLowerCase()) {
    throw new Error(`Recipe source sha256 mismatch for ${url}: expected ${expectedSha256.toLowerCase()}, got ${digest}`)
  }

  await writeFile(targetPath, buffer)
  return digest
}

async function assertSafeZipEntries(zipPath: string): Promise<void> {
  const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath])
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length > maxExtractedFiles()) {
    throw new Error(`Recipe source zip contains too many entries: ${entries.length}`)
  }

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/")
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`Recipe source zip contains an unsafe path: ${entry}`)
    }
  }
}

async function assertExtractedSourceBounds(directory: string): Promise<void> {
  const totals = await directoryTotals(directory)
  if (totals.files > maxExtractedFiles()) {
    throw new Error(`Recipe source extraction contains too many files: ${totals.files}`)
  }
  if (totals.bytes > maxExtractedBytes()) {
    throw new Error(`Recipe source extraction exceeds ${maxExtractedBytes()} bytes: ${totals.bytes}`)
  }
}

async function directoryTotals(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const child = await directoryTotals(path)
      files += child.files
      bytes += child.bytes
    } else if (entry.isFile()) {
      const result = await stat(path)
      files += 1
      bytes += result.size
    }
  }
  return { files, bytes }
}

async function extractedPluginSourceDirectory(extractDirectory: string, slug: string): Promise<string> {
  const slugDirectory = join(extractDirectory, slug)
  try {
    const result = await stat(slugDirectory)
    if (result.isDirectory()) {
      return slugDirectory
    }
  } catch {
    // Fall through to generic zip layout.
  }

  return extractDirectory
}

async function prepareRecipeWorkspace(workspace: WorkspaceRecipeWorkspace, recipeDirectory: string, slug: string): Promise<PreparedWorkspaceSource> {
  const directory = await mkdtemp(join(tmpdir(), `wp-codebox-${slug}-`))
  const baselineDirectory = await mkdtemp(join(tmpdir(), `wp-codebox-${slug}-baseline-`))
  if (workspace.seed.type === "directory") {
    const source = resolve(recipeDirectory, workspace.seed.source ?? "")
    await copyWorkspaceSeedDirectory(source, directory, workspace.seed.excludePaths)
    await copyWorkspaceSeedDirectory(source, baselineDirectory, workspace.seed.excludePaths)
    await ensureStandaloneGitPrimary(directory)
    return { source: directory, baselineSource: baselineDirectory, cleanupPaths: [directory, baselineDirectory] }
  }

  if (workspace.seed.type === "theme_scaffold") {
    await writeThemeScaffold(directory, slug, workspace.seed.name ?? titleFromSlug(slug))
    await writeThemeScaffold(baselineDirectory, slug, workspace.seed.name ?? titleFromSlug(slug))
    return { source: directory, baselineSource: baselineDirectory, cleanupPaths: [directory, baselineDirectory] }
  }

  await writePluginScaffold(directory, slug, workspace.seed.name ?? titleFromSlug(slug))
  await writePluginScaffold(baselineDirectory, slug, workspace.seed.name ?? titleFromSlug(slug))
  return { source: directory, baselineSource: baselineDirectory, cleanupPaths: [directory, baselineDirectory] }
}

async function ensureStandaloneGitPrimary(directory: string): Promise<void> {
  const gitPath = join(directory, ".git")
  try {
    const gitStat = await stat(gitPath)
    if (gitStat.isDirectory()) {
      return
    }

    await rm(gitPath, { force: true })
  } catch {
    // No Git metadata was copied; initialize a sandbox-local primary below.
  }

  await execFileAsync("git", ["init", "--quiet"], { cwd: directory })
}

function defaultWorkspaceTarget(workspace: WorkspaceRecipeWorkspace, slug: string): string {
  if (workspace.seed.type === "theme_scaffold") {
    return `/wordpress/wp-content/themes/${slug}`
  }

  if (workspace.seed.type === "plugin_scaffold") {
    return `/wordpress/wp-content/plugins/${slug}`
  }

  if (workspace.target) {
    return workspace.target
  }

  return `${SANDBOX_WORKSPACE_ROOT}/${slug}`
}

function sandboxWorkspaceContract(workspaceMounts: PreparedWorkspaceMount[], mounts: NonNullable<WorkspaceRecipe["inputs"]>["mounts"]): SandboxWorkspaceContract {
  const mountRefs = [
    ...workspaceMounts.map((mount) => workspaceMountRef(mount.target, mount.mode, mount.metadata)),
    ...(Array.isArray(mounts) ? mounts.map((mount) => workspaceMountRef(mount.target, mount.mode ?? "readwrite", mount.metadata ?? {})) : []),
  ]

  return {
    schema: "wp-codebox/sandbox-workspace/v1",
    root: SANDBOX_WORKSPACE_ROOT,
    defaultMode: "repo-backed",
    mounts: mountRefs,
    dmc: {
      safeAbilities: [...SANDBOX_DMC_SAFE_ABILITIES],
      parentOnlyAbilities: [...SANDBOX_DMC_PARENT_ONLY_ABILITIES],
    },
  }
}

function workspaceMountRef(target: string, mode: "readonly" | "readwrite", metadata: Record<string, unknown> = {}): SandboxWorkspaceContract["mounts"][number] {
  const sourceMode: SandboxWorkspaceMode = metadata.sourceMode === "site-backed" ? "site-backed" : "repo-backed"

  return stripUndefined({
    target,
    mode,
    sourceMode,
    workspaceRef: typeof metadata.workspaceRef === "string" ? metadata.workspaceRef : undefined,
    mountRole: typeof metadata.mountRole === "string" ? metadata.mountRole : typeof metadata.kind === "string" ? metadata.kind : undefined,
    component: typeof metadata.component === "string" ? metadata.component : typeof metadata.slug === "string" ? metadata.slug : undefined,
    repo: typeof metadata.repo === "string" ? metadata.repo : undefined,
    gitRef: typeof metadata.gitRef === "string" ? metadata.gitRef : typeof metadata.default_branch === "string" ? metadata.default_branch : undefined,
    defaultBranch: typeof metadata.default_branch === "string" ? metadata.default_branch : undefined,
    wpContentPath: typeof metadata.wpContentPath === "string" ? metadata.wpContentPath : undefined,
  })
}

async function writePluginScaffold(directory: string, slug: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${slug}.php`), `<?php
/**
 * Plugin Name: ${name}
 * Description: WP Codebox seeded plugin workspace.
 * Version: 0.1.0
 */

defined( 'ABSPATH' ) || exit;

add_action( 'init', static function (): void {
	do_action( '${slug.replace(/-/g, "_")}_loaded' );
} );
`)
  await writeFile(join(directory, "README.md"), `# ${name}

Seeded by WP Codebox.
`)
}

async function writeThemeScaffold(directory: string, slug: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "style.css"), `/*
Theme Name: ${name}
Description: WP Codebox seeded theme workspace.
Version: 0.1.0
*/
`)
  await writeFile(join(directory, "index.php"), `<?php
?><main id="site-content"><h1><?php bloginfo( 'name' ); ?></h1></main>
`)
  await writeFile(join(directory, "README.md"), `# ${name}

Seeded by WP Codebox.
`)
}

function titleFromSlug(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ")
}

function recipeExtraPlugins(recipe: WorkspaceRecipe): WorkspaceRecipeExtraPlugin[] {
  return recipe.inputs?.extra_plugins ?? recipe.inputs?.extraPlugins ?? []
}

function recipeSource(sourceRef: string, expectedSha256?: string): { type: RecipeSourceType; resolvedUrl: string; host: string; expectedSha256?: string; wporgSlug?: string } {
  let url: URL
  try {
    url = new URL(sourceRef)
  } catch {
    return { type: "local", resolvedUrl: sourceRef, host: "" }
  }

  if (url.protocol !== "https:") {
    throw new Error(`External recipe sources must use https:// URLs: ${sourceRef}`)
  }

  if (!url.pathname.toLowerCase().endsWith(".zip")) {
    throw new Error(`External recipe sources must point to .zip archives: ${sourceRef}`)
  }

  if (url.hostname === "downloads.wordpress.org" && url.pathname.startsWith("/plugin/")) {
    const filename = basename(url.pathname)
    const match = filename.match(/^([A-Za-z0-9_-]+)\./)
    return { type: "wporg_plugin_zip", resolvedUrl: url.toString(), host: url.hostname, ...(expectedSha256 ? { expectedSha256: expectedSha256.toLowerCase() } : {}), ...(match ? { wporgSlug: match[1] } : {}) }
  }

  return { type: "https_zip", resolvedUrl: url.toString(), host: url.hostname, ...(expectedSha256 ? { expectedSha256: expectedSha256.toLowerCase() } : {}) }
}

function recipeSourceProvenance(source: ReturnType<typeof recipeSource>, recipeDirectory: string): RecipeSourceProvenance {
  if (source.type === "local") {
    return {
      kind: "local",
      original: source.resolvedUrl,
      localPathCategory: resolve(recipeDirectory, source.resolvedUrl).startsWith(recipeDirectory) ? "recipe-relative" : undefined,
    }
  }

  return {
    kind: source.type,
    original: source.resolvedUrl,
    resolvedUrl: source.resolvedUrl,
    ...(source.expectedSha256 ? { digest: { sha256: source.expectedSha256, expected: source.expectedSha256, verified: false } } : {}),
    policy: {
      host: source.host,
      maxDownloadBytes: maxDownloadBytes(),
      maxExtractedBytes: maxExtractedBytes(),
      maxExtractedFiles: maxExtractedFiles(),
      sha256Required: sourceSha256Required(),
    },
  }
}

function recipeExtraPluginSlug(plugin: WorkspaceRecipeExtraPlugin): string {
  if (plugin.slug) {
    return plugin.slug
  }

  const source = recipeSource(plugin.source, plugin.sha256)
  if (source.wporgSlug) {
    return source.wporgSlug
  }

  if (source.type !== "local") {
    throw new Error(`External extra_plugins sources require slug when it cannot be inferred from a WordPress.org plugin URL: ${plugin.source}`)
  }

  return basename(resolve(plugin.source))
}

function recipeExtraPluginFile(plugin: WorkspaceRecipeExtraPlugin): string {
  const slug = recipeExtraPluginSlug(plugin)
  return plugin.pluginFile ?? `${slug}/${slug}.php`
}

function pluginTarget(slug: string, loadAs: PreparedExtraPlugin["loadAs"]): string {
  if (loadAs === "mu-plugin") {
    return `/wordpress/wp-content/mu-plugins/wp-codebox-runtime/${slug}`
  }

  return `/wordpress/wp-content/plugins/${slug}`
}

async function resolveRecipeExtraPluginFile(plugin: WorkspaceRecipeExtraPlugin, recipeDirectory: string): Promise<string> {
  const slug = recipeExtraPluginSlug(plugin)
  if (plugin.pluginFile) {
    return plugin.pluginFile
  }

  const source = recipeSource(plugin.source, plugin.sha256)
  if (source.type === "local") {
    const pluginSource = resolve(recipeDirectory, plugin.source)
    for (const candidate of [`${slug}/${slug}.php`, `${slug}/plugin.php`]) {
      try {
        const result = await stat(join(pluginSource, candidate.slice(slug.length + 1)))
        if (result.isFile()) {
          return candidate
        }
      } catch {
        // Try the next common plugin entrypoint.
      }
    }
  }

  return `${slug}/${slug}.php`
}

function activateExtraPluginsCode(extraPlugins: PreparedExtraPlugin[]): string | null {
  const pluginFiles = extraPlugins
    .filter((plugin) => plugin.loadAs === "plugin" && plugin.activate !== false)
    .map((plugin) => plugin.pluginFile)

  if (pluginFiles.length === 0) {
    return null
  }

  return `require_once ABSPATH . 'wp-admin/includes/plugin.php';
$plugins = ${JSON.stringify(pluginFiles)};
$activated = array();
foreach ($plugins as $plugin) {
    $plugin_file = WP_PLUGIN_DIR . '/' . $plugin;
    if (! file_exists($plugin_file)) {
        throw new RuntimeException(sprintf('Recipe extra plugin is not mounted: %s', $plugin));
    }
    if (! is_plugin_active($plugin)) {
        $result = activate_plugin($plugin);
        if (is_wp_error($result)) {
            throw new RuntimeException($result->get_error_message());
        }
    }
    $activated[] = $plugin;
}
echo wp_json_encode(array('command' => 'activate-extra-plugins', 'plugins' => $activated), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function installMuPluginsCode(extraPlugins: PreparedExtraPlugin[]): string | null {
  const muPlugins = extraPlugins
    .filter((plugin) => plugin.loadAs === "mu-plugin")
    .map((plugin) => plugin.pluginFile)

  if (muPlugins.length === 0) {
    return null
  }

  return `$plugins = ${JSON.stringify(muPlugins)};
$runtime_dir = WPMU_PLUGIN_DIR . '/wp-codebox-runtime';
if (!is_dir(WPMU_PLUGIN_DIR) && !mkdir(WPMU_PLUGIN_DIR, 0777, true) && !is_dir(WPMU_PLUGIN_DIR)) {
    throw new RuntimeException('Could not create mu-plugins directory.');
}
if (!is_dir($runtime_dir)) {
    throw new RuntimeException('WP Codebox runtime mu-plugin directory is not mounted.');
}
$loader = WPMU_PLUGIN_DIR . '/wp-codebox-runtime-loader.php';
$lines = array(
    '<?php',
    '/**',
    ' * Plugin Name: WP Codebox Runtime Loader',
    ' * Description: Loads WP Codebox runtime substrate as must-use plugins.',
    ' */',
    '',
    "defined( 'ABSPATH' ) || exit;",
    '',
    "if ( ! defined( 'DATAMACHINE_WORKSPACE_PATH' ) ) {",
    "    define( 'DATAMACHINE_WORKSPACE_PATH', ${JSON.stringify(SANDBOX_WORKSPACE_ROOT)} );",
    "}",
    "add_filter( 'datamachine_should_load_full_runtime', '__return_true', 1 );",
    '',
);
foreach ($plugins as $plugin) {
    if ('' === $plugin || str_starts_with($plugin, '/') || str_contains($plugin, '..') || !str_ends_with($plugin, '.php')) {
        throw new RuntimeException('Unsafe WP Codebox runtime mu-plugin entry.');
    }
    $plugin_file = $runtime_dir . '/' . $plugin;
    if (!file_exists($plugin_file)) {
        throw new RuntimeException(sprintf('WP Codebox runtime mu-plugin is not mounted: %s', $plugin));
    }
    $lines[] = "require_once WPMU_PLUGIN_DIR . '/wp-codebox-runtime/" . str_replace("'", "\\'", $plugin) . "';";
}
if (false === file_put_contents($loader, implode("\\n", $lines) . "\\n")) {
    throw new RuntimeException('Could not write WP Codebox runtime mu-plugin loader.');
}
echo wp_json_encode(array('command' => 'install-mu-plugins', 'plugins' => $plugins, 'loader' => $loader), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
}

function parseMount(value: string): RunOptions["mounts"][number] {
  const [source, target, mode = "readwrite"] = value.split(":")

  if (!source || !target) {
    throw new Error(`Invalid mount, expected host:vfs: ${value}`)
  }

  if (mode !== "readonly" && mode !== "readwrite") {
    throw new Error(`Invalid mount mode, expected readonly or readwrite: ${mode}`)
  }

  return {
    source: resolve(source),
    target,
    mode,
    metadata: {
      kind: "cli-mount",
    },
  }
}

async function parsePolicy(value: string): Promise<RuntimePolicy> {
  return JSON.parse(await readJsonOption(value)) as RuntimePolicy
}

async function parseJsonOption(value: string): Promise<unknown> {
  return JSON.parse(await readJsonOption(value))
}

async function readJsonOption(value: string): Promise<string> {
  const trimmed = value.trim()
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? value : await readFile(resolve(value), "utf8")
}

function jsonOptionPath(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? undefined : resolve(value)
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(serializeError(error)?.message ?? String(error))
    process.exitCode = 1
  },
)
