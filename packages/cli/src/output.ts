import type { ArtifactBundle, ExecutionResult, RuntimeInfo } from "@chubes4/wp-codebox-core"

interface CliError {
  name: string
  message: string
  code?: string
}

interface RunOutputLike {
  success: boolean
  runtime?: RuntimeInfo
  execution?: ExecutionResult
  artifacts?: ArtifactBundle
  error?: CliError
}

interface RecipeRunOutputLike extends RunOutputLike {
  executions: ExecutionResult[]
}

interface RecipeValidateOutputLike {
  recipePath?: string
  valid: boolean
  issues: Array<{ code: string; path: string; message: string }>
  summary?: {
    steps: number
    mounts: number
    workspaces: number
    extraPlugins: number
  }
}

interface BatchOutputLike {
  concurrency: number
  total: number
  completed: number
  runs: Array<RunOutputLike & { index: number; task: string }>
}

export async function captureStdout<T>(callback: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
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

export function serializeError(error: unknown): CliError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    }
  }

  return { name: "Error", message: String(error) }
}

export function printHumanOutput(output: RunOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox failed")
    return
  }

  console.log("WP Codebox run")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Executed: ${output.execution?.command ?? "unknown"}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
}

export function printRecipeHumanOutput(output: RecipeRunOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox recipe failed")
    return
  }

  console.log("WP Codebox recipe")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Steps: ${output.executions.length}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
}

export function printRecipeValidateHumanOutput(output: RecipeValidateOutputLike): void {
  console.log("WP Codebox recipe validation")
  console.log(`Recipe: ${output.recipePath ?? "unknown"}`)
  console.log(`Valid: ${output.valid ? "yes" : "no"}`)
  if (output.summary) {
    console.log(`Steps: ${output.summary.steps}`)
    console.log(`Mounts: ${output.summary.mounts}`)
    console.log(`Workspaces: ${output.summary.workspaces}`)
    console.log(`Extra plugins: ${output.summary.extraPlugins}`)
  }

  for (const issue of output.issues) {
    console.log(`- ${issue.code} ${issue.path}: ${issue.message}`)
  }
}

export function printBatchHumanOutput(output: BatchOutputLike): void {
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

export function printHelp(): void {
  console.log(`Usage:
  wp-codebox recipe validate --recipe <path> [--json]
  wp-codebox recipe-run --recipe <path> [options]
  wp-codebox run --mount <host>:<vfs> --command <id> [options]
  wp-codebox agent-runtime-probe --agents-api <path> --data-machine <path> --data-machine-code <path> [options]
  wp-codebox agent-sandbox-run --agents-api <path> --data-machine <path> --data-machine-code <path> --task <text> [options]
  wp-codebox agent-sandbox-batch --agents-api <path> --data-machine <path> --data-machine-code <path> --task <text> [--task <text> ...] [options]

Options:
  --recipe <path>     Workspace recipe JSON file for recipe-run or recipe validate.
  --mount <host:vfs>   Mount a host path into the runtime. Repeatable.
  --command <id>       Command/action id to execute.
  --arg <key=value>    Command argument. Repeatable.
  --wp <version>       WordPress version for Playground. Defaults to 7.0; accepts latest, trunk, nightly, or numeric versions.
  --artifacts <dir>    Artifact root directory.
  --policy <json|file> Runtime policy JSON or path to a JSON file.
  --json               Emit machine-readable JSON.

Agent runtime probe options:
  --agents-api <path>         Local Agents API plugin checkout.
  --data-machine <path>       Local Data Machine plugin checkout.
  --data-machine-code <path>  Local Data Machine Code plugin checkout.
  --provider-plugin <path>    Local AI provider plugin checkout. Repeatable.
  --mount <host:vfs>          Extra host path to mount into the runtime. Repeatable.

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
