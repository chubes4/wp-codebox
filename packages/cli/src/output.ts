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
  executions?: ExecutionResult[]
  dryRun?: boolean
  plan?: {
    workflow?: { steps?: unknown[] }
    mounts?: unknown[]
    workspaces?: unknown[]
    extra_plugins?: unknown[]
  }
  validation?: {
    issues?: Array<{ code: string; path: string; message: string }>
  }
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
  if (output.artifacts?.preview?.url) {
    console.log(`Preview: ${output.artifacts.preview.url} (${output.artifacts.preview.status})`)
  }
}

export function printRecipeHumanOutput(output: RecipeRunOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox recipe failed")
    for (const issue of output.validation?.issues ?? []) {
      console.error(`- ${issue.code} ${issue.path}: ${issue.message}`)
    }
    return
  }

  if (output.dryRun) {
    console.log("WP Codebox recipe dry-run")
    console.log(`Steps: ${output.plan?.workflow?.steps?.length ?? 0}`)
    console.log(`Mounts: ${output.plan?.mounts?.length ?? 0}`)
    console.log(`Workspaces: ${output.plan?.workspaces?.length ?? 0}`)
    console.log(`Extra plugins: ${output.plan?.extra_plugins?.length ?? 0}`)
    return
  }

  console.log("WP Codebox recipe")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Steps: ${output.executions?.length ?? 0}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
  if (output.artifacts?.preview?.url) {
    console.log(`Preview: ${output.artifacts.preview.url} (${output.artifacts.preview.status})`)
  }
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

Options:
  --recipe <path>     Workspace recipe JSON file for recipe-run or recipe validate.
  --mount <host:vfs>   Mount a host path into the runtime. Repeatable.
  --command <id>       Command/action id to execute.
  --arg <key=value>    Command argument. Repeatable. Recipe commands include wordpress.run-php, wordpress.phpunit, wordpress.core-phpunit, wordpress.wp-cli, wordpress.ability, and wordpress.bench.
  --wp <version>       WordPress version for Playground. Defaults to 7.0; accepts latest, trunk, nightly, or numeric versions.
  --artifacts <dir>    Artifact root directory.
  --preview-hold <n>   Keep the live Playground preview available after a successful run. Accepts seconds or minutes, e.g. 30s or 15m; max 3600s.
  --policy <json|file> Runtime policy JSON or path to a JSON file.
  --dry-run            Validate recipe-run and emit a resolved JSON plan without booting Playground or writing temp workspaces.
  --json               Emit machine-readable JSON.

Example:
  wp-codebox run --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin --command wordpress.run-php --arg code-file=./examples/simple-plugin/probe.php --artifacts ./artifacts --json`)
}
