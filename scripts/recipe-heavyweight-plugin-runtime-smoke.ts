import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-heavy-plugin-runtime-"))

try {
  const pluginSource = join(workspace, "heavy-runtime-plugin")
  await mkdir(pluginSource, { recursive: true })
  await writeFile(join(pluginSource, "heavy-runtime-plugin.php"), `<?php
/**
 * Plugin Name: Heavy Runtime Fixture
 * Description: Representative plugin stack fixture for WP Codebox runtime recipes.
 */

defined( 'ABSPATH' ) || exit;

register_activation_hook( __FILE__, static function (): void {
	update_option( 'wp_codebox_heavy_runtime_activated', 'yes' );
} );

add_action( 'init', static function (): void {
	update_option( 'wp_codebox_heavy_runtime_loaded', 'yes' );
} );
`)

  const recipePath = join(workspace, "recipe.json")
  const artifacts = join(workspace, "artifacts")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    inputs: {
      extraPlugins: [
        {
          source: "./heavy-runtime-plugin",
          slug: "heavy-runtime-plugin",
          pluginFile: "heavy-runtime-plugin/heavy-runtime-plugin.php",
        },
      ],
      pluginRuntime: {
        label: "representative-heavy-plugin-stack",
        php: { memoryLimit: "256M", maxExecutionTime: 120 },
        wpConfigDefines: { WP_CODEBOX_HEAVY_RUNTIME_TEST: true },
        setup: [
          { command: "wordpress.wp-cli", args: ["command=option update wp_codebox_heavy_runtime_setup yes"] },
        ],
        healthProbes: [
          { name: "plugin-active", type: "plugin-active", pluginFile: "heavy-runtime-plugin/heavy-runtime-plugin.php" },
          {
            name: "runtime-config",
            type: "php",
            code: "if (!defined('WP_CODEBOX_HEAVY_RUNTIME_TEST') || true !== WP_CODEBOX_HEAVY_RUNTIME_TEST) { throw new RuntimeException('runtime define missing'); } echo wp_json_encode(array('ok' => true, 'memory_limit' => ini_get('memory_limit')));",
          },
          { name: "setup-option", type: "wp-cli", command: "option get wp_codebox_heavy_runtime_setup" },
        ],
      },
    },
    workflow: {
      steps: [
        {
          command: "wordpress.run-php",
          args: ["code=echo wp_json_encode(array('activated' => get_option('wp_codebox_heavy_runtime_activated'), 'loaded' => get_option('wp_codebox_heavy_runtime_loaded'), 'setup' => get_option('wp_codebox_heavy_runtime_setup')));"],
        },
      ],
    },
    artifacts: { directory: artifacts, verify: true },
  }, null, 2)}\n`)

  const dryRun = await recipeRun(recipePath, true)
  assert.equal(dryRun.schema, "wp-codebox/recipe-run-dry-run/v1")
  assert.equal(dryRun.plan.pluginRuntime.label, "representative-heavy-plugin-stack")
  assert.equal(dryRun.plan.pluginRuntime.setup.length, 1)
  assert.equal(dryRun.plan.pluginRuntime.healthProbes.length, 3)
  assert.equal(dryRun.plan.pluginRuntime.healthProbes[0].resolvedCommand, "wordpress.run-php")
  assert.equal(dryRun.plan.pluginRuntime.healthProbes[2].resolvedCommand, "wordpress.wp-cli")

  const result = await recipeRun(recipePath, false)
  assert.equal(result.success, true, result.error?.message)
  assert.equal(result.diagnostics, undefined)
  assert.ok(result.executions.some((execution: { recipeCommand?: string }) => execution.recipeCommand === "plugin-runtime.setup:0"))
  assert.ok(result.executions.some((execution: { recipeCommand?: string }) => execution.recipeCommand === "plugin-runtime.health:plugin-active"))
  assert.ok(result.executions.some((execution: { recipeCommand?: string }) => execution.recipeCommand === "plugin-runtime.health:runtime-config"))
  assert.ok(result.executions.some((execution: { recipeCommand?: string; stdout?: string }) => execution.recipeCommand === "plugin-runtime.health:setup-option" && execution.stdout?.trim() === "yes"))

  const workflow = JSON.parse(result.executions.at(-1).stdout)
  assert.equal(workflow.activated, "yes")
  assert.equal(workflow.loaded, "yes")
  assert.equal(workflow.setup, "yes")

  const manifest = JSON.parse(await readFile(join(result.artifacts.directory, "manifest.json"), "utf8"))
  assert.ok(manifest.files.some((file: { kind: string }) => file.kind === "run-attestation"))

  const failingRecipePath = join(workspace, "failing-recipe.json")
  await writeFile(failingRecipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    inputs: {
      extraPlugins: [
        {
          source: "./heavy-runtime-plugin",
          slug: "heavy-runtime-plugin",
          pluginFile: "heavy-runtime-plugin/heavy-runtime-plugin.php",
          activate: false,
        },
      ],
      pluginRuntime: {
        healthProbes: [
          { name: "plugin-active", type: "plugin-active", pluginFile: "heavy-runtime-plugin/heavy-runtime-plugin.php" },
        ],
      },
    },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
    artifacts: { directory: join(workspace, "failing-artifacts") },
  }, null, 2)}\n`)

  const failure = await recipeRunFailure(failingRecipePath)
  assert.equal(failure.success, false)
  assert.equal(failure.diagnostics[0].schema, "wp-codebox/plugin-runtime-diagnostic/v1")
  assert.equal(failure.diagnostics[0].phase, "health-probe")
  assert.match(failure.diagnostics[0].message, /plugin runtime health probe|plugin is not active/i)

  console.log("Recipe heavyweight plugin runtime smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function recipeRun(recipePath: string, dryRun: boolean): Promise<any> {
  const args = ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"]
  if (dryRun) {
    args.push("--dry-run")
  }
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: root, maxBuffer: 1024 * 1024 * 10 })
  return JSON.parse(stdout)
}

async function recipeRunFailure(recipePath: string): Promise<any> {
  try {
    return await recipeRun(recipePath, false)
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    assert.ok(failed.stdout, failed.stderr)
    return JSON.parse(failed.stdout)
  }
}
