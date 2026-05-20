#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createRuntime, type ArtifactBundle, type ExecutionResult, type RuntimeInfo, type RuntimePolicy, type WorkspaceRecipe, type WorkspaceRecipeExtraPlugin, type WorkspaceRecipeWorkspace } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"
import { agentRuntimeProbeCode, agentSandboxRunCode, resolveSandboxTaskCode } from "./agent-code.js"
import { captureStdout, printBatchHumanOutput, printHelp, printHumanOutput, printRecipeHumanOutput, printRecipeValidateHumanOutput, serializeError } from "./output.js"

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
  json: boolean
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
  benchResults?: BenchResults
  benchResultsList?: BenchResults[]
  artifacts?: ArtifactBundle
  logs?: string[]
  error?: RunOutput["error"]
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
const supportedRecipeCommands = new Set(["inspect-mounted-inputs", "wordpress.run-php", "wordpress.wp-cli", "wordpress.ability", "wordpress.bench", "wp-codebox.agent-runtime-probe", "wp-codebox.agent-sandbox-run"])

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
    const execute = () => runRecipe(options)

    if (!options.json) {
      const output = await execute()
      printRecipeHumanOutput(output)
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const output = logs.length > 0 ? { ...result, logs } : result
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
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
  return output.success ? 0 : 1
}

async function runRecipe(options: RecipeRunOptions): Promise<RecipeRunOutput> {
  const recipePath = resolve(options.recipePath)
  const recipeDirectory = dirname(recipePath)
  const recipe = parseWorkspaceRecipe(await readFile(recipePath, "utf8"), recipePath)
  const policy = recipePolicy(recipe)
  const secretEnv = resolveSecretEnv(recipe.inputs?.secretEnv ?? [])
  const workspaceMounts = await prepareRecipeWorkspaces(recipe, recipeDirectory)
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  const executions: ExecutionResult[] = []
  let artifacts: ArtifactBundle | undefined

  try {
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
          ...recipeRunMetadata(recipe, recipePath, workspaceMounts),
        },
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

    for (const plugin of recipeExtraPlugins(recipe)) {
      const slug = recipeExtraPluginSlug(plugin)
      await runtime.mount({
        type: "directory",
        source: resolve(recipeDirectory, plugin.source),
        target: `/wordpress/wp-content/plugins/${slug}`,
        mode: "readonly",
      })
    }

    for (const mount of recipe.inputs?.mounts ?? []) {
      await runtime.mount({
        type: "directory",
        source: resolve(recipeDirectory, mount.source),
        target: mount.target,
        mode: mount.mode ?? "readwrite",
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
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
    await runtime.destroy()
    await cleanupRecipeWorkspaces(workspaceMounts)

    const benchResultsList = executions
      .filter((execution) => execution.command === "wordpress.bench" && execution.exitCode === 0)
      .map((execution) => parseBenchResults(execution.stdout))

    return {
      success: true,
      schema: "wp-codebox/recipe-run/v1",
      recipePath,
      runtime: await runtime.info(),
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

    await cleanupRecipeWorkspaces(workspaceMounts)

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

function runMetadata(options: RunOptions): Record<string, unknown> {
  return {
    ...runtimeMetadata(options.artifactsDirectory, options.wpVersion ?? DEFAULT_WORDPRESS_VERSION),
    task: stripUndefined({
      kind: "cli-run",
      command: options.command,
      args: options.args,
      artifactsDirectory: options.artifactsDirectory,
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
      },
      createPlaygroundRuntimeBackend(),
    )

    for (const mount of options.mounts) {
      await runtime.mount({ type: "directory", source: mount.source, target: mount.target, mode: mount.mode, metadata: mount.metadata })
    }

    execution = await runtime.execute({ command: options.command, args: options.args })
    await runtime.observe({ type: "runtime-info" })
    await runtime.observe({ type: "mounts" })
    artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
    await runtime.destroy()

    return {
      success: true,
      runtime: await runtime.info(),
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
  const options: Partial<RecipeRunOptions> = { json: false }

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
      case "--artifacts":
        options.artifactsDirectory = value
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
    const pluginSource = resolve(recipeDirectory, plugin.source)
    const slug = recipeExtraPluginSlug(plugin)
    const pluginFile = recipeExtraPluginFile(plugin)
    await validateExistingDirectory(pluginSource, `${path}.source`, addIssue)

    if (!pluginFile.startsWith(`${slug}/`)) {
      addIssue("invalid-plugin-file", `${path}.pluginFile`, `Plugin file must be relative to the mounted plugin slug (${slug}/...).`)
      continue
    }

    await validateExistingFile(join(pluginSource, pluginFile.slice(slug.length + 1)), `${path}.pluginFile`, addIssue)
  }

  for (const [index, name] of (recipe.inputs?.secretEnv ?? []).entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      addIssue("invalid-secret-env", `$.inputs.secretEnv[${index}]`, `Secret environment variable names must match /^[A-Z_][A-Z0-9_]*$/: ${name}`)
    }
  }

  return issues
}

async function validateRecipeStepArgs(step: WorkspaceRecipe["workflow"]["steps"][number], path: string, addIssue: (code: string, path: string, message: string) => void): Promise<void> {
  if (step.command === "wordpress.run-php") {
    const code = recipeStepArgValue(step.args ?? [], "code")
    const codeFile = recipeStepArgValue(step.args ?? [], "code-file")
    if (!code && !codeFile) {
      addIssue("missing-code", `${path}.args`, "wordpress.run-php requires code=<php> or code-file=<path>.")
    }
    if (code && codeFile) {
      addIssue("ambiguous-code", `${path}.args`, "wordpress.run-php accepts either code=<php> or code-file=<path>, not both.")
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

function recipeStepArgValue(args: string[], key: string): string | undefined {
  const prefix = `${key}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function recipeWpCliCommandFromArgs(args: string[]): string {
  return recipeStepArgValue(args, "command")?.trim() ?? args.join(" ").trim()
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

function recipeRunMetadata(recipe: WorkspaceRecipe, recipePath: string, workspaceMounts: PreparedWorkspaceMount[]): Record<string, unknown> {
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
        extra_plugins: recipeExtraPlugins(recipe),
        secretEnv: recipe.inputs?.secretEnv ?? [],
      },
    },
    task: {
      kind: "recipe-run",
      recipePath,
      workflow: {
        steps: recipe.workflow.steps.map((step) => ({ command: step.command, args: step.args ?? [] })),
      },
      inputs: {
        workspaces: recipe.inputs?.workspaces ?? [],
        mounts: recipe.inputs?.mounts ?? [],
        extra_plugins: recipeExtraPlugins(recipe),
        secretEnv: recipe.inputs?.secretEnv ?? [],
      },
    },
    preparedWorkspaces: workspaceMounts.map((workspace) => ({
      target: workspace.target,
      mode: workspace.mode,
      metadata: workspace.metadata,
    })),
  }
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

function recipeExtraPluginSlug(plugin: WorkspaceRecipeExtraPlugin): string {
  return plugin.slug ?? basename(resolve(plugin.source))
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
