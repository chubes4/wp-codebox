#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { createRuntime, validateRuntimePolicy, type ArtifactBundle, type ExecutionResult, type Runtime, type RuntimeInfo, type RuntimePolicy, type WorkspaceRecipe, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeWorkspace } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"
import { agentRuntimeProbeCode, agentSandboxRunCode, resolveSandboxTaskCode } from "./agent-code.js"
import { captureStdout, printBatchHumanOutput, printCommandCatalogHumanOutput, printHelp, printHumanOutput, printRecipeHumanOutput, printRecipeSchemaHumanOutput, printRecipeValidateHumanOutput, serializeError } from "./output.js"

interface CommandMetadata {
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
}

interface CommandCatalogOutput {
  schema: "wp-codebox/command-catalog/v1"
  commands: CommandMetadata[]
}

interface RecipeSchemaOutput {
  schema: "wp-codebox/json-schema/v1"
  id: "wp-codebox/workspace-recipe/v1"
  jsonSchema: Record<string, unknown>
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

interface RecipeRunOptions {
  recipePath: string
  artifactsDirectory?: string
  previewHoldSeconds?: number
  previewPublicUrl?: string
  previewPort?: number
  json: boolean
  dryRun: boolean
}

interface RecipeValidateOptions {
  recipePath: string
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
  }
  error?: RunOutput["error"]
}

interface RecipeRunOutput {
  success: boolean
  schema: "wp-codebox/recipe-run/v1"
  recipePath?: string
  runtime?: RuntimeInfo
  executions: ExecutionResult[]
  validation?: {
    issues: RecipeValidationIssue[]
  }
  benchResults?: BenchResults
  benchResultsList?: BenchResults[]
  artifacts?: ArtifactBundle
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
  secretEnv: Array<{ name: string; available: boolean }>
  policy: RuntimePolicy & {
    valid: boolean
    issues: ReturnType<typeof validateRuntimePolicy>["issues"]
  }
  workflow: {
    steps: RecipeDryRunStep[]
  }
}

interface RecipeDryRunMount {
  type: "directory"
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
  provenance: RecipeSourceProvenance
}

interface RecipeDryRunStep {
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
  cleanupPaths: string[]
  provenance: RecipeSourceProvenance
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
const execFileAsync = promisify(execFile)
const commandCatalog: CommandMetadata[] = [
  {
    id: "inspect-mounted-inputs",
    description: "List mounted input entries visible inside the Playground runtime.",
    acceptedArgs: [],
    outputShape: "JSON array of mounted input descriptors.",
    policyRequirement: "Runtime policy commands must include inspect-mounted-inputs.",
    recipe: true,
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
  },
  {
    id: "wordpress.bench",
    description: "Run plugin benchmark workloads and emit a Homeboy-compatible BenchResults envelope.",
    acceptedArgs: [
      { name: "component-id", description: "Component id for the BenchResults envelope.", format: "string" },
      { name: "plugin-slug", description: "Plugin slug containing tests/bench workloads.", required: true, format: "slug" },
      { name: "iterations", description: "Measured iterations per workload.", format: "positive integer" },
      { name: "warmup", description: "Warmup iterations before measurement.", format: "non-negative integer" },
      { name: "dependency-slugs", description: "Comma-separated plugin dependency slugs to load.", format: "comma-separated slugs" },
      { name: "env-json", description: "Benchmark environment object.", format: "JSON object" },
      { name: "workloads-json", description: "Explicit workload list.", format: "JSON array" },
    ],
    outputShape: "BenchResults JSON envelope with component_id, iterations, and scenarios.",
    policyRequirement: "Runtime policy commands must include wordpress.bench.",
    recipe: true,
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
  },
  {
    id: "wordpress.browser-probe",
    description: "Open the live Playground preview in Playwright and capture browser console, page errors, and screenshot artifacts.",
    acceptedArgs: [
      { name: "url", description: "Preview path or absolute URL to visit.", required: true, format: "path or URL" },
      { name: "wait-for", description: "Navigation wait condition.", format: "domcontentloaded|load|networkidle|selector:<selector>|duration" },
      { name: "duration", description: "Extra capture duration, or wait time when wait-for=duration.", format: "duration, e.g. 2s or 500ms" },
      { name: "capture", description: "Comma-separated artifacts to capture.", format: "console,errors,screenshot" },
    ],
    outputShape: "JSON summary plus files/browser/console.jsonl, errors.jsonl, summary.json, and screenshot.png when captured.",
    policyRequirement: "Runtime policy commands must include wordpress.browser-probe.",
    recipe: true,
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
      { name: "provider-plugin-slugs", description: "Comma-separated provider plugin slugs already mounted by recipe inputs.", format: "comma-separated slugs" },
      { name: "code", description: "Inline PHP runner override for operator/debug use.", format: "PHP string" },
      { name: "code-file", description: "Path to PHP runner override for operator/debug use.", format: "path" },
    ],
    outputShape: "JSON agent run result emitted by the sandbox PHP runner.",
    policyRequirement: "Recipe policy maps this helper to wordpress.run-php.",
    recipe: true,
  },
]
const supportedRecipeCommands = new Set(commandCatalog.filter((command) => command.recipe).map((command) => command.id))
const workspaceRecipeJsonSchema: RecipeSchemaOutput["jsonSchema"] = {
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
        inherit: { $ref: "#/$defs/inheritanceRequest" },
        inheritance: { $ref: "#/$defs/inheritanceResolution" },
      },
    },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/step" },
        },
      },
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      properties: {
        directory: { type: "string" },
      },
    },
  },
  $defs: {
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
      },
    },
    step: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { enum: commandCatalog.filter((command) => command.recipe).map((command) => command.id) },
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

const secretEnvPolicy: RuntimePolicy = {
  ...defaultPolicy,
  secrets: "connector-scoped",
}

async function main(args: string[]): Promise<number> {
  const command = args.shift()

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return command ? 0 : 1
  }

  if (command === "recipe-run") {
    const options = parseRecipeRunOptions(args)
    const execute = (): Promise<RecipeRunCommandOutput> => options.dryRun ? dryRunRecipe(options) : runRecipe(options)

    if (!options.json) {
      const output = await execute()
      printRecipeHumanOutput(output)
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const output = logs.length > 0 ? { ...result, logs } : result
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    printJsonFailureDiagnostic(output)
    return output.success ? 0 : 1
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

function commandCatalogOutput(): CommandCatalogOutput {
  return {
    schema: "wp-codebox/command-catalog/v1",
    commands: commandCatalog,
  }
}

function recipeSchemaOutput(): RecipeSchemaOutput {
  return {
    schema: "wp-codebox/json-schema/v1",
    id: "wp-codebox/workspace-recipe/v1",
    jsonSchema: workspaceRecipeJsonSchema,
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
      steps: await recipeDryRunSteps(recipe, recipeDirectory, policy),
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

async function runRecipe(options: RecipeRunOptions): Promise<RecipeRunOutput> {
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
  let workspaceMounts: PreparedWorkspaceMount[] = []
  let extraPlugins: PreparedExtraPlugin[] = []
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  const executions: ExecutionResult[] = []
  let artifacts: ArtifactBundle | undefined

  try {
    workspaceMounts = await prepareRecipeWorkspaces(recipe, recipeDirectory)
    extraPlugins = await prepareRecipeExtraPlugins(recipe, recipeDirectory)

    runtime = await createRuntime(
      {
        backend: recipe.runtime?.backend ?? "wordpress-playground",
        environment: {
          kind: "wordpress",
          name: recipe.runtime?.name ?? "wp-codebox-recipe",
          version: recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION,
          blueprint: recipe.runtime?.blueprint ?? { steps: [] },
        },
        policy: Object.keys(secretEnv).length > 0 ? { ...policy, secrets: "connector-scoped" } : policy,
        secretEnv,
        artifactsDirectory: options.artifactsDirectory ?? recipe.artifacts?.directory,
        metadata: {
          ...runtimeMetadata(options.artifactsDirectory ?? recipe.artifacts?.directory, recipe.runtime?.wp ?? DEFAULT_WORDPRESS_VERSION),
          ...recipeRunMetadata(recipe, recipePath, workspaceMounts, extraPlugins, options.previewPublicUrl, options.previewPort),
        },
        preview: previewSpec(options.previewPublicUrl, options.previewPort),
      },
      createPlaygroundRuntimeBackend(),
    )

    for (const workspace of workspaceMounts) {
      await runtime.mount({
        type: "directory",
        source: workspace.source,
        target: workspace.target,
        mode: workspace.mode,
        metadata: workspace.metadata,
      })
    }

    for (const plugin of extraPlugins) {
      await runtime.mount({
        type: "directory",
        source: plugin.source,
        target: plugin.target,
        mode: "readonly",
        metadata: {
          kind: "extra-plugin",
          slug: plugin.slug,
          source: plugin.provenance,
        },
      })
    }

    for (const mount of recipe.inputs?.mounts ?? []) {
      await runtime.mount({
        type: "directory",
        source: resolve(recipeDirectory, mount.source),
        target: mount.target,
        mode: mount.mode ?? "readwrite",
        metadata: mount.metadata,
      })
    }

    const pluginActivationCode = activateExtraPluginsCode(recipe)
    if (pluginActivationCode) {
      executions.push(await runtime.execute({ command: "wordpress.run-php", args: [`code=${pluginActivationCode}`] }))
    }

    for (const step of recipe.workflow.steps) {
      executions.push(await runtime.execute(await recipeExecutionSpec(step, recipeDirectory)))
    }

    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true, previewHoldSeconds: options.previewHoldSeconds })
    const runtimeInfo = options.previewHoldSeconds ? await runtime.info() : undefined
    await releaseRuntime(runtime, options.previewHoldSeconds, () => cleanupRecipePreparedSources(workspaceMounts, extraPlugins))

    const benchResultsList = executions
      .filter((execution) => execution.command === "wordpress.bench" && execution.exitCode === 0)
      .map((execution) => parseBenchResults(execution.stdout))

    return {
      success: true,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      runtime: runtimeInfo ?? await runtime.info(),
      executions,
      ...(benchResultsList.length === 1 ? { benchResults: benchResultsList[0] } : {}),
      ...(benchResultsList.length > 0 ? { benchResultsList } : {}),
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

    await cleanupRecipePreparedSources(workspaceMounts, extraPlugins)

    return {
      success: false,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      ...(runtime ? { runtime: await runtime.info() } : {}),
      executions,
      ...(artifacts ? { artifacts } : {}),
      error: serializeError(error),
    }
  }
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
        steps: recipe.workflow.steps.length,
        mounts: recipe.inputs?.mounts?.length ?? 0,
        workspaces: recipe.inputs?.workspaces?.length ?? 0,
        extraPlugins: recipeExtraPlugins(recipe).length,
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
    }))

    return {
      command: "wordpress.run-php",
      args: [`code=${agentSandboxRunCode(task, body, providerPluginSlugs(args).map((slug) => ({ source: "", slug })))}`],
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

function previewSpec(publicUrl: string | undefined, port: number | undefined): { publicUrl?: string; siteUrl?: string; port?: number } | undefined {
  if (!publicUrl && port === undefined) {
    return undefined
  }

  return stripUndefined({
    publicUrl,
    siteUrl: publicUrl,
    port,
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
  const options = parseAgentRuntimeProbeOptions(args, ["--task", "--agent", "--mode", "--provider", "--model", "--session-id", "--max-turns", "--code", "--code-file", "--secret-env", "--mount"]) as Partial<AgentSandboxRunOptions>

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
        preview: previewSpec(options.previewPublicUrl, options.previewPort),
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

async function releaseRuntime(runtime: Runtime, previewHoldSeconds = 0, afterDestroy?: () => Promise<void>): Promise<void> {
  const holdSeconds = Math.max(0, Math.floor(previewHoldSeconds))
  if (holdSeconds === 0) {
    await runtime.destroy()
    await afterDestroy?.()
    return
  }

  await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000))
  await runtime.destroy()
  await afterDestroy?.()
}

function parsePreviewHoldSeconds(value: string): number {
  const match = value.trim().match(/^(\d+)(s|m)?$/)
  if (!match) {
    throw new Error(`Invalid --preview-hold value: ${value}`)
  }

  const amount = Number.parseInt(match[1], 10)
  const seconds = match[2] === "m" ? amount * 60 : amount
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
    throw new Error("--preview-hold must be between 0s and 3600s")
  }

  return seconds
}

function parsePreviewPort(value: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid --preview-port value: ${value}`)
  }

  const port = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--preview-port must be an integer between 1 and 65535")
  }

  return port
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
      default:
        throw new Error(`Unknown option: ${name}`)
    }
  }

  if (!options.recipePath) {
    throw new Error("Missing required option: --recipe")
  }

  return options as RecipeRunOptions
}

function parsePreviewPublicUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid --preview-public-url value: ${value}`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--preview-public-url must be an http or https URL")
  }

  if (!url.hostname) {
    throw new Error("--preview-public-url must include a hostname")
  }

  return url.toString()
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

function parseWorkspaceRecipe(raw: string, recipePath: string): WorkspaceRecipe {
  const recipe = JSON.parse(raw) as WorkspaceRecipe

  if (recipe.schema !== "wp-codebox/workspace-recipe/v1") {
    throw new Error(`Unsupported recipe schema in ${recipePath}`)
  }

  if (!recipe.workflow || !Array.isArray(recipe.workflow.steps) || recipe.workflow.steps.length === 0) {
    throw new Error(`Recipe must include at least one workflow step: ${recipePath}`)
  }

  for (const step of recipe.workflow.steps) {
    if (!step || typeof step.command !== "string" || step.command === "") {
      throw new Error(`Recipe workflow steps must include a command: ${recipePath}`)
    }

    if (step.args && !Array.isArray(step.args)) {
      throw new Error(`Recipe workflow step args must be arrays: ${recipePath}`)
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

  for (const [index, step] of recipe.workflow.steps.entries()) {
    const path = `$.workflow.steps[${index}]`
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
      if (!workspace.target) {
        addIssue("missing-target", `${path}.target`, "Directory workspace seeds require an explicit sandbox target.")
      }
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
      source = recipeSource(plugin.source)
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
    const pluginFile = recipeExtraPluginFile(plugin)

    validateRecipeSource(source, `${path}.source`, addIssue)
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

  for (const [index, name] of (recipe.inputs?.secretEnv ?? []).entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-secret-env", `$.inputs.secretEnv[${index}]`, `Secret environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
    }
  }

  return issues
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
        if (!["console", "errors", "screenshot"].includes(item)) {
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

function validateAbsoluteSandboxPath(path: string, issuePath: string, addIssue: (code: string, path: string, message: string) => void): void {
  if (!path.startsWith("/")) {
    addIssue("invalid-sandbox-path", issuePath, `Sandbox paths must be absolute: ${path}`)
  }
}

function validateRecipeSource(source: ReturnType<typeof recipeSource>, issuePath: string, addIssue: (code: string, path: string, message: string) => void): void {
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
}

function recipeStepArgValue(args: string[], key: string): string | undefined {
  const prefix = `${key}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function recipeWpCliCommandFromArgs(args: string[]): string {
  return recipeStepArgValue(args, "command")?.trim() ?? args.join(" ").trim()
}

async function recipeDryRunSteps(recipe: WorkspaceRecipe, recipeDirectory: string, policy: RuntimePolicy): Promise<RecipeDryRunStep[]> {
  const steps: Array<Promise<RecipeDryRunStep>> = []
  const pluginActivationCode = activateExtraPluginsCode(recipe)
  if (pluginActivationCode) {
    steps.push(recipeDryRunStep({ command: "wordpress.run-php", args: [`code=${pluginActivationCode}`] }, recipeDirectory, policy, -1, "activate-extra-plugins"))
  }

  for (const [index, step] of recipe.workflow.steps.entries()) {
    steps.push(recipeDryRunStep(step, recipeDirectory, policy, index))
  }

  return Promise.all(steps)
}

async function recipeDryRunStep(step: WorkspaceRecipe["workflow"]["steps"][number], recipeDirectory: string, policy: RuntimePolicy, index: number, label?: string): Promise<RecipeDryRunStep> {
  const resolved = await recipeExecutionSpec(step, recipeDirectory)
  const allowed = policy.commands.includes(resolved.command)
  return {
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
  const commands = recipe.workflow.steps.map((step) => step.command.startsWith("wp-codebox.agent-") ? "wordpress.run-php" : step.command)
  if (recipeExtraPlugins(recipe).some((plugin) => plugin.activate !== false)) {
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

function recipeRunMetadata(recipe: WorkspaceRecipe, recipePath: string, workspaceMounts: PreparedWorkspaceMount[], extraPlugins: PreparedExtraPlugin[], previewPublicUrl: string | undefined, previewPort: number | undefined): Record<string, unknown> {
  const extraPluginMetadata = extraPlugins.map((plugin) => ({
    source: plugin.source,
    slug: plugin.slug,
    pluginFile: plugin.pluginFile,
    activate: plugin.activate,
    provenance: plugin.provenance,
  }))

  return {
    recipe: {
      path: recipePath,
      schema: recipe.schema,
      runtime: recipe.runtime ?? {},
      artifacts: recipe.artifacts ?? {},
      workflow: {
        steps: recipe.workflow.steps.map((step) => ({ command: step.command, args: step.args ?? [] })),
      },
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: extraPluginMetadata,
        secretEnv: recipe.inputs?.secretEnv ?? [],
        inherit: recipe.inputs?.inherit ?? {},
        inheritance: recipe.inputs?.inheritance ?? {},
      },
    },
    task: {
      kind: "recipe-run",
      recipePath,
      previewPublicUrl,
      previewPort,
      workflow: {
        steps: recipe.workflow.steps.map((step) => ({ command: step.command, args: step.args ?? [] })),
      },
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: extraPluginMetadata,
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
  }
}

function recipeDryRunWorkspaces(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunWorkspace[] {
  return (recipe.inputs?.workspaces ?? []).map((workspace, index) => {
    const slug = workspace.seed.slug ?? basename(resolve(recipeDirectory, workspace.seed.source ?? `workspace-${index}`))
    const target = workspace.target ?? defaultWorkspaceTarget(workspace, slug)
    const generated = workspace.seed.type !== "directory"
    const metadata = {
      kind: "recipe-workspace",
      index,
      seed: workspace.seed,
      target,
      dryRun: true,
    }

    return {
      index,
      ...(generated ? {} : { source: resolve(recipeDirectory, workspace.seed.source ?? "") }),
      target,
      mode: workspace.mode ?? "readwrite",
      seed: workspace.seed,
      generated,
      metadata,
    }
  })
}

function recipeDryRunExtraPlugins(recipe: WorkspaceRecipe, recipeDirectory: string): RecipeDryRunExtraPlugin[] {
  return recipeExtraPlugins(recipe).map((plugin) => {
    const slug = recipeExtraPluginSlug(plugin)
    const source = recipeSource(plugin.source)
    const provenance = recipeSourceProvenance(source, recipeDirectory)
    return {
      source: source.type === "local" ? resolve(recipeDirectory, plugin.source) : source.resolvedUrl,
      sourceRef: plugin.source,
      sourceType: source.type,
      slug,
      target: `/wordpress/wp-content/plugins/${slug}`,
      pluginFile: recipeExtraPluginFile(plugin),
      activate: plugin.activate !== false,
      provenance,
    }
  })
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
      },
    })
  }

  return mounts
}

async function cleanupRecipeWorkspaces(workspaces: PreparedWorkspaceMount[]): Promise<void> {
  await Promise.all(workspaces.flatMap((workspace) => workspace.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })))
}

async function cleanupRecipePreparedSources(workspaces: PreparedWorkspaceMount[], extraPlugins: PreparedExtraPlugin[]): Promise<void> {
  await Promise.all([
    cleanupRecipeWorkspaces(workspaces),
    ...extraPlugins.flatMap((plugin) => plugin.cleanupPaths).map((path) => rm(path, { recursive: true, force: true })),
  ])
}

async function prepareRecipeExtraPlugins(recipe: WorkspaceRecipe, recipeDirectory: string): Promise<PreparedExtraPlugin[]> {
  const plugins: PreparedExtraPlugin[] = []
  for (const plugin of recipeExtraPlugins(recipe)) {
    const slug = recipeExtraPluginSlug(plugin)
    const resolved = await prepareRecipeSource(plugin.source, recipeDirectory, slug)
    const pluginFile = recipeExtraPluginFile(plugin)
    await assertPreparedPluginFileExists(resolved.source, pluginFile.slice(slug.length + 1), plugin.source)
    plugins.push({
      source: resolved.source,
      slug,
      target: `/wordpress/wp-content/plugins/${slug}`,
      pluginFile,
      activate: plugin.activate !== false,
      cleanupPaths: resolved.cleanupPaths,
      provenance: resolved.provenance,
    })
  }

  return plugins
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

async function prepareRecipeSource(sourceRef: string, recipeDirectory: string, slug: string): Promise<PreparedExternalSource> {
  const source = recipeSource(sourceRef)
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

  const directory = await mkdtemp(join(tmpdir(), `wp-codebox-source-${slug}-`))
  const zipPath = join(directory, "source.zip")
  const extractDirectory = join(directory, "extracted")
  await mkdir(extractDirectory, { recursive: true })
  const digest = await downloadRecipeSourceZip(source.resolvedUrl, zipPath)
  await execFileAsync("unzip", ["-q", zipPath, "-d", extractDirectory])

  return {
    source: await extractedPluginSourceDirectory(extractDirectory, slug),
    cleanupPaths: [directory],
    provenance: {
      ...recipeSourceProvenance(source, recipeDirectory),
      digest: { sha256: digest },
      localPathCategory: "temporary-download",
    },
  }
}

async function downloadRecipeSourceZip(url: string, targetPath: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download recipe source ${url}: HTTP ${response.status}`)
  }

  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(targetPath))
  const buffer = await readFile(targetPath)
  return createHash("sha256").update(buffer).digest("hex")
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
    await cp(source, directory, { recursive: true })
    await cp(source, baselineDirectory, { recursive: true })
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

  throw new Error("Directory workspace seeds require an explicit target")
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

function recipeSource(sourceRef: string): { type: RecipeSourceType; resolvedUrl: string; wporgSlug?: string } {
  let url: URL
  try {
    url = new URL(sourceRef)
  } catch {
    return { type: "local", resolvedUrl: sourceRef }
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
    return { type: "wporg_plugin_zip", resolvedUrl: url.toString(), ...(match ? { wporgSlug: match[1] } : {}) }
  }

  return { type: "https_zip", resolvedUrl: url.toString() }
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
  }
}

function recipeExtraPluginSlug(plugin: WorkspaceRecipeExtraPlugin): string {
  if (plugin.slug) {
    return plugin.slug
  }

  const source = recipeSource(plugin.source)
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

function activateExtraPluginsCode(recipe: WorkspaceRecipe): string | null {
  const pluginFiles = recipeExtraPlugins(recipe)
    .filter((plugin) => plugin.activate !== false)
    .map(recipeExtraPluginFile)

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
  const raw = value.trim().startsWith("{") ? value : await readFile(resolve(value), "utf8")
  return JSON.parse(raw) as RuntimePolicy
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
