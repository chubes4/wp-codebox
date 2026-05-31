import type { BrowserProbeArtifact } from "./browser-artifacts.js"
import { promoteBrowserMetricsToBenchResults } from "./browser-metrics.js"
import { writePluginCheckArtifacts, writeThemeCheckArtifacts, type PluginCheckArtifact, type ThemeCheckArtifact } from "./check-artifacts.js"
import {
  abilityInputFromArgs,
  abilityPhpCode,
  argValue,
  benchRunCode,
  booleanArg,
  cleanWpCliOutput,
  commaListArg,
  CORE_PHPUNIT_RESULT_FILE,
  corePhpunitRunCode,
  jsonArrayArg,
  jsonObjectArg,
  nonNegativeIntegerArg,
  normalizePhpCode,
  normalizePluginCheckOutput,
  normalizeThemeCheckOutput,
  phpunitRunCode,
  positiveIntegerArg,
  themeCheckRunCode,
} from "./commands.js"
import { bootstrapAbilityPhpCode, bootstrapPhpCode, phpCodeFromArgs } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { persistCorePhpunitResult, persistVfsDiagnosticFile, readCorePhpunitDiagnostic } from "./runtime-diagnostics.js"
import type { RuntimeWpCliBridge } from "./runtime-wp-cli-bridge.js"
import type { ExecutionSpec, MountSpec, RuntimeCreateSpec } from "@chubes4/wp-codebox-core"

type RunPlaygroundCommand = (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
type RunWpCliCommand = (server: PlaygroundCliServer, argv: string[]) => Promise<PlaygroundRunResponse>
type CreateRuntimeWpCliBridge = (server: PlaygroundCliServer) => Promise<RuntimeWpCliBridge>

export async function runPhpCommand({
  createRuntimeWpCliBridge,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  createRuntimeWpCliBridge: CreateRuntimeWpCliBridge
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const code = await phpCodeFromArgs(spec.args ?? [])
  const bridge = argValue(spec.args ?? [], "wp-cli-bridge") === "1" ? await createRuntimeWpCliBridge(server) : undefined
  let response: PlaygroundRunResponse
  try {
    response = await runPlaygroundCommand("wordpress.run-php", server, { code: bootstrapPhpCode(runtimeSpec, code, spec.args ?? [], bridge) })
    assertPlaygroundResponseOk("wordpress.run-php", response)
  } finally {
    if (bridge) {
      await bridge.close()
    }
  }

  return response.text
}

export async function runPluginCheckCommand({
  artifactRoot,
  runWpCliCommand,
  server,
  spec,
}: {
  artifactRoot: string
  runWpCliCommand: RunWpCliCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: PluginCheckArtifact; output: string }> {
  const args = spec.args ?? []
  const pluginSlug = argValue(args, "plugin-slug")?.trim()
  if (!pluginSlug) {
    throw new Error("wordpress.plugin-check requires plugin-slug=<slug>")
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pluginSlug)) {
    throw new Error("wordpress.plugin-check plugin-slug must be a WordPress plugin slug")
  }
  const checkSlugs = commaListArg(args, "checks")

  if (!server.playground.writeFile) {
    throw new Error("wordpress.plugin-check requires a Playground backend with writeFile support")
  }

  const pluginPath = `/wordpress/wp-content/plugins/${pluginSlug}`
  const existsResponse = await runWpCliCommand(server, ["plugin", "path", pluginSlug])
  if (existsResponse.exitCode !== 0) {
    throw new Error(`wordpress.plugin-check target plugin is not installed or mounted at ${pluginPath}`)
  }

  const rawResponse = await runWpCliCommand(server, [
    "plugin",
    "check",
    pluginSlug,
    "--format=strict-json",
    "--fields=file,line,column,type,code,message,docs",
    "--mode=new",
    ...(checkSlugs.length > 0 ? [`--checks=${checkSlugs.join(",")}`] : []),
  ])
  const rawOutput = cleanWpCliOutput(rawResponse.text)
  const normalized = normalizePluginCheckOutput(rawOutput, rawResponse.exitCode ?? 0, pluginSlug)

  return {
    artifact: await writePluginCheckArtifacts(artifactRoot, pluginSlug, rawOutput, normalized),
    output: `${JSON.stringify(normalized, null, 2)}\n`,
  }
}

export async function runThemeCheckCommand({
  artifactRoot,
  runPlaygroundCommand,
  runWpCliArgv,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  runPlaygroundCommand: RunPlaygroundCommand
  runWpCliArgv: RunWpCliCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: ThemeCheckArtifact; output: string }> {
  const args = spec.args ?? []
  const theme = argValue(args, "theme")?.trim()
  if (!theme) {
    throw new Error("wordpress.theme-check requires theme=<slug>")
  }

  if (!server.playground.writeFile) {
    throw new Error("wordpress.theme-check requires a Playground backend with writeFile support")
  }

  if (!await themeCheckPluginInstalled(runPlaygroundCommand, server)) {
    const install = await runWpCliArgv(server, ["plugin", "install", "theme-check"])
    assertPlaygroundResponseOk("wordpress.theme-check", install)
  }

  const response = await runPlaygroundCommand("wordpress.theme-check", server, { code: bootstrapPhpCode(runtimeSpec, themeCheckRunCode(theme), []) })
  assertPlaygroundResponseOk("wordpress.theme-check", response)
  const raw = cleanWpCliOutput(response.text)
  const normalized = normalizeThemeCheckOutput(raw, response.exitCode ?? 0, theme)

  return {
    artifact: await writeThemeCheckArtifacts(artifactRoot, theme, raw, normalized),
    output: `${JSON.stringify(normalized, null, 2)}\n`,
  }
}

export async function runAbilityCommand({
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const name = argValue(spec.args ?? [], "name")?.trim()
  if (!name) {
    throw new Error("wordpress.ability requires name=<ability-name>")
  }

  const input = abilityInputFromArgs(spec.args ?? [])
  const response = await runPlaygroundCommand("wordpress.ability", server, { code: bootstrapAbilityPhpCode(runtimeSpec, abilityPhpCode(name, input)) })
  assertPlaygroundResponseOk("wordpress.ability", response)
  return response.text
}

export async function runBenchCommand({
  browserProbes,
  createRuntimeWpCliBridge,
  runPlaygroundCommand,
  runtimeSpec,
  server,
  spec,
}: {
  browserProbes: BrowserProbeArtifact[]
  createRuntimeWpCliBridge: CreateRuntimeWpCliBridge
  runPlaygroundCommand: RunPlaygroundCommand
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const args = spec.args ?? []
  const pluginSlug = argValue(args, "plugin-slug")?.trim()
  if (!pluginSlug) {
    throw new Error("wordpress.bench requires plugin-slug=<slug>")
  }

  const componentId = argValue(args, "component-id")?.trim() || pluginSlug
  const iterations = positiveIntegerArg(args, "iterations", 3)
  const warmupIterations = nonNegativeIntegerArg(args, "warmup", 1)
  const dependencySlugs = commaListArg(args, "dependency-slugs")
  const env = jsonObjectArg(args, "env-json")
  const workloads = jsonArrayArg(args, "workloads-json")
  const bridge = benchWorkloadsUseWpCli(workloads) ? await createRuntimeWpCliBridge(server) : undefined
  let response: PlaygroundRunResponse
  try {
    response = await runPlaygroundCommand("wordpress.bench", server, {
      code: bootstrapPhpCode(runtimeSpec, benchRunCode({ componentId, pluginSlug, iterations, warmupIterations, dependencySlugs, env, workloads, wpCliBridge: bridge }), []),
    })
    assertPlaygroundResponseOk("wordpress.bench", response)
  } finally {
    if (bridge) {
      await bridge.close()
    }
  }

  return promoteBrowserMetricsToBenchResults(response.text, browserProbes)
}

export async function runPhpunitCommand({
  mounts,
  runPlaygroundCommand,
  server,
  spec,
}: {
  mounts: MountSpec[]
  runPlaygroundCommand: RunPlaygroundCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const args = spec.args ?? []
  const explicitCode = argValue(args, "code") || argValue(args, "code-file")
  const pluginSlug = argValue(args, "plugin-slug")?.trim() || ""
  const code = explicitCode ? await phpCodeFromArgs(args, "wordpress.phpunit") : normalizePhpCode(phpunitRunCode({
    pluginSlug,
    autoloadFile: argValue(args, "autoload-file")?.trim() || "/wp-codebox-vendor/autoload.php",
    testsDir: argValue(args, "tests-dir")?.trim() || "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
    phpunitXml: argValue(args, "phpunit-xml")?.trim() || `/wordpress/wp-content/plugins/${pluginSlug}/phpunit.xml.dist`,
    selectedTestFile: argValue(args, "test-file")?.trim() || "",
    changedTestFiles: jsonArrayArg(args, "changed-tests-json"),
    env: jsonObjectArg(args, "env-json"),
    wpConfigDefines: jsonObjectArg(args, "wp-config-defines-json"),
    dependencyMounts: commaListArg(args, "dependency-mounts"),
    multisite: booleanArg(args, "multisite"),
  }))
  if (!explicitCode && !pluginSlug) {
    throw new Error("wordpress.phpunit requires plugin-slug=<slug> when code/code-file is not provided")
  }
  const response = await runPlaygroundCommand("wordpress.phpunit", server, { code })
  await persistVfsDiagnosticFile(server, `/wordpress/wp-content/plugins/${pluginSlug}/.pg-test-result.txt`, mounts)
  assertPlaygroundResponseOk("wordpress.phpunit", response)

  return response.text
}

export async function runCorePhpunitCommand({
  artifactRoot,
  runPlaygroundCommand,
  server,
  spec,
}: {
  artifactRoot: string
  runPlaygroundCommand: RunPlaygroundCommand
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<string> {
  const args = spec.args ?? []
  const explicitCode = argValue(args, "code") || argValue(args, "code-file")
  // Write structured diagnostics to a sandbox-internal /tmp path rather than inside
  // the (often read-only) core mount, so the result survives read-only mounts and a
  // mid-require die() in core's bootstrap.php and can be read back from the VFS (#314).
  const resultFile = CORE_PHPUNIT_RESULT_FILE
  const code = explicitCode ? await phpCodeFromArgs(args, "wordpress.core-phpunit") : normalizePhpCode(corePhpunitRunCode({
    coreRoot: argValue(args, "core-root")?.trim() || "/wordpress",
    testsDir: argValue(args, "tests-dir")?.trim() || "/wordpress/tests/phpunit",
    phpunitXml: argValue(args, "phpunit-xml")?.trim() || "/wordpress/tests/phpunit/phpunit.xml.dist",
    selectedTestFile: argValue(args, "test-file")?.trim() || "",
    changedTestFiles: jsonArrayArg(args, "changed-tests-json"),
    autoloadFile: argValue(args, "autoload-file")?.trim() || "/wordpress/vendor/autoload.php",
    wpConfigDefines: jsonObjectArg(args, "wp-config-defines-json"),
    multisite: booleanArg(args, "multisite"),
    resultFile,
  }))

  let response: PlaygroundRunResponse
  try {
    response = await runPlaygroundCommand("wordpress.core-phpunit", server, { code })
  } catch (error) {
    // Core's bootstrap can die() mid-require when the Composer test toolchain is
    // absent, which surfaces here as a PlaygroundCommandCrashError with empty
    // output. Recover the structured diagnostics the PHP shutdown handler flushed
    // to the result file and re-throw a clear, actionable error instead (#314).
    await persistCorePhpunitResult(server, resultFile, artifactRoot)
    const structured = await readCorePhpunitDiagnostic(server, resultFile)
    if (structured) {
      throw new Error(`wordpress.core-phpunit could not run: ${structured}`)
    }
    throw error
  }

  await persistCorePhpunitResult(server, resultFile, artifactRoot)
  assertPlaygroundResponseOk("wordpress.core-phpunit", response)

  return response.text
}

function benchWorkloadsUseWpCli(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(benchWorkloadsUseWpCli)
  }
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as { type?: unknown; run?: unknown }
  return record.type === "wp-cli" || benchWorkloadsUseWpCli(record.run)
}

async function themeCheckPluginInstalled(runPlaygroundCommand: RunPlaygroundCommand, server: PlaygroundCliServer): Promise<boolean> {
  const response = await runPlaygroundCommand("wordpress.theme-check", server, {
    code: "<?php echo file_exists('/wordpress/wp-content/plugins/theme-check/theme-check.php') ? 'yes' : 'no';",
  })

  return response.text.trim() === "yes"
}
