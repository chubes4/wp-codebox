import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { normalizePluginCheckOutput } from "../packages/runtime-playground/src/commands.js"

const execFileAsync = promisify(execFile)

const raw = JSON.stringify({
  errors: {
    "simple-plugin/simple-plugin.php": [[{
      code: "plugin_header_missing",
      message: "Plugin header is missing.",
      line: 1,
      column: 1,
      docs: "https://developer.wordpress.org/plugins/",
    }]],
  },
  warnings: {
    "simple-plugin/simple-plugin.php": [[{
      code: "escaping_missing",
      message: "Output should be escaped.",
      line: "12",
    }]],
  },
})

const normalized = normalizePluginCheckOutput(raw, 1, "simple-plugin")
assert.equal(normalized.schema, "wp-codebox/plugin-check/v1")
assert.equal(normalized.command, "wordpress.plugin-check")
assert.equal(normalized.targetPlugin, "simple-plugin")
assert.equal(normalized.exitCode, 1)
assert.equal(normalized.status, "failed")
assert.deepEqual(normalized.summary, { total: 2, errors: 1, warnings: 1, notices: 0, info: 0, unknown: 0 })
assert.equal(normalized.findings[0].file, "simple-plugin/simple-plugin.php")
assert.equal(normalized.findings[0].type, "error")
assert.equal(normalized.findings[0].line, 1)
assert.equal(normalized.findings[1].type, "warning")
assert.equal(normalized.findings[1].line, 12)

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-plugin-check-"))
try {
  const cliPath = resolve("packages/cli/dist/index.js")
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "run",
    "--mount",
    "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
    "--command",
    "wordpress.plugin-check",
    "--arg",
    "plugin-slug=simple-plugin",
    "--arg",
    "checks=plugin_header_fields",
    "--artifacts",
    artifactsDirectory,
    "--json",
  ], { cwd: resolve("."), maxBuffer: 10 * 1024 * 1024 })
  const runOutput = JSON.parse(stdout)
  assert.equal(runOutput.success, true)
  const output = JSON.parse(runOutput.execution.stdout)
  assert.equal(output.schema, "wp-codebox/plugin-check/v1")
  assert.equal(output.status, "failed")
  assert.equal(output.summary.errors, 1)
  assert.equal(output.findings[0].code, "plugin_header_no_license")
  const manifest = JSON.parse(await readFile(runOutput.artifacts.manifestPath, "utf8"))
  assert.equal(manifest.files.some((file: { kind: string }) => file.kind === "plugin-check"), true)
  console.log("Plugin Check normalization smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
