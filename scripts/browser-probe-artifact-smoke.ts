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
        args: [
          "url=/",
          "wait-for=load",
          "duration=1s",
          "capture=console,errors,html,network,performance,memory,screenshot",
          "script=console.info('wp-codebox fixture browser script'); return { title: document.title, hasBody: !!document.body };",
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
const consolePath = join(artifactDirectory, "files", "browser", "console.jsonl")
const checkpointsPath = join(artifactDirectory, "files", "browser", "checkpoints.jsonl")
const errorsPath = join(artifactDirectory, "files", "browser", "errors.jsonl")
const htmlPath = join(artifactDirectory, "files", "browser", "snapshot.html")
const memoryPath = join(artifactDirectory, "files", "browser", "memory.json")
const networkPath = join(artifactDirectory, "files", "browser", "network.jsonl")
const performancePath = join(artifactDirectory, "files", "browser", "performance.json")
const screenshotPath = join(artifactDirectory, "files", "browser", "screenshot.png")
const summaryPath = join(artifactDirectory, "files", "browser", "summary.json")
const manifestPath = join(artifactDirectory, "manifest.json")
const reviewPath = join(artifactDirectory, "files", "review.json")

assert.equal(existsSync(consolePath), true, "console.jsonl should be captured")
assert.equal(existsSync(checkpointsPath), true, "checkpoints.jsonl should be captured")
assert.equal(existsSync(errorsPath), true, "errors.jsonl should be captured")
assert.equal(existsSync(htmlPath), true, "snapshot.html should be captured")
assert.equal(existsSync(memoryPath), true, "memory.json should be captured")
assert.equal(existsSync(networkPath), true, "network.jsonl should be captured")
assert.equal(existsSync(performancePath), true, "performance.json should be captured")
assert.equal(existsSync(screenshotPath), true, "screenshot.png should be captured")
assert.equal(existsSync(summaryPath), true, "summary.json should be captured")

const consoleLog = await readFile(consolePath, "utf8")
const errorLog = await readFile(errorsPath, "utf8")
const htmlSnapshot = await readFile(htmlPath, "utf8")
const networkLog = await readFile(networkPath, "utf8")
const checkpointsLog = await readFile(checkpointsPath, "utf8")
assert.match(consoleLog, /wp-codebox fixture console error/)
assert.match(consoleLog, /wp-codebox fixture browser script/)
assert.match(errorLog, /wp-codebox fixture browser error/)
assert.match(htmlSnapshot, /Browser Error Fixture|wp-codebox fixture console error/)
assert.match(networkLog, /"type":"response"/)
assert.match(checkpointsLog, /"schema":"wp-codebox\/browser-checkpoint\/v1"/)

const memory = JSON.parse(await readFile(memoryPath, "utf8")) as { schema: string; final: { domCounters: { nodes: number | null } }; peak: { domNodes: { final: number | null; peak: number | null } }; checkpoints: unknown[] }
const performance = JSON.parse(await readFile(performancePath, "utf8")) as { schema: string; final: { resources: { count: number }; dom: { nodes: number } }; peak: { resources: number; domNodes: { final: number | null; peak: number | null } }; checkpoints: unknown[] }
assert.equal(memory.schema, "wp-codebox/browser-memory/v1")
assert.ok((memory.final.domCounters.nodes ?? memory.peak.domNodes.final ?? 0) > 0, "memory artifact should include DOM node counts")
assert.ok(memory.checkpoints.length >= 1, "memory artifact should include checkpoints")
assert.equal(performance.schema, "wp-codebox/browser-performance/v1")
assert.ok(performance.final.resources.count >= 1, "performance artifact should include resource counts")
assert.ok(performance.final.dom.nodes > 0, "performance artifact should include DOM node counts")
assert.ok(performance.checkpoints.length >= 1, "performance artifact should include checkpoints")

const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
  requestedUrl: string
  finalUrl: string
  files: { checkpoints?: string; html?: string; memory?: string; network?: string; performance?: string; screenshot?: string }
  hashes: { html?: { value: string }; screenshot?: { value: string } }
  viewport: { width: number; height: number; userAgent: string }
  summary: {
    replayability: string
    networkEvents: number
    htmlSnapshot: boolean
    scriptResult?: { title?: string; hasBody?: boolean }
    memory?: { usedJSHeapSize: { final: number | null; peak: number | null }; domNodes: { final: number | null; peak: number | null } }
    performance?: { resources: number; domNodes: { final: number | null; peak: number | null }; longTasks: number }
  }
}
assert.equal(summary.requestedUrl.endsWith("/"), true, "summary should include requested URL")
assert.equal(summary.finalUrl.endsWith("/"), true, "summary should include final URL")
assert.equal(summary.files.html, "files/browser/snapshot.html")
assert.equal(summary.files.checkpoints, "files/browser/checkpoints.jsonl")
assert.equal(summary.files.memory, "files/browser/memory.json")
assert.equal(summary.files.network, "files/browser/network.jsonl")
assert.equal(summary.files.performance, "files/browser/performance.json")
assert.match(summary.hashes.html?.value ?? "", /^[a-f0-9]{64}$/)
assert.match(summary.hashes.screenshot?.value ?? "", /^[a-f0-9]{64}$/)
assert.equal(summary.summary.replayability, "artifact-backed")
assert.equal(summary.summary.htmlSnapshot, true)
assert.equal(summary.summary.scriptResult?.title, "My WordPress Website")
assert.equal(summary.summary.scriptResult?.hasBody, true)
assert.ok(summary.summary.networkEvents >= 1, "summary should count network events")
assert.ok((summary.summary.memory?.domNodes.final ?? 0) > 0, "summary should include memory DOM node counts")
assert.ok((summary.summary.performance?.resources ?? 0) >= 1, "summary should include performance resource counts")
assert.ok((summary.summary.performance?.domNodes.final ?? 0) > 0, "summary should include performance DOM node counts")
assert.ok(summary.viewport.width > 0, "summary should include viewport width")
assert.ok(summary.viewport.height > 0, "summary should include viewport height")
assert.ok(summary.viewport.userAgent.length > 0, "summary should include user agent")

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; kind: string }> }
assert.ok(manifest.files.some((file) => file.path === "files/browser/console.jsonl" && file.kind === "browser-console"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/checkpoints.jsonl" && file.kind === "browser-checkpoints"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/errors.jsonl" && file.kind === "browser-errors"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/snapshot.html" && file.kind === "browser-html-snapshot"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/memory.json" && file.kind === "browser-memory"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/network.jsonl" && file.kind === "browser-network"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/performance.json" && file.kind === "browser-performance"))
assert.ok(manifest.files.some((file) => file.path === "files/browser/screenshot.png" && file.kind === "browser-screenshot"))

const review = JSON.parse(await readFile(reviewPath, "utf8")) as { browser?: { probes?: Array<{ consoleMessages: number; errors: number; checkpoints?: string; html?: string; memory?: string; network?: string; performance?: string; finalUrl?: string; replayability?: string }> } }
assert.ok(review.browser?.probes?.[0], "review should include browser probe summary")
assert.ok(review.browser.probes[0].consoleMessages >= 1, "review should count console messages")
assert.ok(review.browser.probes[0].errors >= 1, "review should count browser errors")
assert.equal(review.browser.probes[0].html, "files/browser/snapshot.html")
assert.equal(review.browser.probes[0].checkpoints, "files/browser/checkpoints.jsonl")
assert.equal(review.browser.probes[0].memory, "files/browser/memory.json")
assert.equal(review.browser.probes[0].network, "files/browser/network.jsonl")
assert.equal(review.browser.probes[0].performance, "files/browser/performance.json")
assert.equal(review.browser.probes[0].replayability, "artifact-backed")
assert.equal(review.browser.probes[0].finalUrl?.endsWith("/"), true, "review should include final URL")

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
