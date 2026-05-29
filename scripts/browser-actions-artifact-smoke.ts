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
          `actions-json=${JSON.stringify([
            { type: "navigate", url: "/", waitFor: "load" },
            { type: "fill", selector: "#wp-codebox-name", value: "Runtime" },
            { type: "click", selector: "#wp-codebox-button" },
            { type: "wait", selector: '#wp-codebox-result[data-state="done"]' },
          ])}`,
          "capture=actions,console,errors,html,network,screenshot",
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
const actionsPath = join(artifactDirectory, "files", "browser", "actions.jsonl")
const consolePath = join(artifactDirectory, "files", "browser", "console.jsonl")
const htmlPath = join(artifactDirectory, "files", "browser", "snapshot.html")
const summaryPath = join(artifactDirectory, "files", "browser", "action-summary.json")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(actionsPath), true, "actions.jsonl should be captured")
assert.equal(existsSync(consolePath), true, "console.jsonl should be captured")
assert.equal(existsSync(htmlPath), true, "snapshot.html should be captured")
assert.equal(existsSync(summaryPath), true, "action-summary.json should be captured")

const actionLog = await readFile(actionsPath, "utf8")
const consoleLog = await readFile(consolePath, "utf8")
const htmlSnapshot = await readFile(htmlPath, "utf8")
assert.match(actionLog, /"type":"navigate"/)
assert.match(actionLog, /"type":"fill"/)
assert.match(actionLog, /"type":"click"/)
assert.match(actionLog, /"type":"wait"/)
assert.match(consoleLog, /wp-codebox browser action completed/)
assert.match(htmlSnapshot, /Hello Runtime/)

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  schema: string
  finalUrl: string
  files: { actions?: string; html?: string; screenshot?: string; summary: string }
  summary: { actions: number; replayability: string; htmlSnapshot: boolean }
}
assert.equal(summary.schema, "wp-codebox/browser-actions/v1")
assert.equal(summary.finalUrl.endsWith("/"), true, "summary should include final URL")
assert.equal(summary.files.actions, "files/browser/actions.jsonl")
assert.equal(summary.files.html, "files/browser/snapshot.html")
assert.equal(summary.files.summary, "files/browser/action-summary.json")
assert.equal(summary.summary.actions, 4)
assert.equal(summary.summary.replayability, "artifact-backed")
assert.equal(summary.summary.htmlSnapshot, true)

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/actions.jsonl" && file.kind === "browser-actions"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/action-summary.json" && file.kind === "browser-summary"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ actions?: string; actionCount?: number; html?: string; summaryFile?: string }> } }
assert.equal(review.browser?.probes?.[0]?.actions, "files/browser/actions.jsonl")
assert.equal(review.browser?.probes?.[0]?.actionCount, 4)
assert.equal(review.browser?.probes?.[0]?.html, "files/browser/snapshot.html")
assert.equal(review.browser?.probes?.[0]?.summaryFile, "files/browser/action-summary.json")

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
