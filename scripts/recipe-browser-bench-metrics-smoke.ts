import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "recipe-browser-bench-metrics-smoke")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
      {
        source: resolve(repoRoot, "examples", "bench-plugin"),
        slug: "bench-plugin",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-probe",
        args: [
          "url=/",
          "wait-for=load",
          "capture=performance,memory",
          "script=document.body.appendChild(document.createElement('iframe'));",
        ],
      },
      {
        command: "wordpress.bench",
        args: [
          "component-id=bench-plugin",
          "plugin-slug=bench-plugin",
          "iterations=1",
          "warmup=0",
        ],
      },
    ],
  },
  artifacts: {
    directory: artifactsRoot,
  },
}, null, 2)}\n`)

const output = await runCli([
  "packages/cli/dist/index.js",
  "recipe-run",
  "--recipe",
  recipePath,
  "--json",
])

assert.equal(output.success, true, output.error?.message ?? "recipe-run failed")
assert.ok(output.benchResults, "recipe-run should expose benchResults")
assert.equal(output.benchResults.scenarios.length, 1)

const metrics = output.benchResults.scenarios[0].metrics
assert.ok(metrics.browser_checkpoint_count >= 3, "browser_checkpoint_count should include probe checkpoints")
assert.ok(metrics.browser_dom_node_count > 0, "browser_dom_node_count should be numeric")
assert.equal(metrics.browser_iframe_count, 1)
assert.ok(metrics.browser_resource_count >= 0, "browser_resource_count should be numeric")
assert.ok(metrics.browser_transfer_size_bytes >= 0, "browser_transfer_size_bytes should be numeric")
assert.ok(metrics.browser_long_task_count >= 0, "browser_long_task_count should be numeric")
assert.ok(metrics.browser_long_task_total_ms >= 0, "browser_long_task_total_ms should be numeric")
assert.ok(metrics.browser_peak_used_js_heap_bytes >= 0, "browser_peak_used_js_heap_bytes should be numeric")
assert.ok(metrics.browser_final_used_js_heap_bytes >= 0, "browser_final_used_js_heap_bytes should be numeric")

const artifactDirectory = output.artifacts.directory
const performancePath = join(artifactDirectory, "files", "browser", "performance.json")
const checkpointsPath = join(artifactDirectory, "files", "browser", "checkpoints.jsonl")
assert.equal(existsSync(performancePath), true, "performance.json should remain available")
assert.equal(existsSync(checkpointsPath), true, "checkpoints.jsonl should remain available")

const performance = JSON.parse(await readFile(performancePath, "utf8"))
assert.equal(performance.schema, "wp-codebox/browser-performance/v1")
assert.ok(performance.checkpoints.length >= 3, "performance artifact should include probe checkpoints")
assert.match(await readFile(checkpointsPath, "utf8"), /"name":"after-navigation"/)

console.log(`Recipe browser bench metrics smoke passed: ${artifactDirectory}`)

async function runCli(args: string[]): Promise<any> {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)))
  assert.equal(exitCode, 0, `CLI exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  return JSON.parse(stdout)
}
