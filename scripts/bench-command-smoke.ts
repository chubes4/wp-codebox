import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const component = resolve(root, "examples/bench-plugin")
const artifacts = resolve(root, "artifacts/bench-command-smoke")

const result = spawnSync(process.execPath, [
  cli,
  "bench-run",
  "--component",
  component,
  "--component-id",
  "bench-plugin",
  "--iterations",
  "2",
  "--warmup",
  "1",
  "--artifacts",
  artifacts,
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)

const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.schema, "wp-codebox/bench-run/v1")
assert.equal(output.execution.command, "wordpress.bench")
assert.equal(output.benchResults.component_id, "bench-plugin")
assert.equal(output.benchResults.iterations, 2)
assert.equal(output.benchResults.scenarios.length, 1)

const scenario = output.benchResults.scenarios[0]
assert.equal(scenario.id, "noop")
assert.equal(scenario.file, "tests/bench/noop.php")
assert.equal(scenario.iterations, 2)
assert.equal(scenario.metrics.fixture_value_mean, 7)
assert.equal(scenario.metadata.fixture, "bench-plugin")
assert.ok(output.artifacts?.directory)

console.log("bench command smoke passed")
