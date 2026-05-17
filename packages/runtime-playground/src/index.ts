import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { assertRuntimeCommandAllowed } from "@chubes4/sandbox-runtime-core"
import type {
  ArtifactBundle,
  ArtifactManifest,
  ArtifactManifestFile,
  ArtifactSpec,
  ExecutionResult,
  ExecutionSpec,
  LifecycleEvent,
  MountSpec,
  ObservationResult,
  ObservationSpec,
  Runtime,
  RuntimeBackend,
  RuntimeCreateSpec,
  RuntimeInfo,
  Snapshot,
} from "@chubes4/sandbox-runtime-core"

function now(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface PlaygroundRunResponse {
  text: string
}

interface PlaygroundCliServer {
  playground: {
    run(options: { code: string }): Promise<PlaygroundRunResponse>
  }
  [Symbol.asyncDispose](): Promise<void>
}

interface PlaygroundCliModule {
  runCLI(options: {
    command: "server"
    port: number
    quiet: boolean
    skipBrowser: boolean
    mount: Array<{ hostPath: string; vfsPath: string }>
    blueprint?: unknown
  }): Promise<PlaygroundCliServer>
}

export class PlaygroundRuntimeBackend implements RuntimeBackend {
  readonly kind = "wordpress-playground" as const

  async create(spec: RuntimeCreateSpec): Promise<Runtime> {
    return PlaygroundRuntime.create(spec)
  }
}

class PlaygroundRuntime implements Runtime {
  private status: RuntimeInfo["status"] = "created"
  private readonly runtimeId = id("runtime")
  private readonly createdAt = now()
  private readonly mounts: MountSpec[] = []
  private readonly commands: ExecutionResult[] = []
  private readonly observations: ObservationResult[] = []
  private readonly events: LifecycleEvent[] = []
  private readonly artifactRoot: string
  private cliServerPromise?: Promise<PlaygroundCliServer>

  private constructor(private readonly spec: RuntimeCreateSpec) {
    this.artifactRoot = resolve(spec.artifactsDirectory ?? "artifacts", this.runtimeId)
  }

  static async create(spec: RuntimeCreateSpec): Promise<PlaygroundRuntime> {
    const runtime = new PlaygroundRuntime(spec)
    await mkdir(runtime.artifactRoot, { recursive: true })
    runtime.recordEvent("runtime.created", {
      backend: "wordpress-playground",
      environment: spec.environment,
      policy: spec.policy,
    })
    return runtime
  }

  async info(): Promise<RuntimeInfo> {
    return {
      id: this.runtimeId,
      backend: "wordpress-playground",
      environment: this.spec.environment,
      createdAt: this.createdAt,
      status: this.status,
    }
  }

  async mount(spec: MountSpec): Promise<void> {
    if (this.status === "destroyed") {
      throw new Error("Cannot mount into a destroyed runtime")
    }

    const mount = {
      ...spec,
      source: await realpath(spec.source),
    }

    this.mounts.push(mount)
    this.recordEvent("runtime.mounted", { mount })
  }

  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    assertRuntimeCommandAllowed(spec.command, this.spec.policy)

    const startedAt = now()
    const commandId = id("command")
    this.recordEvent("runtime.command.started", {
      id: commandId,
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? null,
      timeoutMs: spec.timeoutMs ?? null,
    })
    const result: ExecutionResult = {
      id: commandId,
      command: spec.command,
      args: spec.args ?? [],
      exitCode: 0,
      stdout: await this.executePlaygroundCommand(spec),
      stderr: "",
      startedAt,
      finishedAt: now(),
    }

    this.commands.push(result)
    this.recordEvent("runtime.command.finished", {
      id: result.id,
      command: result.command,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    })
    return result
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    const observation: ObservationResult = {
      type: spec.type,
      data: await this.observeStub(spec),
      observedAt: now(),
    }

    this.observations.push(observation)
    this.recordEvent("runtime.observed", {
      type: observation.type,
      observedAt: observation.observedAt,
    })
    return observation
  }

  async snapshot(): Promise<Snapshot> {
    const snapshot = {
      id: id("snapshot"),
      createdAt: now(),
      metadata: {
        runtime: await this.info(),
        mounts: this.mounts,
      },
    }

    this.recordEvent("runtime.snapshot.created", {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
    })

    return snapshot
  }

  async collectArtifacts(spec: ArtifactSpec = {}): Promise<ArtifactBundle> {
    await mkdir(this.artifactRoot, { recursive: true })
    const logsDirectory = join(this.artifactRoot, "logs")
    const filesDirectory = join(this.artifactRoot, "files")
    await mkdir(logsDirectory, { recursive: true })
    await mkdir(filesDirectory, { recursive: true })

    const bundleId = id("artifact-bundle")
    const createdAt = now()
    const manifestPath = join(this.artifactRoot, "manifest.json")
    const metadataPath = join(this.artifactRoot, "metadata.json")
    const eventsPath = join(this.artifactRoot, "events.jsonl")
    const commandsPath = join(this.artifactRoot, "commands.jsonl")
    const observationsPath = join(this.artifactRoot, "observations.jsonl")
    const runtimeLogPath = join(logsDirectory, "runtime.log")
    const commandsLogPath = join(logsDirectory, "commands.log")
    const mountsPath = join(filesDirectory, "mounts.json")

    this.recordEvent("runtime.artifacts.collected", {
      id: bundleId,
      directory: this.artifactRoot,
      createdAt,
      spec,
    })

    const runtime = await this.info()
    const metadata = {
      id: bundleId,
      createdAt,
      runtime,
      mounts: this.mounts,
      policy: this.spec.policy,
      spec,
    }

    const manifestFiles: ArtifactManifestFile[] = [
      fileEntry(manifestPath, "manifest", "application/json"),
      fileEntry(metadataPath, "metadata", "application/json"),
      fileEntry(eventsPath, "events", "application/x-ndjson"),
      fileEntry(commandsPath, "commands", "application/x-ndjson"),
      fileEntry(observationsPath, "observations", "application/x-ndjson"),
      fileEntry(runtimeLogPath, "log", "text/plain"),
      fileEntry(commandsLogPath, "log", "text/plain"),
      fileEntry(mountsPath, "mounts", "application/json"),
    ]

    const manifest: ArtifactManifest = {
      id: bundleId,
      createdAt,
      runtime,
      files: manifestFiles.map((file) => ({
        ...file,
        path: relative(this.artifactRoot, file.path),
      })),
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
    )
    await writeJsonLines(eventsPath, this.events)
    await writeJsonLines(commandsPath, this.commands)
    await writeJsonLines(observationsPath, this.observations)
    await writeFile(runtimeLogPath, this.formatRuntimeLog())
    await writeFile(commandsLogPath, this.formatCommandsLog())
    await writeFile(mountsPath, `${JSON.stringify(this.mounts, null, 2)}\n`)

    return {
      id: bundleId,
      directory: this.artifactRoot,
      manifestPath,
      metadataPath,
      eventsPath,
      commandsPath,
      observationsPath,
      runtimeLogPath,
      commandsLogPath,
      mountsPath,
      createdAt,
    }
  }

  async destroy(): Promise<void> {
    const cliServer = await this.cliServerPromise
    await cliServer?.[Symbol.asyncDispose]()
    this.status = "destroyed"
    this.recordEvent("runtime.destroyed", { runtimeId: this.runtimeId })
  }

  private recordEvent(type: LifecycleEvent["type"], data?: Record<string, unknown>): LifecycleEvent {
    const event: LifecycleEvent = {
      id: id("event"),
      type,
      timestamp: now(),
      ...(data ? { data } : {}),
    }

    this.events.push(event)
    return event
  }

  private formatRuntimeLog(): string {
    return this.events.map((event) => `[${event.timestamp}] ${event.type} ${JSON.stringify(event.data ?? {})}`).join("\n") + "\n"
  }

  private formatCommandsLog(): string {
    return (
      this.commands
        .map((command) => {
          const header = `[${command.startedAt}] ${command.command} ${command.args.join(" ")}`.trim()
          const output = [command.stdout, command.stderr].filter(Boolean).join("\n")
          return `${header}\nexitCode=${command.exitCode}\n${output}`
        })
        .join("\n---\n") + "\n"
    )
  }

  private async executePlaygroundCommand(spec: ExecutionSpec): Promise<string> {
    if (spec.command === "inspect-mounted-inputs") {
      return this.inspectMountedInputs()
    }

    if (spec.command === "wordpress.run-php") {
      return this.runPhp(spec)
    }

    throw new Error(`No Playground command handler is registered for: ${spec.command}`)
  }

  private async runPhp(spec: ExecutionSpec): Promise<string> {
    const server = await this.bootPlayground()
    const code = await this.phpCodeFromArgs(spec.args ?? [])
    const response = await server.playground.run({ code })

    return response.text
  }

  private async phpCodeFromArgs(args: string[]): Promise<string> {
    const inlineCode = argValue(args, "code")
    if (inlineCode) {
      return normalizePhpCode(inlineCode)
    }

    const codeFile = argValue(args, "code-file")
    if (codeFile) {
      return normalizePhpCode(await readFile(resolve(codeFile), "utf8"))
    }

    throw new Error("wordpress.run-php requires code=<php> or code-file=<path>")
  }

  private async inspectMountedInputs(): Promise<string> {
    const server = await this.bootPlayground()
    const response = await server.playground.run({
      code: `<?php
$mounts = ${JSON.stringify(JSON.stringify(this.mounts))};
$inspected = array_map(function ($mount) {
    $target = $mount['target'];
    $entries = is_dir($target) ? array_values(array_diff(scandir($target), array('.', '..'))) : array(basename($target));
    sort($entries);

    return array(
        'target' => $target,
        'source' => $mount['source'],
        'entries' => $entries,
        'exists' => file_exists($target),
    );
}, json_decode($mounts, true));

echo json_encode(array('command' => 'inspect-mounted-inputs', 'mounts' => $inspected), JSON_PRETTY_PRINT);
`,
    })

    return response.text
  }

  private async bootPlayground(): Promise<PlaygroundCliServer> {
    if (!this.cliServerPromise) {
      this.cliServerPromise = this.startPlayground()
    }

    return this.cliServerPromise
  }

  private async startPlayground(): Promise<PlaygroundCliServer> {
    const { runCLI } = (await import("@wp-playground/cli")) as unknown as PlaygroundCliModule

    return runCLI({
      command: "server",
      port: 0,
      quiet: true,
      skipBrowser: true,
      mount: this.mounts.map((mount) => ({
        hostPath: mount.source,
        vfsPath: mount.target,
      })),
      blueprint: this.spec.environment.blueprint,
    })
  }

  private async observeStub(spec: ObservationSpec): Promise<unknown> {
    if (spec.type === "runtime-info") {
      return this.info()
    }

    if (spec.type === "mounts") {
      return this.mounts
    }

    return { type: spec.type, path: spec.path ?? null }
  }
}

export function createPlaygroundRuntimeBackend(): RuntimeBackend {
  return new PlaygroundRuntimeBackend()
}

function fileEntry(path: string, kind: ArtifactManifestFile["kind"], contentType: string): ArtifactManifestFile {
  return { path, kind, contentType }
}

async function writeJsonLines(path: string, records: unknown[]): Promise<void> {
  await writeFile(path, records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "")
}

function argValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  const match = args.find((arg) => arg.startsWith(prefix))
  return match?.slice(prefix.length)
}

function normalizePhpCode(code: string): string {
  return code.trimStart().startsWith("<?php") ? code : `<?php\n${code}`
}
