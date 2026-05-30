import { getCommandDefinition, type PlaygroundRuntimeCommandId } from "@chubes4/wp-codebox-core"
import type { ExecutionSpec } from "@chubes4/wp-codebox-core"

interface PlaygroundCommandRuntime {
  inspectMountedInputs(): Promise<string>
  runPhp(spec: ExecutionSpec): Promise<string>
  runWpCli(spec: ExecutionSpec): Promise<string>
  runAbility(spec: ExecutionSpec): Promise<string>
  runBench(spec: ExecutionSpec): Promise<string>
  runPhpunit(spec: ExecutionSpec): Promise<string>
  runPluginCheck(spec: ExecutionSpec): Promise<string>
  runCorePhpunit(spec: ExecutionSpec): Promise<string>
  runThemeCheck(spec: ExecutionSpec): Promise<string>
  runBrowserProbe(spec: ExecutionSpec): Promise<string>
  runBrowserActions(spec: ExecutionSpec): Promise<string>
}

const playgroundCommandHandlers = {
  "inspect-mounted-inputs": (runtime) => runtime.inspectMountedInputs(),
  "wordpress.run-php": (runtime, spec) => runtime.runPhp(spec),
  "wordpress.wp-cli": (runtime, spec) => runtime.runWpCli(spec),
  "wordpress.ability": (runtime, spec) => runtime.runAbility(spec),
  "wordpress.bench": (runtime, spec) => runtime.runBench(spec),
  "wordpress.phpunit": (runtime, spec) => runtime.runPhpunit(spec),
  "wordpress.plugin-check": (runtime, spec) => runtime.runPluginCheck(spec),
  "wordpress.core-phpunit": (runtime, spec) => runtime.runCorePhpunit(spec),
  "wordpress.theme-check": (runtime, spec) => runtime.runThemeCheck(spec),
  "wordpress.browser-probe": (runtime, spec) => runtime.runBrowserProbe(spec),
  "wordpress.browser-actions": (runtime, spec) => runtime.runBrowserActions(spec),
} satisfies Record<PlaygroundRuntimeCommandId, (runtime: PlaygroundCommandRuntime, spec: ExecutionSpec) => Promise<string>>

export function playgroundRuntimeCommandIds(): string[] {
  return Object.keys(playgroundCommandHandlers)
}

export async function executePlaygroundCommand(runtime: PlaygroundCommandRuntime, spec: ExecutionSpec): Promise<string> {
  const definition = getCommandDefinition(spec.command)
  if (definition?.handler.kind === "playground") {
    const handler = playgroundCommandHandlers[definition.id as PlaygroundRuntimeCommandId]
    if (handler) {
      return handler(runtime, spec)
    }
  }

  throw new Error(`No Playground command handler is registered for: ${spec.command}`)
}
