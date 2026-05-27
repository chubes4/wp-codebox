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
    siteSeeds?: unknown[]
    stagedFiles?: unknown[]
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
    stagedFiles?: number
  }
}

interface BlueprintValidateOutputLike extends RunOutputLike {
  blueprintPath?: string
}

interface BatchOutputLike {
  concurrency: number
  total: number
  completed: number
  runs: Array<RunOutputLike & { index: number; task: string }>
}

interface CommandCatalogOutputLike {
  commands: Array<{
    id: string
    description: string
    acceptedArgs: Array<{ name: string; required?: boolean }>
    outputShape: string
    policyRequirement: string
  }>
}

interface RecipeSchemaOutputLike {
  id: string
  jsonSchema: Record<string, unknown>
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

export function printBootHumanOutput(output: RunOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox boot failed")
    return
  }

  console.log("WP Codebox boot")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
  if (output.artifacts?.preview?.url) {
    console.log(`Preview: ${output.artifacts.preview.url} (${output.artifacts.preview.status})`)
  }
}

export function printBlueprintValidateHumanOutput(output: BlueprintValidateOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox blueprint validation failed")
    return
  }

  console.log("WP Codebox blueprint validation")
  console.log(`Blueprint: ${output.blueprintPath ?? "inline"}`)
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
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
    console.log(`Site seeds: ${output.plan?.siteSeeds?.length ?? 0}`)
    console.log(`Staged files: ${output.plan?.stagedFiles?.length ?? 0}`)
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
    if (output.summary.stagedFiles !== undefined) {
      console.log(`Staged files: ${output.summary.stagedFiles}`)
    }
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

export function printCommandCatalogHumanOutput(output: CommandCatalogOutputLike): void {
  console.log("WP Codebox commands")
  for (const command of output.commands) {
    const requiredArgs = command.acceptedArgs.filter((arg) => arg.required).map((arg) => arg.name)
    console.log(`${command.id}: ${command.description}`)
    if (requiredArgs.length > 0) {
      console.log(`  Required args: ${requiredArgs.join(", ")}`)
    }
    console.log(`  Output: ${command.outputShape}`)
    console.log(`  Policy: ${command.policyRequirement}`)
  }
}

export function printRecipeSchemaHumanOutput(output: RecipeSchemaOutputLike): void {
  const properties = output.jsonSchema.properties && typeof output.jsonSchema.properties === "object" ? Object.keys(output.jsonSchema.properties) : []
  console.log("WP Codebox recipe schema")
  console.log(`Schema: ${output.id}`)
  console.log(`Top-level fields: ${properties.join(", ")}`)
}

export function printHelp(): void {
  console.log(`Usage:
  wp-codebox commands [--json]
  wp-codebox schema recipe [--json]
  wp-codebox workspace-policy check --workspace-root <path> --writable-root <path> [options]
  wp-codebox recipe validate --recipe <path> [--json]
  wp-codebox validate-blueprint --blueprint <json|file> [options]
  wp-codebox recipe-run --recipe <path> [options]
  wp-codebox boot [--mount <host>:<vfs>] [options]
  wp-codebox run --mount <host>:<vfs> --command <id> [options]

Options:
  --recipe <path>     Workspace recipe JSON file for recipe-run or recipe validate.
  --mount <host:vfs>   Mount a host path into the runtime. Repeatable.
  --command <id>       Command/action id to execute.
  --arg <key=value>    Command argument. Repeatable. Recipe commands include wordpress.run-php, wordpress.phpunit, wordpress.core-phpunit, wordpress.plugin-check, wordpress.wp-cli, wordpress.ability, wordpress.bench, and wordpress.browser-probe.
  --wp <version>       WordPress version for Playground. Defaults to 7.0; accepts latest, trunk, nightly, or numeric versions.
  --blueprint <json|file>
                       WordPress Playground blueprint JSON or path for boot or validate-blueprint.
  --artifacts <dir>    Artifact root directory.
  --hold <n>           Keep a booted Playground preview available before teardown. Accepts the same values as --preview-hold.
  --preview-hold <n>   Keep the live Playground preview available after a successful run. Accepts seconds or minutes, e.g. 30s or 15m; max 3600s.
  --preview-port <n>   Start Playground on a fixed local port. Defaults to a random available port.
  --preview-bind <host>
                       Host/IP for the fixed-port WP Codebox preview proxy. Requires --preview-port.
                       Defaults to 127.0.0.1; use 0.0.0.0 only behind trusted network controls.
  --preview-public-url <url>
                       Public tunnel/proxy URL to report in preview artifacts and pass to Playground as site-url.
                       Upstream Playground remains loopback-bound; this only changes the WP Codebox proxy bind.
  --policy <json|file> Runtime policy JSON or path to a JSON file.
  --dry-run            Validate recipe-run and emit a resolved JSON plan without booting Playground or writing temp workspaces.
  --json               Emit machine-readable JSON.

Workspace policy:
  --workspace-root <dir>
                       Workspace root to inspect. Defaults to the current directory.
  --writable-root <path>
                       Relative path that may be changed. Repeatable.
  --hidden-path <path> Relative path that must not be changed or exposed. Repeatable.
  --git                Use git status metadata, including ignored and unmerged entries.

Discovery:
  commands             Print supported runtime and recipe command metadata.
  schema recipe        Print the wp-codebox/workspace-recipe/v1 JSON Schema.

Example:
  wp-codebox run --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin --command wordpress.run-php --arg code-file=./examples/simple-plugin/probe.php --artifacts ./artifacts --json`)
}
