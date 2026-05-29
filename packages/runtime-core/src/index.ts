import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"

export * from "./workspace-policy.js"
export * from "./sandbox-datamachine-tool-policy.js"

export type RuntimeBackendKind = "wordpress-playground" | (string & {})

export const RUNTIME_EPISODE_TRACE_SCHEMA = "wp-codebox/runtime-episode-trace/v1" as const
export const RUNTIME_EPISODE_ACTION_SCHEMA = "wp-codebox/runtime-episode-action/v1" as const
export const RUNTIME_EPISODE_OBSERVATION_SCHEMA = "wp-codebox/runtime-episode-observation/v1" as const
export const RUNTIME_EPISODE_SNAPSHOT_SCHEMA = "wp-codebox/runtime-episode-snapshot/v1" as const
export const RUNTIME_REFERENCE_MANIFEST_SCHEMA = "wp-codebox/runtime-reference-manifest/v1" as const
export const RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA = "wp-codebox/runtime-replay-reference-index/v1" as const
export const RUNTIME_ACTION_OBSERVATION_SCHEMA = "wp-codebox/runtime-action-observation/v1" as const

export type CommandHandlerBinding =
  | { kind: "playground"; method: string }
  | { kind: "recipe-alias"; command: string }

export interface CommandDefinition {
  id: string
  description: string
  acceptedArgs: Array<{
    name: string
    description: string
    required?: boolean
    repeatable?: boolean
    format?: string
  }>
  outputShape: string
  policyRequirement: string
  recipe: boolean
  handler: CommandHandlerBinding
}

export const commandRegistry = [
  {
    id: "inspect-mounted-inputs",
    description: "List mounted input entries visible inside the Playground runtime.",
    acceptedArgs: [],
    outputShape: "JSON array of mounted input descriptors.",
    policyRequirement: "Runtime policy commands must include inspect-mounted-inputs.",
    recipe: true,
    handler: { kind: "playground", method: "inspectMountedInputs" },
  },
  {
    id: "wordpress.run-php",
    description: "Run PHP against WordPress, bootstrapping wp-load.php unless bootstrap=none is supplied.",
    acceptedArgs: [
      { name: "code", description: "Inline PHP code to run.", format: "PHP string" },
      { name: "code-file", description: "Path to a PHP file whose contents should run.", format: "path" },
      { name: "bootstrap", description: "Use bootstrap=none to skip wp-load.php.", format: "wordpress|none" },
    ],
    outputShape: "Raw command stdout from the PHP snippet.",
    policyRequirement: "Runtime policy commands must include wordpress.run-php.",
    recipe: true,
    handler: { kind: "playground", method: "runPhp" },
  },
  {
    id: "wordpress.wp-cli",
    description: "Run a WP-CLI command inside the same disposable WordPress runtime.",
    acceptedArgs: [
      { name: "command", description: "WP-CLI command line, with or without the leading wp token.", required: true, format: "string" },
    ],
    outputShape: "Raw WP-CLI stdout.",
    policyRequirement: "Runtime policy commands must include wordpress.wp-cli.",
    recipe: true,
    handler: { kind: "playground", method: "runWpCli" },
  },
  {
    id: "wordpress.ability",
    description: "Execute a registered WordPress Ability in the sandbox.",
    acceptedArgs: [
      { name: "name", description: "Ability name to execute.", required: true, format: "string" },
      { name: "input", description: "Ability input payload.", format: "JSON object" },
    ],
    outputShape: "JSON object with command, name, input, and result fields.",
    policyRequirement: "Runtime policy commands must include wordpress.ability.",
    recipe: true,
    handler: { kind: "playground", method: "runAbility" },
  },
  {
    id: "wordpress.bench",
    description: "Run plugin benchmark workloads and emit a normalized benchmark results envelope.",
    acceptedArgs: [
      { name: "component-id", description: "Component id for the benchmark results envelope.", format: "string" },
      { name: "plugin-slug", description: "Plugin slug containing tests/bench workloads.", required: true, format: "slug" },
      { name: "iterations", description: "Measured iterations per workload.", format: "positive integer" },
      { name: "warmup", description: "Warmup iterations before measurement.", format: "non-negative integer" },
      { name: "dependency-slugs", description: "Comma-separated plugin dependency slugs to load.", format: "comma-separated slugs" },
      { name: "env-json", description: "Benchmark environment object.", format: "JSON object" },
      { name: "workloads-json", description: "Explicit workload list.", format: "JSON array" },
    ],
    outputShape: "Benchmark results JSON envelope with component_id, iterations, and scenarios.",
    policyRequirement: "Runtime policy commands must include wordpress.bench.",
    recipe: true,
    handler: { kind: "playground", method: "runBench" },
  },
  {
    id: "wordpress.phpunit",
    description: "Run plugin PHPUnit tests with normalized diagnostics and test-result artifact capture.",
    acceptedArgs: [
      { name: "plugin-slug", description: "Plugin slug under wp-content/plugins.", format: "slug" },
      { name: "code", description: "Inline override PHP runner code.", format: "PHP string" },
      { name: "code-file", description: "Path to override PHP runner code.", format: "path" },
      { name: "autoload-file", description: "PHPUnit/vendor autoload path inside the sandbox.", format: "sandbox path" },
      { name: "tests-dir", description: "WP PHPUnit tests directory inside the sandbox.", format: "sandbox path" },
      { name: "phpunit-xml", description: "phpunit.xml path inside the plugin.", format: "path" },
      { name: "test-file", description: "Single test file to run.", format: "path" },
      { name: "changed-tests-json", description: "Changed test files for diagnostics.", format: "JSON array" },
      { name: "env-json", description: "PHPUnit environment values.", format: "JSON object" },
      { name: "wp-config-defines-json", description: "wp-config.php constants for the run.", format: "JSON object" },
      { name: "dependency-mounts", description: "Comma-separated mounted dependency paths.", format: "comma-separated sandbox paths" },
      { name: "multisite", description: "Run as multisite.", format: "boolean" },
    ],
    outputShape: "Raw PHPUnit runner JSON/log output plus normalized test-results artifact when artifacts are collected.",
    policyRequirement: "Runtime policy commands must include wordpress.phpunit.",
    recipe: true,
    handler: { kind: "playground", method: "runPhpunit" },
  },
  {
    id: "wordpress.plugin-check",
    description: "Run the official WordPress Plugin Check plugin against a mounted plugin and emit normalized findings.",
    acceptedArgs: [
      { name: "plugin-slug", description: "Plugin slug under wp-content/plugins to validate.", required: true, format: "slug" },
      { name: "checks", description: "Optional comma-separated official Plugin Check slugs to run; omit to run the default suite.", format: "comma-separated check slugs" },
    ],
    outputShape: "wp-codebox/plugin-check/v1 JSON with command, target plugin, exit code/status, summary counts, and findings; raw and normalized outputs are captured in artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.plugin-check.",
    recipe: true,
    handler: { kind: "playground", method: "runPluginCheck" },
  },
  {
    id: "wordpress.core-phpunit",
    description: "Run WordPress core PHPUnit tests with normalized diagnostics and test-result artifact capture.",
    acceptedArgs: [
      { name: "core-root", description: "WordPress develop checkout root inside the sandbox.", format: "sandbox path" },
      { name: "tests-dir", description: "Core tests directory inside the sandbox.", format: "sandbox path" },
      { name: "phpunit-xml", description: "phpunit.xml path.", format: "path" },
      { name: "test-file", description: "Single test file to run.", format: "path" },
      { name: "changed-tests-json", description: "Changed test files for diagnostics.", format: "JSON array" },
      { name: "autoload-file", description: "Autoload path inside the sandbox.", format: "sandbox path" },
      { name: "wp-config-defines-json", description: "wp-config.php constants for the run.", format: "JSON object" },
      { name: "multisite", description: "Run as multisite.", format: "boolean" },
    ],
    outputShape: "Raw PHPUnit runner JSON/log output plus normalized test-results artifact when artifacts are collected.",
    policyRequirement: "Runtime policy commands must include wordpress.core-phpunit.",
    recipe: true,
    handler: { kind: "playground", method: "runCorePhpunit" },
  },
  {
    id: "wordpress.theme-check",
    description: "Run Theme Check against a mounted WordPress theme inside the disposable Playground runtime.",
    acceptedArgs: [
      { name: "theme", description: "Theme slug under wp-content/themes.", required: true, format: "slug" },
    ],
    outputShape: "Normalized Theme Check JSON plus files/theme-check raw and normalized artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.theme-check.",
    recipe: true,
    handler: { kind: "playground", method: "runThemeCheck" },
  },
  {
    id: "wordpress.browser-probe",
    description: "Open the live Playground preview in Playwright and capture generic browser replay/audit evidence artifacts.",
    acceptedArgs: [
      { name: "url", description: "Preview path or absolute URL to visit.", required: true, format: "path or URL" },
      { name: "wait-for", description: "Navigation wait condition.", format: "domcontentloaded|load|networkidle|selector:<selector>|duration" },
      { name: "duration", description: "Extra capture duration, or wait time when wait-for=duration.", format: "duration, e.g. 2s or 500ms" },
      { name: "capture", description: "Comma-separated artifacts to capture.", format: "console,errors,html,network,screenshot" },
    ],
    outputShape: "JSON summary plus files/browser/console.jsonl, errors.jsonl, network.jsonl, snapshot.html, summary.json, and screenshot.png when captured.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-probe.",
    recipe: true,
    handler: { kind: "playground", method: "runBrowserProbe" },
  },
  {
    id: "wordpress.browser-actions",
    description: "Run generic browser interactions against the live Playground preview and capture replay/audit evidence artifacts.",
    acceptedArgs: [
      { name: "url", description: "Initial preview path or absolute URL to visit when actions-json omits an initial navigate action.", format: "path or URL" },
      { name: "actions-json", description: "Ordered browser actions to run: navigate, click, fill, press, wait, and capture.", required: true, format: "JSON array" },
      { name: "capture", description: "Comma-separated artifacts to capture after interactions.", format: "actions,console,errors,html,network,screenshot" },
    ],
    outputShape: "JSON summary plus files/browser/actions.jsonl, action-summary.json, and optional console/errors/network/html/screenshot artifacts.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-actions.",
    recipe: true,
    handler: { kind: "playground", method: "runBrowserActions" },
  },
  {
    id: "wp-codebox.agent-runtime-probe",
    description: "Recipe-only probe that boots Agents API, Data Machine, and Data Machine Code and verifies the stack loads.",
    acceptedArgs: [
      { name: "provider-plugin-slugs", description: "Comma-separated provider plugin slugs already mounted by recipe inputs.", format: "comma-separated slugs" },
    ],
    outputShape: "JSON probe result emitted by the sandbox PHP runner.",
    policyRequirement: "Recipe policy maps this helper to wordpress.run-php.",
    recipe: true,
    handler: { kind: "recipe-alias", command: "wordpress.run-php" },
  },
  {
    id: "wp-codebox.agent-sandbox-run",
    description: "Recipe-only helper that runs one natural-language task through the sandboxed agent stack.",
    acceptedArgs: [
      { name: "task", description: "Task prompt for the sandbox agent.", required: true, format: "string" },
      { name: "agent", description: "Agent slug.", format: "string" },
      { name: "mode", description: "Agent mode.", format: "string" },
      { name: "provider", description: "AI provider id.", format: "string" },
      { name: "model", description: "Model id.", format: "string" },
      { name: "session-id", description: "Conversation session id.", format: "string" },
      { name: "max-turns", description: "Maximum agent loop turns.", format: "positive integer" },
      { name: "timeout-seconds", description: "Maximum wall-clock seconds for the sandbox agent PHP task.", format: "positive integer" },
      { name: "provider-plugin-slugs", description: "Comma-separated provider plugin slugs already mounted by recipe inputs.", format: "comma-separated slugs" },
      { name: "code", description: "Inline PHP runner override for operator/debug use.", format: "PHP string" },
      { name: "code-file", description: "Path to PHP runner override for operator/debug use.", format: "path" },
    ],
    outputShape: "JSON agent run result emitted by the sandbox PHP runner.",
    policyRequirement: "Recipe policy maps this helper to wordpress.run-php.",
    recipe: true,
    handler: { kind: "recipe-alias", command: "wordpress.run-php" },
  },
] as const satisfies readonly CommandDefinition[]

export type CommandId = typeof commandRegistry[number]["id"]
export type PlaygroundRuntimeCommandDefinition = Extract<typeof commandRegistry[number], { handler: { kind: "playground" } }>
export type PlaygroundRuntimeCommandId = PlaygroundRuntimeCommandDefinition["id"]

export function getCommandDefinition(command: string): CommandDefinition | undefined {
  return commandRegistry.find((definition) => definition.id === command)
}

export function runtimeCommandDefinitions(): CommandDefinition[] {
  return commandRegistry.filter((definition) => definition.handler.kind === "playground")
}

export function recipeCommandDefinitions(): CommandDefinition[] {
  return commandRegistry.filter((definition) => definition.recipe)
}

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

export const TASK_INPUT_SCHEMA = "wp-codebox/task-input/v1" as const
export const TASK_INPUT_VERSION = 1 as const

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
  schema: typeof TASK_INPUT_SCHEMA
  version: typeof TASK_INPUT_VERSION
  goal: string
  target: Partial<TaskTarget>
  allowed_tools: string[]
  expected_artifacts: string[]
  policy: TaskInputPolicy
  context: Record<string, unknown>
}

export type TaskInputRequest = Partial<Omit<TaskInput, "schema" | "version" | "goal">> & {
  goal?: string
  task?: string
}

export const TASK_INPUT_JSON_SCHEMA = {
  $id: TASK_INPUT_SCHEMA,
  type: "object",
  required: ["schema", "version", "goal", "target", "allowed_tools", "expected_artifacts", "policy", "context"],
  properties: {
    schema: { const: TASK_INPUT_SCHEMA, description: "Task input contract schema id." },
    version: { const: TASK_INPUT_VERSION, description: "Task input contract version." },
    goal: { type: "string", description: "User-facing outcome the sandboxed coding agent should accomplish." },
    target: {
      type: "object",
      description: "Bounded target for the task, such as a repo, site, plugin, or theme.",
      properties: {
        kind: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
      },
    },
    allowed_tools: {
      type: "array",
      description: "Tool names the product caller expects the sandboxed agent to stay within.",
      items: { type: "string" },
    },
    expected_artifacts: {
      type: "array",
      description: "Artifact kinds the caller wants back, such as patch, review, tests, preview, or package.",
      items: { type: "string" },
    },
    policy: {
      type: "object",
      description: "Caller policy hints for approvals, apply-back, sandboxing, and risk controls.",
    },
    context: {
      type: "object",
      description: "Additional non-secret caller context for the sandboxed task.",
    },
  },
} as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const items: string[] = []
  for (const item of value) {
    const normalized = String(item).trim()
    if (normalized !== "" && !items.includes(normalized)) items.push(normalized)
  }

  return items
}

export function normalizeTaskInput(input: TaskInputRequest): TaskInput {
  const goal = String(input.goal ?? input.task ?? "").trim()
  if (goal === "") throw new Error("goal or task is required.")

  return {
    schema: TASK_INPUT_SCHEMA,
    version: TASK_INPUT_VERSION,
    goal,
    target: isPlainObject(input.target) ? input.target : {},
    allowed_tools: stringList(input.allowed_tools),
    expected_artifacts: stringList(input.expected_artifacts),
    policy: isPlainObject(input.policy) ? input.policy : {},
    context: isPlainObject(input.context) ? input.context : {},
  }
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
  sha256?: string
  loadAs?: "plugin" | "mu-plugin"
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

export type WorkspaceRecipeJsonSchema = Record<string, unknown>

export interface WorkspaceRecipeJsonSchemaOptions {
  recipeCommandIds?: readonly string[]
}

export function createWorkspaceRecipeJsonSchema(options: WorkspaceRecipeJsonSchemaOptions = {}): WorkspaceRecipeJsonSchema {
  const commandSchema = options.recipeCommandIds && options.recipeCommandIds.length > 0
    ? { enum: [...options.recipeCommandIds] }
    : { type: "string" }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "wp-codebox/workspace-recipe/v1",
    title: "WP Codebox workspace recipe",
    type: "object",
    additionalProperties: false,
    required: ["schema", "workflow"],
    properties: {
      schema: { const: "wp-codebox/workspace-recipe/v1" },
      runtime: {
        type: "object",
        additionalProperties: false,
        properties: {
          backend: { const: "wordpress-playground" },
          name: { type: "string" },
          wp: { type: "string" },
          blueprint: { type: "object" },
        },
      },
      inputs: {
        type: "object",
        additionalProperties: false,
        properties: {
          mounts: {
            type: "array",
            items: { $ref: "#/$defs/mount" },
          },
          workspaces: {
            type: "array",
            items: { $ref: "#/$defs/workspace" },
          },
          extra_plugins: {
            type: "array",
            items: { $ref: "#/$defs/extraPlugin" },
          },
          extraPlugins: {
            type: "array",
            items: { $ref: "#/$defs/extraPlugin" },
          },
          secretEnv: {
            type: "array",
            items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
          },
          siteSeeds: {
            type: "array",
            description: "Explicit site/content seed declarations. Local JSON fixture seeds are imported into the sandbox before workflow steps. Parent-site declarations remain bounded, auditable metadata until export support lands.",
            items: { $ref: "#/$defs/siteSeed" },
          },
          stagedFiles: {
            type: "array",
            description: "Local recipe-owned files or directories copied into absolute sandbox paths before workflow steps execute.",
            items: { $ref: "#/$defs/stagedFile" },
          },
          inherit: { $ref: "#/$defs/inheritanceRequest" },
          inheritance: { $ref: "#/$defs/inheritanceResolution" },
        },
      },
      workflow: {
        type: "object",
        additionalProperties: false,
        required: ["steps"],
        properties: {
          before: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
          steps: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/step" },
          },
          after: {
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
        },
      },
      artifacts: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string" },
          verify: { $ref: "#/$defs/artifactVerifier" },
          workspacePolicy: { $ref: "#/$defs/workspacePolicyArtifact" },
        },
      },
    },
    $defs: {
      artifactVerifier: {
        oneOf: [
          { type: "boolean" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              strict: { type: "boolean" },
            },
          },
        ],
      },
      workspacePolicyArtifact: {
        oneOf: [
          { type: "boolean" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              strict: { type: "boolean" },
              writableRoots: { type: "array", items: { type: "string" } },
              hiddenPaths: { type: "array", items: { type: "string" } },
              gitBacked: { type: "boolean" },
            },
          },
        ],
      },
      metadata: {
        type: "object",
        additionalProperties: true,
      },
      mount: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
          mode: { enum: ["readonly", "readwrite"] },
          metadata: { $ref: "#/$defs/metadata" },
        },
      },
      workspace: {
        type: "object",
        additionalProperties: false,
        required: ["seed"],
        properties: {
          target: { type: "string", pattern: "^/" },
          mode: { enum: ["readonly", "readwrite"] },
          sourceMode: { enum: ["repo-backed", "site-backed"] },
          seed: { $ref: "#/$defs/workspaceSeed" },
        },
      },
      workspaceSeed: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { enum: ["plugin_scaffold", "theme_scaffold", "directory"] },
          slug: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          name: { type: "string" },
          source: { type: "string" },
          excludePaths: { type: "array", items: { type: "string" } },
        },
      },
      extraPlugin: {
        type: "object",
        additionalProperties: false,
        required: ["source"],
        properties: {
          source: {
            type: "string",
            description: "Local plugin directory path, WordPress.org plugin zip URL, or generic HTTPS zip URL.",
          },
          slug: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
          pluginFile: { type: "string" },
          activate: { type: "boolean" },
          sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        },
      },
      siteSeed: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "scopes"],
        properties: {
          type: { enum: ["fixture", "parent_site"] },
          name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          source: { type: "string", description: "Fixture file path. Not allowed for parent_site dry-run declarations." },
          format: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
          scopes: {
            type: "object",
            additionalProperties: false,
            properties: {
              posts: { $ref: "#/$defs/siteSeedScope" },
              terms: { $ref: "#/$defs/siteSeedScope" },
              options: { $ref: "#/$defs/siteSeedScope" },
              users: { $ref: "#/$defs/siteSeedScope" },
              media: { $ref: "#/$defs/siteSeedScope" },
              activePlugins: { type: "boolean" },
              activeTheme: { type: "boolean" },
            },
          },
        },
      },
      siteSeedScope: {
        type: "object",
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 100 },
          slugs: { type: "array", items: { type: "string" }, maxItems: 100 },
          names: { type: "array", items: { type: "string" }, maxItems: 100 },
          postTypes: { type: "array", items: { type: "string" }, maxItems: 25 },
          taxonomies: { type: "array", items: { type: "string" }, maxItems: 25 },
          roles: { type: "array", items: { type: "string" }, maxItems: 25 },
          statuses: { type: "array", items: { type: "string" }, maxItems: 25 },
          includeFiles: { type: "boolean" },
          anonymize: { type: "boolean" },
          maxRecords: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      stagedFile: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target"],
        properties: {
          source: { type: "string" },
          target: { type: "string", pattern: "^/" },
        },
      },
      step: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: commandSchema,
          args: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      inheritanceRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectors: { type: "array", items: { type: "string" } },
          settings: { type: "array", items: { type: "string" } },
        },
      },
      inheritanceResolution: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectors: { type: "array", items: { $ref: "#/$defs/inheritanceConnector" } },
          settings: { type: "array", items: { $ref: "#/$defs/inheritanceSetting" } },
        },
      },
      inheritanceConnector: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          secretEnv: { type: "array", items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" } },
          credentials: { $ref: "#/$defs/connectorCredentialEnvelope" },
        },
      },
      connectorCredentialEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["schema", "connector", "scope", "status", "secrets"],
        properties: {
          schema: { const: "wp-codebox/connector-credentials/v1" },
          connector: { type: "string" },
          scope: { const: "connector" },
          status: { enum: ["available", "missing", "denied"] },
          reason: { type: "string" },
          secrets: { type: "array", items: { $ref: "#/$defs/connectorCredentialSecret" } },
        },
      },
      connectorCredentialSecret: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$" },
          status: { enum: ["available", "missing", "denied"] },
          scope: { type: "string" },
          source: { type: "string" },
          reason: { type: "string" },
        },
      },
      inheritanceSetting: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { type: "string" },
          scope: { type: "string" },
        },
      },
    },
  }
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
  semantics?: "metadata-only" | "partial-replay" | "replayable-runtime-state" | "runtime-state-artifact" | (string & {})
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
  includeRuntimeSnapshotBundles?: boolean
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

export type RuntimeSnapshotReplayStatus = "metadata-only" | "partial-replay" | "replayable-runtime-state" | "runtime-state-artifact" | "not-replayable" | (string & {})

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

export interface RuntimeReplayReferenceIndexActionRef {
  index: number
  id: string
  actionRef: RuntimeEpisodeTraceRef
  executionRef: RuntimeEpisodeTraceRef
  observationRef?: RuntimeEpisodeTraceRef
}

export interface RuntimeReplayReferenceIndexObservationRef {
  id: string
  type: string
  ref: RuntimeEpisodeTraceRef
  artifactRefs: RuntimeEpisodeTraceRef[]
}

export interface RuntimeReplayReferenceIndex {
  schema: typeof RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA
  version: 1
  id: string
  createdAt: string
  digest: RuntimeEpisodeContentDigest
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  references: {
    trace?: RuntimeReferenceManifestFileRef
    events?: RuntimeReferenceManifestFileRef
    runtimeReferenceManifest?: RuntimeReferenceManifestFileRef
    observations?: RuntimeReferenceManifestFileRef
    commands?: RuntimeReferenceManifestFileRef
    runtimeEvents?: RuntimeReferenceManifestFileRef
    blueprintAfter?: RuntimeReferenceManifestFileRef
    blueprintAfterNotes?: RuntimeReferenceManifestFileRef
    mountedFiles?: RuntimeReferenceManifestFileRef
    mountDiffs?: RuntimeReferenceManifestFileRef
    changedFiles?: RuntimeReferenceManifestFileRef
    patch?: RuntimeReferenceManifestFileRef
    testResults?: RuntimeReferenceManifestFileRef
  }
  actions: RuntimeReplayReferenceIndexActionRef[]
  observations: RuntimeReplayReferenceIndexObservationRef[]
  snapshots: RuntimeReferenceManifestSnapshotRef[]
  replay: {
    status: "partial" | "runtime-state-artifact" | "metadata-only"
    instructions: string[]
    limitations: string[]
  }
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

export interface BuildRuntimeReplayReferenceIndexInput {
  createdAt: string
  runtime: RuntimeInfo
  artifactBundle: RuntimeReferenceManifestArtifactBundleRef
  files: RuntimeReferenceManifestFileRef[]
  trace?: RuntimeReferenceManifestFileRef
  events?: RuntimeReferenceManifestFileRef
  runtimeReferenceManifest?: RuntimeReferenceManifestFileRef
  snapshots?: Snapshot[]
  episodeTrace?: RuntimeEpisodeTrace
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
    runtimeReplayReferenceIndex?: string
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
    actions?: string
    actionCount?: number
    summaryFile?: string
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
  runtimeReplayReferenceIndexPath?: string
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
  await verifyRuntimeReplayReferenceIndexArtifacts(bundleDirectory, manifest, manifestFiles, violations)

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
    && value.artifactRefs.every((ref) => isRecord(ref) && typeof ref.kind === "string" && typeof ref.id === "string" && validDigest(ref.digest))
}

function isRuntimeReplayReferenceIndexShape(value: unknown): value is RuntimeReplayReferenceIndex {
  if (!isRecord(value)) {
    return false
  }

  return value.schema === RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA
    && value.version === 1
    && typeof value.id === "string"
    && typeof value.createdAt === "string"
    && isArtifactFileDigestShape(value.digest)
    && isRecord(value.runtime)
    && isRuntimeReferenceManifestArtifactBundleRefShape(value.artifactBundle)
    && isRuntimeReplayReferenceIndexReferencesShape(value.references)
    && Array.isArray(value.actions)
    && value.actions.every(isRuntimeReplayReferenceIndexActionRefShape)
    && Array.isArray(value.observations)
    && value.observations.every(isRuntimeReplayReferenceIndexObservationRefShape)
    && Array.isArray(value.snapshots)
    && value.snapshots.every(isRuntimeReferenceManifestSnapshotRefShape)
    && isRecord(value.replay)
    && typeof value.replay.status === "string"
    && Array.isArray(value.replay.instructions)
    && value.replay.instructions.every((instruction) => typeof instruction === "string")
    && Array.isArray(value.replay.limitations)
    && value.replay.limitations.every((limitation) => typeof limitation === "string")
}

function isRuntimeReplayReferenceIndexReferencesShape(value: unknown): value is RuntimeReplayReferenceIndex["references"] {
  if (!isRecord(value)) {
    return false
  }

  return Object.values(value).every((reference) => reference === undefined || isRuntimeReferenceManifestFileRefShape(reference))
}

function isRuntimeReplayReferenceIndexActionRefShape(value: unknown): value is RuntimeReplayReferenceIndexActionRef {
  return isRecord(value)
    && typeof value.index === "number"
    && typeof value.id === "string"
    && isRuntimeEpisodeTraceRefShape(value.actionRef)
    && isRuntimeEpisodeTraceRefShape(value.executionRef)
    && (value.observationRef === undefined || isRuntimeEpisodeTraceRefShape(value.observationRef))
}

function isRuntimeReplayReferenceIndexObservationRefShape(value: unknown): value is RuntimeReplayReferenceIndexObservationRef {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.type === "string"
    && isRuntimeEpisodeTraceRefShape(value.ref)
    && Array.isArray(value.artifactRefs)
    && value.artifactRefs.every(isRuntimeEpisodeTraceRefShape)
}

function isRuntimeEpisodeTraceRefShape(value: unknown): value is RuntimeEpisodeTraceRef {
  return isRecord(value)
    && typeof value.kind === "string"
    && typeof value.id === "string"
    && (value.digest === undefined || validDigest(value.digest))
    && (value.artifactId === undefined || typeof value.artifactId === "string")
    && (value.path === undefined || typeof value.path === "string")
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

  if (typeof evidence.runtimeReplayReferenceIndex === "string") {
    validateArtifactReference(evidence.runtimeReplayReferenceIndex, "files/review.json:evidence.runtimeReplayReferenceIndex", manifestFiles, violations)
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

    for (const [snapshotIndex, snapshot] of referenceManifest.snapshots.entries()) {
      for (const [refIndex, ref] of snapshot.artifactRefs.entries()) {
        if (typeof ref.path !== "string") {
          continue
        }
        validateArtifactReference(ref.path, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].path`, manifestFiles, violations)
        await verifyRuntimeEpisodeTraceRefFileDigest(directory, ref, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].digest`, violations)
      }
    }
  }
}

async function verifyRuntimeReplayReferenceIndexArtifacts(directory: string, manifest: ArtifactManifest, manifestFiles: Set<string>, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  for (const file of manifest.files) {
    if (file.kind !== "runtime-replay-index") {
      continue
    }

    let index: unknown
    try {
      index = JSON.parse(await readFile(join(directory, file.path), "utf8"))
    } catch (error) {
      violations.push({
        code: "malformed-reference",
        path: file.path,
        file: file.path,
        message: `Runtime replay reference index is not valid JSON: ${errorMessage(error)}`,
      })
      continue
    }

    if (!isRuntimeReplayReferenceIndexShape(index)) {
      violations.push({ code: "malformed-reference", path: file.path, file: file.path, message: "Runtime replay reference index does not match wp-codebox/runtime-replay-reference-index/v1." })
      continue
    }

    const expectedDigest = runtimeReplayReferenceIndexDigest(index)
    if (index.digest.value !== expectedDigest.value) {
      violations.push({ code: "digest-mismatch", path: `${file.path}:digest`, file: file.path, message: `Runtime replay reference index digest does not match declared refs: expected ${expectedDigest.value}, got ${index.digest.value}` })
    }

    const expectedId = `runtime-replay-reference-index-sha256-${index.digest.value}`
    if (index.id !== expectedId) {
      violations.push({ code: "bundle-id-mismatch", path: `${file.path}:id`, file: file.path, message: `Runtime replay reference index id must match its digest: expected ${expectedId}, got ${index.id}` })
    }

    if (index.artifactBundle.id !== manifest.id || index.artifactBundle.digest.value !== manifest.contentDigest.value) {
      violations.push({ code: "review-evidence-mismatch", path: `${file.path}:artifactBundle`, file: file.path, message: "Runtime replay reference index artifactBundle ref must match manifest id and contentDigest." })
    }

    for (const [key, referencedFile] of Object.entries(index.references)) {
      if (!referencedFile) {
        continue
      }
      validateArtifactReference(referencedFile.path, `${file.path}:references.${key}.path`, manifestFiles, violations)
      await verifyReferencedFileDigest(directory, referencedFile, `${file.path}:references.${key}.sha256`, violations)
    }

    for (const [observationIndex, observation] of index.observations.entries()) {
      for (const [refIndex, ref] of observation.artifactRefs.entries()) {
        if (typeof ref.path !== "string") {
          continue
        }
        validateArtifactReference(ref.path, `${file.path}:observations[${observationIndex}].artifactRefs[${refIndex}].path`, manifestFiles, violations)
        await verifyRuntimeEpisodeTraceRefFileDigest(directory, ref, `${file.path}:observations[${observationIndex}].artifactRefs[${refIndex}].digest`, violations)
      }
    }

    for (const [snapshotIndex, snapshot] of index.snapshots.entries()) {
      for (const [refIndex, ref] of snapshot.artifactRefs.entries()) {
        if (typeof ref.path !== "string") {
          continue
        }
        validateArtifactReference(ref.path, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].path`, manifestFiles, violations)
        await verifyRuntimeEpisodeTraceRefFileDigest(directory, ref, `${file.path}:snapshots[${snapshotIndex}].artifactRefs[${refIndex}].digest`, violations)
      }
    }
  }
}

async function verifyRuntimeEpisodeTraceRefFileDigest(directory: string, ref: RuntimeEpisodeTraceRef, path: string, violations: ArtifactBundleVerificationViolation[]): Promise<void> {
  if (!validDigest(ref.digest)) {
    violations.push({ code: "missing-file-hash", path, file: ref.path, message: `Runtime reference artifact ref must include a lowercase SHA-256 digest: ${ref.path ?? ref.id}` })
    return
  }

  if (typeof ref.path !== "string") {
    return
  }

  try {
    const value = createHash("sha256").update(await readFile(join(directory, ref.path))).digest("hex")
    if (value !== ref.digest.value) {
      violations.push({ code: "file-hash-mismatch", path, file: ref.path, message: `Runtime reference artifact ref hash does not match ${ref.path}: expected ${value}, got ${ref.digest.value}` })
    }
  } catch (error) {
    violations.push({ code: "file-hash-mismatch", path, file: ref.path, message: `Unable to hash runtime reference artifact ${ref.path}: ${errorMessage(error)}` })
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

function compactUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
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

export type RuntimeAction = RuntimeWpCliAction | RuntimeFilesystemAction | RuntimeBrowserAction

export interface RuntimeWpCliAction {
  type: "wp_cli"
  command: string
  timeout_ms?: number
}

export interface RuntimeFilesystemAction {
  type: "filesystem"
  operation: "list" | "read" | "write" | "delete"
  path: string
  content?: string
}

export interface RuntimeBrowserAction {
  type: "browser"
  operation: "navigate" | "click" | "fill" | "press" | "wait" | "capture"
  url?: string
  selector?: string
  text?: string
  value?: string
  key?: string
  wait_for?: string
  duration?: string
  capture?: string[]
  timeout_ms?: number
}

export interface RuntimeActionAdapterPolicy {
  mounts?: MountSpec[]
  writableRoots?: string[]
  filesystem?: RuntimePolicy["filesystem"]
  filesystemTraceCommand?: string | false
}

export interface RuntimeActionObservation {
  schema: typeof RUNTIME_ACTION_OBSERVATION_SCHEMA
  type: RuntimeAction["type"]
  status: "ok"
  action: RuntimeAction
  data: Record<string, unknown>
  observedAt: string
  step?: RuntimeEpisodeStepResult
  artifactRefs?: RuntimeEpisodeTraceRef[]
  digest: RuntimeEpisodeContentDigest
}

export class RuntimeActionPolicyError extends Error {
  readonly code = "runtime-action-policy-violation" as const

  constructor(message: string, readonly action: RuntimeAction) {
    super(message)
    this.name = "RuntimeActionPolicyError"
  }
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

export function buildRuntimeReplayReferenceIndex(input: BuildRuntimeReplayReferenceIndexInput): RuntimeReplayReferenceIndex {
  const filesByPath = new Map(input.files.map((file) => [file.path, runtimeReferenceManifestFileRef(file)]))
  const references = compactUndefined<RuntimeReplayReferenceIndex["references"]>({
    trace: input.trace ? runtimeReferenceManifestFileRef(input.trace) : filesByPath.get("files/runtime-episode-trace.json"),
    events: input.events ? runtimeReferenceManifestFileRef(input.events) : filesByPath.get("files/runtime-episode.jsonl"),
    runtimeReferenceManifest: input.runtimeReferenceManifest ? runtimeReferenceManifestFileRef(input.runtimeReferenceManifest) : filesByPath.get("files/runtime-reference-manifest.json"),
    observations: filesByPath.get("observations.jsonl"),
    commands: filesByPath.get("commands.jsonl"),
    runtimeEvents: filesByPath.get("events.jsonl"),
    blueprintAfter: filesByPath.get("blueprint.after.json"),
    blueprintAfterNotes: filesByPath.get("blueprint.after-notes.json"),
    mountedFiles: filesByPath.get("files/mounted-files.json"),
    mountDiffs: filesByPath.get("files/diffs.json"),
    changedFiles: filesByPath.get("files/changed-files.json"),
    patch: filesByPath.get("files/patch.diff"),
    testResults: filesByPath.get("files/test-results.json"),
  })
  const snapshots = (input.snapshots ?? []).map(runtimeReferenceManifestSnapshotRef)
  const index = {
    schema: RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA,
    version: 1 as const,
    id: "runtime-replay-reference-index-pending",
    createdAt: input.createdAt,
    digest: { algorithm: "sha256" as const, value: "0".repeat(64) },
    runtime: input.runtime,
    artifactBundle: input.artifactBundle,
    references,
    actions: runtimeReplayActionRefs(input.episodeTrace),
    observations: runtimeReplayObservationRefs(input.episodeTrace),
    snapshots,
    replay: runtimeReplayInstructions(references, snapshots),
  }
  const digest = runtimeReplayReferenceIndexDigest(index)

  return {
    ...index,
    id: `runtime-replay-reference-index-sha256-${digest.value}`,
    digest,
  }
}

export function runtimeReplayReferenceIndexDigest(index: RuntimeReplayReferenceIndex): RuntimeEpisodeContentDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256")
      .update("wp-codebox/runtime-replay-reference-index/v1\n")
      .update(stableJson(runtimeReplayReferenceIndexDigestPayload(index)))
      .digest("hex"),
  }
}

function runtimeReplayReferenceIndexDigestPayload(index: RuntimeReplayReferenceIndex): Record<string, unknown> {
  return {
    schema: index.schema,
    version: index.version,
    runtime: index.runtime,
    artifactBundle: index.artifactBundle,
    references: index.references,
    actions: index.actions,
    observations: index.observations,
    snapshots: index.snapshots,
    replay: index.replay,
  }
}

function runtimeReplayActionRefs(trace: RuntimeEpisodeTrace | undefined): RuntimeReplayReferenceIndexActionRef[] {
  return (trace?.steps ?? []).map((step) => compactUndefined({
    index: step.index,
    id: step.id,
    actionRef: step.actionRef,
    executionRef: step.executionRef,
    observationRef: step.observationRef,
  }))
}

function runtimeReplayObservationRefs(trace: RuntimeEpisodeTrace | undefined): RuntimeReplayReferenceIndexObservationRef[] {
  const observations = [
    ...(trace?.reset.observations ?? []),
    ...(trace?.steps.flatMap((step) => step.observation ? [step.observation] : []) ?? []),
  ]

  return observations.map((observation, index) => ({
    id: observation.id ?? `observation:${index}`,
    type: observation.type,
    ref: observationRef(observation, observation.id ?? `observation:${index}`),
    artifactRefs: [...(observation.artifactRefs ?? [])],
  }))
}

function runtimeReplayInstructions(
  references: RuntimeReplayReferenceIndex["references"],
  snapshots: RuntimeReferenceManifestSnapshotRef[],
): RuntimeReplayReferenceIndex["replay"] {
  const limitations = [...new Set(snapshots.flatMap((snapshot) => snapshot.replay.limitations))]
  if (snapshots.some((snapshot) => snapshot.replay.status === "runtime-state-artifact")) {
    return {
      status: "runtime-state-artifact",
      instructions: [
        "Use references.runtimeReferenceManifest for hashed runtime files and snapshot artifact refs.",
        "Use references.trace and references.events to replay recorded actions and lifecycle events.",
      ],
      limitations,
    }
  }

  return {
    status: snapshots.length > 0 ? "metadata-only" : "partial",
    instructions: [
      "Use references.trace for ordered runtime actions and execution records.",
      "Use references.observations plus observation artifact refs for captured runtime observations.",
      "Use references.blueprintAfter, references.mountedFiles, references.changedFiles, and references.patch for filesystem and mount-state evidence.",
      "Use references.runtimeReferenceManifest for snapshot metadata and replay limitations.",
    ],
    limitations: limitations.length > 0 ? limitations : [
      "This index points to replay evidence; it is not a complete WordPress database or filesystem checkpoint.",
    ],
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
  if (semantics === "replayable-runtime-state") {
    return { status: "replayable-runtime-state", limitations: [] }
  }

  if (semantics === "runtime-state-artifact") {
    return { status: "runtime-state-artifact", limitations: [] }
  }

  if (semantics === "partial-replay") {
    return {
      status: "partial-replay",
      limitations: [
        "Snapshot bundle contains replay instructions and artifact references, but not a complete WordPress database checkpoint.",
        "Replay consumers can restore mounted files and inspect runtime evidence; posts, options, terms, users, uploads, active theme/plugins, and browser/editor state may require external capture.",
      ],
    }
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

export async function runRuntimeAction(
  episode: RuntimeEpisode,
  action: RuntimeAction,
  policy: RuntimeActionAdapterPolicy = {},
): Promise<RuntimeActionObservation> {
  if (action.type === "wp_cli") {
    return runRuntimeWpCliAction(episode, action)
  }

  if (action.type === "browser") {
    return runRuntimeBrowserAction(episode, action)
  }

  return runRuntimeFilesystemAction(episode, action, policy)
}

async function runRuntimeWpCliAction(episode: RuntimeEpisode, action: RuntimeWpCliAction): Promise<RuntimeActionObservation> {
  const step = await episode.step(
    {
      kind: "command",
      command: "wordpress.wp-cli",
      args: [`command=${normalizeWpCliRuntimeActionCommand(action.command)}`],
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
    },
    { type: "command-result" },
  )

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      command: action.command,
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout: step.execution.stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

async function runRuntimeFilesystemAction(
  episode: RuntimeEpisode,
  action: RuntimeFilesystemAction,
  policy: RuntimeActionAdapterPolicy,
): Promise<RuntimeActionObservation> {
  const mountedPath = await resolveRuntimeActionMountedPath(action, policy)
  const data = await executeRuntimeFilesystemAction(action, mountedPath)
  const traceCommand = policy.filesystemTraceCommand ?? "inspect-mounted-inputs"
  const step = traceCommand
    ? await episode.step(
        {
          kind: "filesystem",
          command: traceCommand,
          path: mountedPath.sandboxPath,
          operation: action.operation,
          description: `filesystem.${action.operation}`,
          metadata: {
            mountTarget: mountedPath.mount.target,
            mountMode: mountedPath.mount.mode,
          },
        },
        { type: "mounts" },
      )
    : undefined

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      operation: action.operation,
      path: mountedPath.sandboxPath,
      mountTarget: mountedPath.mount.target,
      mountMode: mountedPath.mount.mode,
      ...data,
    },
    artifactRefs: step?.observation?.artifactRefs,
  })
}

async function runRuntimeBrowserAction(episode: RuntimeEpisode, action: RuntimeBrowserAction): Promise<RuntimeActionObservation> {
  const args = [`actions-json=${JSON.stringify([runtimeBrowserCommandAction(action)])}`]
  if (action.url && action.operation !== "navigate") {
    args.unshift(`url=${action.url}`)
  }
  if (action.capture && action.capture.length > 0) {
    args.push(`capture=${action.capture.join(",")}`)
  }

  const step = await episode.step(
    {
      kind: "browser",
      command: "wordpress.browser-actions",
      args,
      ...(action.timeout_ms !== undefined ? { timeoutMs: action.timeout_ms } : {}),
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.url ? { url: action.url } : {}),
      operation: action.operation,
    },
    { type: "browser-result" },
  )

  let stdout: unknown = step.execution.stdout
  try {
    stdout = JSON.parse(step.execution.stdout)
  } catch {
    // Keep raw stdout when a backend returns non-JSON diagnostics.
  }

  return runtimeActionObservation({
    type: action.type,
    action,
    step,
    data: {
      operation: action.operation,
      mappedCommand: step.execution.command,
      args: step.execution.args,
      exitCode: step.execution.exitCode,
      stdout,
      stderr: step.execution.stderr,
      executionId: step.execution.id,
      stepId: step.id,
    },
    artifactRefs: step.observation?.artifactRefs,
  })
}

function runtimeBrowserCommandAction(action: RuntimeBrowserAction): Record<string, unknown> {
  const commandAction: Record<string, unknown> = { type: action.operation }
  for (const key of ["url", "selector", "text", "value", "key", "duration"] as const) {
    if (typeof action[key] === "string") {
      commandAction[key] = action[key]
    }
  }
  if (typeof action.wait_for === "string") {
    commandAction.waitFor = action.wait_for
  }
  if (action.operation === "capture" && Array.isArray(action.capture)) {
    commandAction.capture = action.capture
  }
  return commandAction
}

function normalizeWpCliRuntimeActionCommand(command: string): string {
  const trimmed = command.trim()
  return trimmed.startsWith("wp ") ? trimmed.slice(3).trimStart() : trimmed
}

interface RuntimeActionMountedPath {
  mount: MountSpec
  sandboxPath: string
  hostPath: string
}

async function resolveRuntimeActionMountedPath(
  action: RuntimeFilesystemAction,
  policy: RuntimeActionAdapterPolicy,
): Promise<RuntimeActionMountedPath> {
  if (!action.path || action.path.includes("\0")) {
    throw new RuntimeActionPolicyError("Filesystem action path must be a non-empty path without null bytes", action)
  }

  const mounts = policy.mounts ?? []
  const sandboxPath = normalizeSandboxRuntimeActionPath(action.path)
  const mount = mounts.find((candidate) => isRuntimeActionPathWithinRoot(sandboxPath, candidate.target))
  if (!mount) {
    throw new RuntimeActionPolicyError(`Filesystem action path is outside mounted workspace roots: ${action.path}`, action)
  }

  const hostPath = resolve(mount.source, relative(normalizeSandboxRuntimeActionPath(mount.target), sandboxPath))
  await assertRuntimeActionHostPathWithinMount(action, hostPath, mount.source)

  if (action.operation === "write" || action.operation === "delete") {
    assertRuntimeFilesystemWritable(action, sandboxPath, mount, policy)
  }

  return { mount, sandboxPath, hostPath }
}

function normalizeSandboxRuntimeActionPath(path: string): string {
  const absolutePath = path.startsWith("/") ? path : join(SANDBOX_WORKSPACE_ROOT, path)
  const normalized = normalize(absolutePath)
  if (!normalized.startsWith("/")) {
    return `/${normalized}`
  }

  return normalized
}

function isRuntimeActionPathWithinRoot(path: string, root: string): boolean {
  const normalizedRoot = normalizeSandboxRuntimeActionPath(root)
  const relativePath = relative(normalizedRoot, normalizeSandboxRuntimeActionPath(path))
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

async function assertRuntimeActionHostPathWithinMount(action: RuntimeFilesystemAction, hostPath: string, source: string): Promise<void> {
  const root = await realpath(source)
  const existingPath = action.operation === "write" ? dirname(hostPath) : hostPath
  let real
  try {
    real = await realpath(existingPath)
  } catch (error) {
    if (action.operation !== "write") {
      throw error
    }
    real = await nearestExistingRuntimeActionParent(existingPath, root)
  }
  const relativePath = relative(root, real)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new RuntimeActionPolicyError(`Filesystem action path resolves outside mounted workspace root: ${action.path}`, action)
  }
}

async function nearestExistingRuntimeActionParent(path: string, root: string): Promise<string> {
  let current = path
  while (current !== dirname(current)) {
    try {
      return await realpath(current)
    } catch {
      current = dirname(current)
      if (!current.startsWith(root)) {
        return root
      }
    }
  }

  return root
}

function assertRuntimeFilesystemWritable(
  action: RuntimeFilesystemAction,
  sandboxPath: string,
  mount: MountSpec,
  policy: RuntimeActionAdapterPolicy,
): void {
  if (policy.filesystem && policy.filesystem !== "readwrite-mounts") {
    throw new RuntimeActionPolicyError(`Filesystem action requires readwrite-mounts policy: ${action.operation}`, action)
  }
  if (mount.mode !== "readwrite") {
    throw new RuntimeActionPolicyError(`Filesystem action requires a readwrite mount: ${mount.target}`, action)
  }

  const writableRoots = policy.writableRoots ?? [mount.target]
  if (!writableRoots.some((root) => isRuntimeActionPathWithinRoot(sandboxPath, root))) {
    throw new RuntimeActionPolicyError(`Filesystem action path is outside writable roots: ${action.path}`, action)
  }
}

async function executeRuntimeFilesystemAction(
  action: RuntimeFilesystemAction,
  mountedPath: RuntimeActionMountedPath,
): Promise<Record<string, unknown>> {
  if (action.operation === "list") {
    const entries = await readdir(mountedPath.hostPath, { withFileTypes: true })
    return {
      entries: entries
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  if (action.operation === "read") {
    const content = await readFile(mountedPath.hostPath, "utf8")
    return { content, bytes: Buffer.byteLength(content, "utf8") }
  }

  if (action.operation === "write") {
    await mkdir(dirname(mountedPath.hostPath), { recursive: true })
    await writeFile(mountedPath.hostPath, action.content ?? "")
    return { bytes: Buffer.byteLength(action.content ?? "", "utf8") }
  }

  await rm(mountedPath.hostPath, { recursive: true, force: true })
  return { deleted: true }
}

function runtimeActionObservation(input: {
  type: RuntimeAction["type"]
  action: RuntimeAction
  data: Record<string, unknown>
  step?: RuntimeEpisodeStepResult
  artifactRefs?: RuntimeEpisodeTraceRef[]
}): RuntimeActionObservation {
  const observedAt = new Date().toISOString()
  const observation = {
    schema: RUNTIME_ACTION_OBSERVATION_SCHEMA,
    type: input.type,
    status: "ok" as const,
    action: input.action,
    data: input.data,
    observedAt,
    ...(input.step ? { step: input.step } : {}),
    ...(input.artifactRefs && input.artifactRefs.length > 0 ? { artifactRefs: input.artifactRefs } : {}),
  }

  return {
    ...observation,
    digest: runtimeEpisodeDigest(observation),
  }
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
      runtimeReplayReferenceIndexPath: join(artifacts.directory, "files/runtime-replay-index.json"),
    }
    if (spec.includeRuntimeSnapshotBundles) {
      await this.persistRuntimeSnapshotBundles()
    }
    await this.persistRuntimeEpisodeTraceArtifacts()
    return this.artifacts
  }

  private async persistRuntimeSnapshotBundles(): Promise<void> {
    if (!this.artifacts || this.snapshots.length === 0) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const snapshotDirectory = join(this.artifacts.directory, "files/runtime-snapshots")
    await mkdir(snapshotDirectory, { recursive: true })
    const baseRefs = manifest.files
      .filter((file) => !["manifest.json", "metadata.json", "files/review.json", "files/runtime-reference-manifest.json", "files/runtime-replay-index.json"].includes(file.path))
      .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 }))

    for (const [index, snapshot] of this.snapshots.entries()) {
      const semantics = snapshot.semantics === "replayable-runtime-state" || snapshot.semantics === "runtime-state-artifact"
        ? snapshot.semantics
        : "partial-replay"
      const replay = runtimeSnapshotReplaySemantics(semantics)
      const relativePath = `files/runtime-snapshots/${snapshot.id}.json`
      const bundleId = `${snapshot.id}:runtime-snapshot-bundle`
      const bundle = {
        schema: "wp-codebox/runtime-snapshot-bundle/v1",
        version: 1,
        id: bundleId,
        snapshot: {
          id: snapshot.id,
          createdAt: snapshot.createdAt,
          originalSemantics: snapshot.semantics ?? "metadata-only",
          semantics,
          metadata: snapshot.metadata,
        },
        replay: {
          status: replay.status,
          limitations: replay.limitations,
          instructions: [
            "Verify every referenced artifact SHA-256 before replay.",
            "Use blueprint.after.json and blueprint.after-notes.json as generated Playground replay guidance when present.",
            "Restore mounted file artifacts from files/mounted-files.json where replayable file contents are available.",
            "Use files/runtime-episode-trace.json and files/runtime-episode.jsonl to inspect actions, observations, and snapshot refs after the episode trace is persisted.",
          ],
        },
        refs: baseRefs,
      }
      await writeFile(join(this.artifacts.directory, relativePath), `${JSON.stringify(bundle, null, 2)}\n`)
      const digest = { algorithm: "sha256" as const, value: createHash("sha256").update(await readFile(join(this.artifacts.directory, relativePath))).digest("hex") }
      const artifactRef: RuntimeEpisodeTraceRef = {
        kind: "runtime-snapshot-bundle",
        id: bundleId,
        path: relativePath,
        digest,
      }
      this.snapshots[index] = snapshotWithSemantics({
        ...snapshot,
        semantics,
        artifactRefs: [
          ...(snapshot.artifactRefs ?? []).filter((ref) => ref.path !== relativePath),
          artifactRef,
        ],
      })
      upsertManifestFile(manifest, artifactManifestFile(relativePath, "runtime-snapshot-bundle", "application/json"))
    }

    await refreshArtifactManifestFileHashes(this.artifacts.directory, manifest)
    await writeFile(this.artifacts.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async persistRuntimeEpisodeTraceArtifacts(): Promise<void> {
    if (!this.artifacts?.runtimeEpisodeTracePath || !this.artifacts.runtimeEpisodeEventsPath || !this.artifacts.runtimeReferenceManifestPath || !this.artifacts.runtimeReplayReferenceIndexPath) {
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
    await this.updateRuntimeReplayReferenceIndexForRuntimeEpisodeTrace(trace, traceRelativePath, eventsRelativePath)
  }

  private async updateRuntimeReferenceManifestForRuntimeEpisodeTrace(traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts?.runtimeReferenceManifestPath) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const fileRefs = manifest.files
      .filter((file) => !["manifest.json", "metadata.json", "files/review.json", "files/runtime-reference-manifest.json", "files/runtime-replay-index.json"].includes(file.path))
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

  private async updateRuntimeReplayReferenceIndexForRuntimeEpisodeTrace(trace: RuntimeEpisodeTrace, traceRelativePath: string, eventsRelativePath: string): Promise<void> {
    if (!this.artifacts?.runtimeReplayReferenceIndexPath) {
      return
    }

    const manifest = JSON.parse(await readFile(this.artifacts.manifestPath, "utf8")) as ArtifactManifest
    const fileRefs = manifest.files
      .filter((file) => file.path !== "manifest.json")
      .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 }))
    const traceRef = fileRefs.find((file) => file.path === traceRelativePath)
    const eventsRef = fileRefs.find((file) => file.path === eventsRelativePath)
    const runtimeReferenceManifestRef = fileRefs.find((file) => file.path === "files/runtime-reference-manifest.json")
    const replayIndex = buildRuntimeReplayReferenceIndex({
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
      ...(runtimeReferenceManifestRef ? { runtimeReferenceManifest: runtimeReferenceManifestRef } : {}),
      snapshots: this.snapshots,
      episodeTrace: trace,
    })
    await writeFile(this.artifacts.runtimeReplayReferenceIndexPath, `${JSON.stringify(replayIndex, null, 2)}\n`)
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
    upsertManifestFile(manifest, artifactManifestFile("files/runtime-replay-index.json", "runtime-replay-index", "application/json"))
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
      runtimeReplayReferenceIndex: "files/runtime-replay-index.json",
    }
    await writeFile(this.artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  }

  private async updateArtifactReviewForRuntimeEpisodeTrace(traceRelativePath: string): Promise<void> {
    if (!this.artifacts) {
      return
    }

    const review = JSON.parse(await readFile(this.artifacts.reviewPath, "utf8")) as ArtifactReview
    review.evidence.runtimeEpisodeTrace = traceRelativePath
    review.evidence.runtimeReplayReferenceIndex = "files/runtime-replay-index.json"
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
