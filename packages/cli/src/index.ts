#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { createRuntime, type ArtifactBundle, type ExecutionResult, type RuntimeInfo, type RuntimePolicy } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

interface RunOptions {
  mounts: Array<{ source: string; target: string; mode: "readonly" | "readwrite" }>
  command: string
  args: string[]
  wpVersion?: string
  artifactsDirectory?: string
  policy?: RuntimePolicy
  secretEnv?: Record<string, string>
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

interface AgentRuntimeProbeOptions {
  agentsApiPath: string
  dataMachinePath: string
  dataMachineCodePath: string
  providerPluginPaths: string[]
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

const defaultPolicy: RuntimePolicy = {
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["inspect-mounted-inputs", "wordpress.run-php"],
  secrets: "none",
  approvals: "never",
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

  if (command === "agent-runtime-probe") {
    const options = parseAgentRuntimeProbeOptions(args)
    const runOptions = await agentRuntimeProbeRunOptions(options)
    const execute = () => run(runOptions)

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

  if (command === "agent-sandbox-run") {
    const options = parseAgentSandboxRunOptions(args)
    const runOptions = await agentSandboxRunOptions(options)
    const execute = () => run(runOptions)

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

  if (command === "agent-sandbox-batch") {
    const options = await parseAgentSandboxBatchOptions(args)
    const execute = () => runAgentSandboxBatch(options)

    if (!options.json) {
      const output = await execute()
      printBatchHumanOutput(output)
      return output.success ? 0 : 1
    }

    const { result, logs } = await captureStdout(execute)
    const output = logs.length > 0 ? { ...result, logs } : result
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

async function agentRuntimeProbeRunOptions(options: AgentRuntimeProbeOptions): Promise<RunOptions> {
  return {
    mounts: agentRuntimeMounts(options),
    command: "wordpress.run-php",
    args: [`code=${agentRuntimeProbeCode(providerPluginMounts(options))}`],
    wpVersion: options.wpVersion ?? "trunk",
    artifactsDirectory: options.artifactsDirectory,
    ...await runSecretEnvOptions(options),
    json: options.json,
  }
}

async function agentSandboxRunOptions(options: AgentSandboxRunOptions): Promise<RunOptions> {
  return {
    mounts: agentRuntimeMounts(options),
    command: "wordpress.run-php",
    args: [`code=${agentSandboxRunCode(options.task, await resolveSandboxTaskCode(options), providerPluginMounts(options))}`],
    wpVersion: options.wpVersion ?? "trunk",
    artifactsDirectory: options.artifactsDirectory,
    ...await runSecretEnvOptions(options),
    json: options.json,
  }
}

async function runAgentSandboxBatch(options: AgentSandboxBatchOptions): Promise<AgentSandboxBatchOutput> {
  const concurrency = positiveInteger(options.concurrency, 2)
  const runs = await mapWithConcurrency(options.tasks, concurrency, async (task, index) => {
    const runOptions = await agentSandboxRunOptions({
      ...options,
      task,
    })
    const output = await run(runOptions)
    return { ...output, index, task }
  })
  const failed = runs.filter((run) => !run.success).length

  return {
    success: failed === 0,
    schema: "wp-codebox/agent-sandbox-batch/v1",
    concurrency,
    total: runs.length,
    completed: runs.length - failed,
    failed,
    runs,
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
    { source: resolve(options.agentsApiPath), target: "/wordpress/wp-content/plugins/agents-api", mode: "readwrite" },
    { source: resolve(options.dataMachinePath), target: "/wordpress/wp-content/plugins/data-machine", mode: "readwrite" },
    { source: resolve(options.dataMachineCodePath), target: "/wordpress/wp-content/plugins/data-machine-code", mode: "readwrite" },
    ...providerPluginMounts(options).map((plugin) => ({
      source: plugin.source,
      target: `/wordpress/wp-content/plugins/${plugin.slug}`,
      mode: "readwrite" as const,
    })),
  ]
}

function providerPluginMounts(options: AgentRuntimeProbeOptions): Array<{ source: string; slug: string }> {
  return options.providerPluginPaths.map((pluginPath) => {
    const source = resolve(pluginPath)
    return { source, slug: basename(source) }
  })
}

function parseAgentRuntimeProbeOptions(args: string[], extraOptions: string[] = []): AgentRuntimeProbeOptions {
  const options: Partial<AgentRuntimeProbeOptions> = { json: false }

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

  return options as AgentRuntimeProbeOptions
}

function parseAgentSandboxRunOptions(args: string[]): AgentSandboxRunOptions {
  const options = parseAgentRuntimeProbeOptions(args, ["--task", "--agent", "--mode", "--provider", "--model", "--session-id", "--max-turns", "--code", "--code-file", "--secret-env"]) as Partial<AgentSandboxRunOptions>

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

async function parseAgentSandboxBatchOptions(args: string[]): Promise<AgentSandboxBatchOptions> {
  const options = parseAgentRuntimeProbeOptions(args, ["--task", "--tasks-json", "--tasks-file", "--agent", "--mode", "--provider", "--model", "--max-turns", "--concurrency", "--secret-env"]) as Partial<AgentSandboxBatchOptions>
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
          version: options.wpVersion ?? "latest",
          blueprint: { steps: [] },
        },
        policy: options.policy ?? defaultPolicy,
        secretEnv: options.secretEnv,
        artifactsDirectory: options.artifactsDirectory,
      },
      createPlaygroundRuntimeBackend(),
    )

    for (const mount of options.mounts) {
      await runtime.mount({ type: "directory", source: mount.source, target: mount.target, mode: mount.mode })
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

function parseMount(value: string): RunOptions["mounts"][number] {
  const [source, target, mode = "readwrite"] = value.split(":")

  if (!source || !target) {
    throw new Error(`Invalid mount, expected host:vfs: ${value}`)
  }

  if (mode !== "readonly" && mode !== "readwrite") {
    throw new Error(`Invalid mount mode, expected readonly or readwrite: ${mode}`)
  }

  return { source: resolve(source), target, mode }
}

async function parsePolicy(value: string): Promise<RuntimePolicy> {
  const raw = value.trim().startsWith("{") ? value : await readFile(resolve(value), "utf8")
  return JSON.parse(raw) as RuntimePolicy
}

async function captureStdout<T>(callback: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    logs.push(typeof chunk === "string" ? chunk : chunk.toString())

    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }

    return true
  }) as typeof process.stdout.write

  try {
    return { result: await callback(), logs: logs.map((log) => log.trim()).filter(Boolean) }
  } finally {
    process.stdout.write = write
  }
}

function serializeError(error: unknown): RunOutput["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    }
  }

  return { name: "Error", message: String(error) }
}

function printHumanOutput(output: RunOutput): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox failed")
    return
  }

  console.log("WP Codebox run")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Executed: ${output.execution?.command ?? "unknown"}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
}

function printBatchHumanOutput(output: AgentSandboxBatchOutput): void {
  console.log("WP Codebox batch")
  console.log(`Runs: ${output.completed}/${output.total} completed`)
  console.log(`Concurrency: ${output.concurrency}`)
  for (const run of output.runs) {
    console.log(`${run.success ? "ok" : "fail"} #${run.index + 1}: ${run.task}`)
    if (run.artifacts?.directory) {
      console.log(`  Artifacts: ${run.artifacts.directory}`)
    }
  }
}

function printHelp(): void {
  console.log(`Usage:
  wp-codebox run --mount <host>:<vfs> --command <id> [options]
  wp-codebox agent-runtime-probe --agents-api <path> --data-machine <path> --data-machine-code <path> [options]
  wp-codebox agent-sandbox-run --agents-api <path> --data-machine <path> --data-machine-code <path> --task <text> [options]
  wp-codebox agent-sandbox-batch --agents-api <path> --data-machine <path> --data-machine-code <path> --task <text> [--task <text> ...] [options]

Options:
  --mount <host:vfs>   Mount a host path into the runtime. Repeatable.
  --command <id>       Command/action id to execute.
  --arg <key=value>    Command argument. Repeatable.
  --wp <version>       WordPress version for Playground, e.g. latest, trunk, nightly, 6.9.
  --artifacts <dir>    Artifact root directory.
  --policy <json|file> Runtime policy JSON or path to a JSON file.
  --json               Emit machine-readable JSON.

Agent runtime probe options:
  --agents-api <path>         Local Agents API plugin checkout.
  --data-machine <path>       Local Data Machine plugin checkout.
  --data-machine-code <path>  Local Data Machine Code plugin checkout.
  --provider-plugin <path>    Local AI provider plugin checkout. Repeatable.

Agent sandbox run options:
  --task <text>               Task description recorded in the sandbox run.
  --agent <slug>              Agent slug to invoke through the canonical agents/chat ability.
  --mode <slug>               Agent execution mode. Defaults to sandbox.
  --provider <id>             AI provider id to seed into the sandbox agent config.
  --model <id>                AI model id to seed into the sandbox agent config.
  --secret-env <name>         Parent environment variable to expose inside the sandbox. Repeatable.
  --session-id <id>           Existing sandbox conversation session id.
  --max-turns <n>             Maximum agent loop turns for the sandbox task.
  --code <php>                Optional PHP body to run after the agent stack boots.
  --code-file <path>          Optional PHP file to run after the agent stack boots.

Agent sandbox batch options:
  --task <text>               Task to run in its own isolated sandbox. Repeatable.
  --tasks-json <json>         JSON array of task strings or objects with a task string.
  --tasks-file <path>         File containing a JSON task array.
  --secret-env <name>         Parent environment variable to expose inside each sandbox. Repeatable.
  --concurrency <n>           Maximum concurrent sandboxes. Defaults to 2.

Example:
  wp-codebox run --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin --command wordpress.run-php --arg code-file=./examples/simple-plugin/probe.php --artifacts ./artifacts --json`)
}

async function resolveSandboxTaskCode(options: AgentSandboxRunOptions): Promise<string> {
  if (options.agent) {
    return agentChatTaskCode(options)
  }

  if (options.code) {
    return options.code
  }

  if (options.codeFile) {
    return readFile(resolve(options.codeFile), "utf8")
  }

  return `echo json_encode(array('task_received' => true), JSON_PRETTY_PRINT);`
}

function agentChatTaskCode(options: AgentSandboxRunOptions): string {
  const mode = options.mode ?? "sandbox"
  const agentConfig = scopedAgentConfig(mode, options.provider, options.model)
  const input: Record<string, unknown> = {
    agent: options.agent,
    message: options.task,
    session_id: options.sessionId ?? null,
    mode,
    client_context: {
      source: "bridge",
      client_name: "wp-codebox",
      connector_id: "wp-codebox-cli",
      mode,
      agent_modes: [mode],
    },
  }

  if (options.maxTurns) {
    input.max_turns = Number.parseInt(options.maxTurns, 10)
  }

  return `
if (function_exists('wp_set_current_user')) {
    wp_set_current_user(1);
}

if (class_exists('DataMachine\\Core\\Database\\Agents\\Agents')) {
    $sandbox_agent_slug = sanitize_title((string) (${JSON.stringify(input.agent)}));
    if ('' !== $sandbox_agent_slug) {
        (new DataMachine\\Core\\Database\\Agents\\Agents())->create_if_missing(
            $sandbox_agent_slug,
            'Sandbox Agent',
            1,
            json_decode(${JSON.stringify(JSON.stringify(agentConfig))}, true)
        );
    }
}

$sandbox_model_settings = json_decode(${JSON.stringify(JSON.stringify(scopedSettings(mode, options.provider, options.model)))}, true);
if (is_array($sandbox_model_settings) && !empty($sandbox_model_settings)) {
    update_option('datamachine_settings', array_merge(get_option('datamachine_settings', array()), $sandbox_model_settings));
}

add_filter('agents_chat_permission', static function () {
    return true;
}, 100, 2);

$ability = function_exists('wp_get_ability') ? wp_get_ability('agents/chat') : null;
if (!$ability || !method_exists($ability, 'execute')) {
    $sandbox_agent_runtime = array(
        'agent_runtime' => array(
            'success' => false,
            'error' => array(
                'code' => 'agents_chat_unavailable',
                'message' => 'The canonical agents/chat ability is not available inside the sandbox.',
            ),
        ),
    );
} else {
    $agent_input = ${JSON.stringify(JSON.stringify(input))};
    $agent_result = $ability->execute(json_decode($agent_input, true));
    if (is_wp_error($agent_result)) {
        $sandbox_agent_runtime = array(
            'agent_runtime' => array(
                'success' => false,
                'input' => json_decode($agent_input, true),
                'error' => array(
                    'code' => $agent_result->get_error_code(),
                    'message' => $agent_result->get_error_message(),
                    'data' => $agent_result->get_error_data(),
                ),
            ),
        );
    } else {
        $sandbox_agent_runtime = array(
            'agent_runtime' => array(
                'success' => true,
                'input' => json_decode($agent_input, true),
                'result' => $agent_result,
            ),
        );
    }
}

echo json_encode($sandbox_agent_runtime, JSON_PRETTY_PRINT);
`
}

function scopedAgentConfig(mode: string, provider: string | undefined, model: string | undefined): Record<string, unknown> {
  if (!provider && !model) {
    return {}
  }

  return {
    ...(provider ? { default_provider: provider } : {}),
    ...(model ? { default_model: model } : {}),
    mode_models: {
      [mode]: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    },
  }
}

function scopedSettings(mode: string, provider: string | undefined, model: string | undefined): Record<string, unknown> {
  if (!provider && !model) {
    return {}
  }

  return {
    ...(provider ? { default_provider: provider } : {}),
    ...(model ? { default_model: model } : {}),
    mode_models: {
      [mode]: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    },
  }
}

function agentSandboxRunCode(task: string, code: string, providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (file_exists(WP_PLUGIN_DIR . '/' . $candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $result = activate_plugin($plugin);
    $activation_results[$plugin] = array(
        'active' => is_plugin_active($plugin),
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

$sandbox_task = ${JSON.stringify(task)};
$sandbox_stack = array(
    'plugins' => $activation_results,
    'signals' => array(
        'agents_api_loaded' => defined('AGENTS_API_LOADED'),
        'agents_registry_class' => class_exists('WP_Agents_Registry'),
        'data_machine_version' => defined('DATAMACHINE_VERSION') ? DATAMACHINE_VERSION : null,
        'data_machine_permission_helper' => class_exists('DataMachine\\Abilities\\PermissionHelper'),
        'data_machine_code_version' => defined('DATAMACHINE_CODE_VERSION') ? DATAMACHINE_CODE_VERSION : null,
        'data_machine_code_workspace' => class_exists('DataMachineCode\\Workspace\\Workspace'),
        'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
    ),
);

ob_start();
${phpBody(code)}
$sandbox_output = ob_get_clean();

echo json_encode(
    array(
        'command' => 'agent-sandbox.run',
        'task' => $sandbox_task,
        'wp_loaded' => function_exists('wp_insert_post'),
        'stack' => $sandbox_stack,
        'output' => $sandbox_output,
    ),
    JSON_PRETTY_PRINT
);
`
}

function phpBody(code: string): string {
  return code.trimStart().replace(/^<\?php\s*/, "")
}

function agentRuntimeProbeCode(providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (file_exists(WP_PLUGIN_DIR . '/' . $candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $result = activate_plugin($plugin);
    $activation_results[$plugin] = array(
        'active' => is_plugin_active($plugin),
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

echo json_encode(
    array(
        'command' => 'agent-runtime.probe',
        'wp_loaded' => function_exists('wp_insert_post'),
        'plugins' => $activation_results,
        'signals' => array(
            'agents_api_loaded' => defined('AGENTS_API_LOADED'),
            'agents_registry_class' => class_exists('WP_Agents_Registry'),
            'data_machine_version' => defined('DATAMACHINE_VERSION') ? DATAMACHINE_VERSION : null,
            'data_machine_permission_helper' => class_exists('DataMachine\\\\Abilities\\\\PermissionHelper'),
            'data_machine_code_version' => defined('DATAMACHINE_CODE_VERSION') ? DATAMACHINE_CODE_VERSION : null,
            'data_machine_code_workspace' => class_exists('DataMachineCode\\\\Workspace\\\\Workspace'),
            'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
        ),
    ),
    JSON_PRETTY_PRINT
);
`
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
