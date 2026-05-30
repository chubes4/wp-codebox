import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-actions-artifact-smoke")
const pluginDir = join(workspace, "browser-action-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "browser-action-fixture.php"), `<?php
/**
 * Plugin Name: Browser Action Fixture
 */
add_action('wp_footer', function () {
    echo '<label for="wp-codebox-name">Name</label><input id="wp-codebox-name" value=""><button id="wp-codebox-button" type="button">Apply</button><p id="wp-codebox-result" data-state="idle"></p><script>document.getElementById("wp-codebox-button").addEventListener("click", function () { var value = document.getElementById("wp-codebox-name").value; var result = document.getElementById("wp-codebox-result"); result.dataset.state = "done"; result.textContent = "Hello " + value; console.log("wp-codebox browser action completed"); });</script>';
});
`)

// Exercise the full interaction-script contract: an ordered multi-step script that
// drives the UI (fill + click), waits, asserts browser behavior (expect + evaluate
// with a deep-equal assert), and captures a named screenshot. evaluate is the
// policy-gated escape hatch — the recipe auto-grants wordpress.browser-actions.evaluate
// because the script includes an evaluate step.
await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
      {
        source: "./browser-action-fixture",
        pluginFile: "browser-action-fixture/browser-action-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-actions",
        args: [
          "url=/",
          `steps-json=${JSON.stringify([
            { kind: "waitFor", selector: "#wp-codebox-button" },
            { kind: "fill", selector: "#wp-codebox-name", value: "Runtime" },
            { kind: "click", selector: "#wp-codebox-button" },
            { kind: "waitFor", selector: '#wp-codebox-result[data-state="done"]' },
            { kind: "expect", selector: "#wp-codebox-result", state: "visible" },
            { kind: "evaluate", expression: "document.getElementById('wp-codebox-result').dataset.state", assert: "done" },
            { kind: "screenshot", name: "after-apply" },
          ])}`,
          "capture=steps,console,errors,html,network,screenshot",
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
assert.ok(output.artifacts?.directory, "recipe-run should return an artifact directory")

const artifactDirectory = output.artifacts.directory
const stepsPath = join(artifactDirectory, "files", "browser", "steps.jsonl")
const consolePath = join(artifactDirectory, "files", "browser", "console.jsonl")
const htmlPath = join(artifactDirectory, "files", "browser", "snapshot.html")
const summaryPath = join(artifactDirectory, "files", "browser", "action-summary.json")
const namedScreenshotPath = join(artifactDirectory, "files", "browser", "screenshot-after-apply.png")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(stepsPath), true, "steps.jsonl should be captured")
assert.equal(existsSync(consolePath), true, "console.jsonl should be captured")
assert.equal(existsSync(htmlPath), true, "snapshot.html should be captured")
assert.equal(existsSync(summaryPath), true, "action-summary.json should be captured")
assert.equal(existsSync(namedScreenshotPath), true, "named screenshot should be captured")

const stepsLog = await readFile(stepsPath, "utf8")
const consoleLog = await readFile(consolePath, "utf8")
const htmlSnapshot = await readFile(htmlPath, "utf8")
assert.match(stepsLog, /"kind":"fill"/)
assert.match(stepsLog, /"kind":"click"/)
assert.match(stepsLog, /"kind":"expect"/)
assert.match(stepsLog, /"kind":"evaluate"/)
assert.match(stepsLog, /"kind":"screenshot"/)
assert.match(stepsLog, /"durationMs":/)
assert.match(consoleLog, /wp-codebox browser action completed/)
assert.match(htmlSnapshot, /Hello Runtime/)

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  schema: string
  finalUrl: string
  files: { steps?: string; html?: string; screenshot?: string; summary: string }
  assertions?: { total: number; passed: number; failed: number; results: Array<{ kind: string; passed: boolean }> }
  summary: { steps: number; actions: number; replayability: string; htmlSnapshot: boolean; assertions?: { total: number; passed: number; failed: number } }
}
assert.equal(summary.schema, "wp-codebox/browser-actions/v1")
assert.equal(summary.finalUrl.endsWith("/"), true, "summary should include final URL")
assert.equal(summary.files.steps, "files/browser/steps.jsonl")
assert.equal(summary.files.html, "files/browser/snapshot.html")
assert.equal(summary.files.summary, "files/browser/action-summary.json")
assert.equal(summary.summary.steps, 8)
assert.equal(summary.summary.replayability, "artifact-backed")
assert.equal(summary.summary.htmlSnapshot, true)

// Machine-readable assertions: an expect + an evaluate(assert), both passing.
assert.ok(summary.assertions, "summary should include an assertions block")
assert.equal(summary.assertions.total, 2)
assert.equal(summary.assertions.passed, 2)
assert.equal(summary.assertions.failed, 0)
assert.ok(summary.assertions.results.some((result) => result.kind === "expect" && result.passed))
assert.ok(summary.assertions.results.some((result) => result.kind === "evaluate" && result.passed))
assert.equal(summary.summary.assertions?.total, 2)
assert.equal(summary.summary.assertions?.passed, 2)

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/steps.jsonl" && file.kind === "browser-steps"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/action-summary.json" && file.kind === "browser-summary"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ steps?: string; stepCount?: number; html?: string; summaryFile?: string; assertions?: { total: number; passed: number; failed: number } }> } }
assert.equal(review.browser?.probes?.[0]?.steps, "files/browser/steps.jsonl")
assert.equal(review.browser?.probes?.[0]?.stepCount, 8)
assert.equal(review.browser?.probes?.[0]?.html, "files/browser/snapshot.html")
assert.equal(review.browser?.probes?.[0]?.summaryFile, "files/browser/action-summary.json")
assert.equal(review.browser?.probes?.[0]?.assertions?.total, 2)
assert.equal(review.browser?.probes?.[0]?.assertions?.passed, 2)

console.log(`Browser actions artifact smoke passed: ${artifactDirectory}`)

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
