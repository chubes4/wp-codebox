import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const workspace = resolve(repoRoot, "artifacts", "browser-probe-artifact-smoke")
const pluginDir = join(workspace, "browser-error-fixture")
const recipePath = join(workspace, "recipe.json")
const artifactsRoot = join(workspace, "artifacts")

await rm(workspace, { recursive: true, force: true })
await mkdir(pluginDir, { recursive: true })

await writeFile(join(pluginDir, "browser-error-fixture.php"), `<?php
/**
 * Plugin Name: Browser Error Fixture
 */
add_action('wp_footer', function () {
    echo '<script>console.error("wp-codebox fixture console error"); setTimeout(function () { throw new Error("wp-codebox fixture browser error"); }, 0);</script>';
});
`)

await writeFile(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    extraPlugins: [
      {
        source: "./browser-error-fixture",
        pluginFile: "browser-error-fixture/browser-error-fixture.php",
        activate: true,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.browser-probe",
        args: ["url=/", "wait-for=load", "duration=1s", "capture=console,errors,screenshot"],
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
const consolePath = join(artifactDirectory, "files", "browser", "console.jsonl")
const errorsPath = join(artifactDirectory, "files", "browser", "errors.jsonl")
const screenshotPath = join(artifactDirectory, "files", "browser", "screenshot.png")
const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(consolePath), true, "console.jsonl should be captured")
assert.equal(existsSync(errorsPath), true, "errors.jsonl should be captured")
assert.equal(existsSync(screenshotPath), true, "screenshot.png should be captured")
assert.equal(existsSync(summaryPath), true, "summary.json should be captured")

const consoleLog = await readFile(consolePath, "utf8")
const errorLog = await readFile(errorsPath, "utf8")
assert.match(consoleLog, /wp-codebox fixture console error/)
assert.match(errorLog, /wp-codebox fixture browser error/)

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/console.jsonl" && file.kind === "browser-console"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/errors.jsonl" && file.kind === "browser-errors"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/screenshot.png" && file.kind === "browser-screenshot"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ consoleMessages: number; errors: number }> } }
assert.ok(review.browser?.probes?.[0], "review should include browser probe summary")
assert.ok(review.browser.probes[0].consoleMessages >= 1, "review should count console messages")
assert.ok(review.browser.probes[0].errors >= 1, "review should count browser errors")

console.log(`Browser probe artifact smoke passed: ${artifactDirectory}`)

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
