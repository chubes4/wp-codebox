#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createRuntime, type ArtifactBundle, type ExecutionResult, type RuntimeInfo, type RuntimePolicy } from "@chubes4/sandbox-runtime-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/sandbox-runtime-playground"

interface RunOptions {
  backend: "wordpress-playground"
  mounts: Array<{ source: string; target: string; mode: "readonly" | "readwrite" }>
  command: string
  args: string[]
  artifactsDirectory?: string
  policy?: RuntimePolicy
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

const defaultPolicy: RuntimePolicy = {
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["inspect-mounted-inputs", "wordpress.run-php"],
  secrets: "none",
  approvals: "never",
}

async function main(args: string[]): Promise<number> {
  const command = args.shift()

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return command ? 0 : 1
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

async function run(options: RunOptions): Promise<RunOutput> {
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let execution: ExecutionResult | undefined
  let artifacts: ArtifactBundle | undefined

  try {
    runtime = await createRuntime(
      {
        backend: options.backend,
        environment: {
          kind: "wordpress",
          name: "sandbox-runtime-cli",
          version: "latest",
          blueprint: { steps: [] },
        },
        policy: options.policy ?? defaultPolicy,
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
    backend: "wordpress-playground",
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
      case "--backend":
        if (value !== "wordpress-playground") {
          throw new Error(`Unsupported backend: ${value}`)
        }
        options.backend = value
        break
      case "--mount":
        options.mounts.push(parseMount(value))
        break
      case "--command":
        options.command = value
        break
      case "--arg":
        options.args.push(value)
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
    console.error(output.error?.message ?? "Sandbox Runtime failed")
    return
  }

  console.log("Sandbox Runtime run")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Executed: ${output.execution?.command ?? "unknown"}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
}

function printHelp(): void {
  console.log(`Usage:
  sandbox-runtime run --mount <host>:<vfs> --command <id> [options]

Options:
  --backend <name>     Runtime backend. Currently: wordpress-playground
  --mount <host:vfs>   Mount a host path into the runtime. Repeatable.
  --command <id>       Command/action id to execute.
  --arg <key=value>    Command argument. Repeatable.
  --artifacts <dir>    Artifact root directory.
  --policy <json|file> Runtime policy JSON or path to a JSON file.
  --json               Emit machine-readable JSON.

Example:
  sandbox-runtime run --backend wordpress-playground --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin --command wordpress.run-php --arg code-file=./examples/simple-plugin/probe.php --artifacts ./artifacts --json`)
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
