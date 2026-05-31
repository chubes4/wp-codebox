import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assertRuntimeCommandAllowed, browserInteractionScriptUsesEvaluate, type ExecutionSpec, type RuntimeCreateSpec } from "@chubes4/wp-codebox-core"
import { browserInteractionStepsFromArgs } from "./browser-actions.js"
import type { BrowserProbeArtifact, BrowserProbeCheckpointRecord, BrowserProbeErrorRecord, BrowserProbeMemoryArtifact, BrowserProbeNetworkRecord, BrowserProbePerformanceArtifact, BrowserProbeViewport, BrowserStepRecord } from "./browser-artifacts.js"
import { browserAssertionsSummary, browserStepRecord, executeBrowserInteractionStep } from "./browser-interactions.js"
import { browserProbeBenchMetrics, jsonLines, serializeBrowserConsoleMessage, serializeBrowserError, serializeBrowserFinishedRequest, serializeBrowserRequestFailure } from "./browser-metrics.js"
import { BROWSER_PROBE_CAPTURE_VALUES, BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT, browserProbeCheckpoint, browserProbeMemoryArtifact, browserProbePendingCheckpoints, browserProbePerformanceArtifact, browserProbeReplayability, browserProbeViewport, navigateBrowserProbe } from "./browser-probe.js"
import { argValue, commaListArg } from "./commands.js"
import type { PlaygroundCliServer } from "./preview-server.js"

const BROWSER_STEP_DEFAULT_TIMEOUT_MS = 15_000
const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 120_000

export async function runBrowserProbeCommand({
  artifactRoot,
  server,
  spec,
}: {
  artifactRoot: string
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const urlArg = argValue(args, "url")?.trim()
  if (!urlArg) {
    throw new Error("wordpress.browser-probe requires url=<path-or-url>")
  }

  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("console")
    capture.add("errors")
    capture.add("html")
    capture.add("network")
    capture.add("screenshot")
  }

  for (const item of capture) {
    if (!(BROWSER_PROBE_CAPTURE_VALUES as readonly string[]).includes(item)) {
      throw new Error(`wordpress.browser-probe capture supports ${BROWSER_PROBE_CAPTURE_VALUES.join(", ")}: ${item}`)
    }
  }

  const waitFor = argValue(args, "wait-for")?.trim() || "domcontentloaded"
  const durationMs = durationArg(args, "duration", 0)
  const script = argValue(args, "script")
  const capturesBrowserMetrics = capture.has("performance") || capture.has("memory")
  const targetUrl = resolveBrowserProbeUrl(urlArg, server.serverUrl)
  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const network: BrowserProbeNetworkRecord[] = []
  const networkTasks: Array<Promise<void>> = []
  const checkpoints: BrowserProbeCheckpointRecord[] = []
  const consolePath = join(browserDirectory, "console.jsonl")
  const checkpointsPath = join(browserDirectory, "checkpoints.jsonl")
  const errorsPath = join(browserDirectory, "errors.jsonl")
  const htmlPath = join(browserDirectory, "snapshot.html")
  const memoryPath = join(browserDirectory, "memory.json")
  const networkPath = join(browserDirectory, "network.jsonl")
  const performancePath = join(browserDirectory, "performance.json")
  const screenshotPath = join(browserDirectory, "screenshot.png")
  const summaryPath = join(browserDirectory, "summary.json")
  const startedAt = now()
  const { chromium } = await import("playwright")
  const browser = await chromium.launch()
  let finalUrl = targetUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let scriptResult: unknown
  let memoryArtifact: BrowserProbeMemoryArtifact | undefined
  let performanceArtifact: BrowserProbePerformanceArtifact | undefined
  let page: import("playwright").Page | null = null
  let artifact: BrowserProbeArtifact | undefined

  try {
    page = await browser.newPage()
    if (capturesBrowserMetrics) {
      await page.addInitScript(BROWSER_PROBE_PERFORMANCE_INIT_SCRIPT)
    }
    viewport = await browserProbeViewport(page)
    if (capture.has("console")) {
      page.on("console", (message) => consoleMessages.push(serializeBrowserConsoleMessage(message)))
    }
    if (capture.has("errors")) {
      page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
    }
    if (capture.has("network")) {
      page.on("requestfinished", (request) => {
        const task = serializeBrowserFinishedRequest(request).then((record) => {
          network.push(record)
        }).catch(() => undefined)
        networkTasks.push(task)
      })
      page.on("requestfailed", (request) => network.push(serializeBrowserRequestFailure(request)))
    }

    await navigateBrowserProbe(page, targetUrl, waitFor, durationMs)
    if (capturesBrowserMetrics) {
      checkpoints.push(await browserProbeCheckpoint(page, "after-navigation"))
    }
    if (script) {
      scriptResult = await page.evaluate(async (source) => {
        const run = new Function(`return (async () => {\n${source}\n})()`)
        return run()
      }, script)
      if (capturesBrowserMetrics) {
        checkpoints.push(...await browserProbePendingCheckpoints(page))
        checkpoints.push(await browserProbeCheckpoint(page, "after-script"))
      }
    }
    if (durationMs > 0 && waitFor !== "duration") {
      await page.waitForTimeout(durationMs)
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "after-duration"))
      }
    }
    finalUrl = page.url()
  } catch (error) {
    errors.push(serializeBrowserError("probe-error", error))
    throw error
  } finally {
    if (page) {
      finalUrl = page.url()
      if (capturesBrowserMetrics) {
        checkpoints.push(await browserProbeCheckpoint(page, "final"))
        if (capture.has("memory")) {
          memoryArtifact = browserProbeMemoryArtifact(checkpoints)
        }
        if (capture.has("performance")) {
          performanceArtifact = browserProbePerformanceArtifact(checkpoints)
        }
      }

      if (capture.has("html")) {
        const html = await page.content()
        await writeFile(htmlPath, html)
        htmlSha256 = sha256(Buffer.from(html, "utf8"))
      }

      if (capture.has("screenshot")) {
        await page.screenshot({ path: screenshotPath, fullPage: true })
        screenshotSha256 = await fileSha256(screenshotPath)
      }
    }
    if (networkTasks.length > 0) {
      await Promise.all(networkTasks)
    }
    await browser.close()
    if (capture.has("console")) {
      await writeFile(consolePath, jsonLines(consoleMessages))
    }
    if (capture.has("errors")) {
      await writeFile(errorsPath, jsonLines(errors))
    }
    if (capture.has("network")) {
      await writeFile(networkPath, jsonLines(network))
    }
    if (checkpoints.length > 0) {
      await writeFile(checkpointsPath, jsonLines(checkpoints))
    }
    if (memoryArtifact) {
      await writeFile(memoryPath, `${JSON.stringify(memoryArtifact, null, 2)}\n`)
    }
    if (performanceArtifact) {
      await writeFile(performancePath, `${JSON.stringify(performanceArtifact, null, 2)}\n`)
    }

    artifact = {
      requestedUrl: targetUrl,
      url: targetUrl,
      files: {
        ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
        ...(checkpoints.length > 0 ? { checkpoints: "files/browser/checkpoints.jsonl" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
        ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
        ...(memoryArtifact ? { memory: "files/browser/memory.json" } : {}),
        ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
        ...(performanceArtifact ? { performance: "files/browser/performance.json" } : {}),
        ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
        summary: "files/browser/summary.json",
      },
      summary: {
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: capture.has("html"),
        ...(memoryArtifact ? { memory: memoryArtifact.peak } : {}),
        ...(memoryArtifact || performanceArtifact ? { metrics: browserProbeBenchMetrics(memoryArtifact, performanceArtifact) } : {}),
        networkEvents: network.length,
        ...(performanceArtifact ? { performance: performanceArtifact.peak } : {}),
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        ...(typeof scriptResult !== "undefined" ? { scriptResult } : {}),
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/browser-probe/v1",
      requestedUrl: targetUrl,
      finalUrl,
      waitFor,
      durationMs,
      capture: [...capture].sort(),
      startedAt,
      finishedAt: now(),
      files: artifact.files,
      hashes: {
        ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      viewport,
      summary: artifact.summary,
    }, null, 2)}\n`)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.browser-probe",
      requestedUrl: targetUrl,
      finalUrl: artifact.summary.finalUrl ?? targetUrl,
      files: artifact.files,
      summary: artifact.summary,
    }, null, 2)}\n`,
  }
}

export async function runBrowserActionsCommand({
  artifactRoot,
  runtimeSpec,
  server,
  spec,
}: {
  artifactRoot: string
  runtimeSpec: RuntimeCreateSpec
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserProbeArtifact; output: string }> {
  const args = spec.args ?? []
  const steps = await browserInteractionStepsFromArgs(args)
  const initialUrl = argValue(args, "url")?.trim()
  if (steps.length === 0 && !initialUrl) {
    throw new Error("wordpress.browser-actions requires steps-json=<array> (or actions-json=<array>) or url=<path-or-url>")
  }

  if (initialUrl && steps[0]?.kind !== "navigate") {
    steps.unshift({ kind: "navigate", url: initialUrl })
  }

  // evaluate (arbitrary page JS) is gated by a dedicated policy capability,
  // mirroring how wordpress.run-php is gated. Non-JS interaction steps are
  // allowed whenever wordpress.browser-actions itself is allowed.
  if (browserInteractionScriptUsesEvaluate(steps)) {
    assertRuntimeCommandAllowed("wordpress.browser-actions.evaluate", runtimeSpec.policy)
  }

  const capture = new Set(commaListArg(args, "capture"))
  if (capture.size === 0) {
    capture.add("steps")
    capture.add("console")
    capture.add("errors")
    capture.add("network")
    capture.add("html")
    capture.add("screenshot")
  }
  // Back-compat: "actions" remains an alias for the per-step timeline capture.
  if (capture.has("actions")) {
    capture.delete("actions")
    capture.add("steps")
  }

  for (const item of capture) {
    if (!["steps", "console", "errors", "html", "network", "screenshot"].includes(item)) {
      throw new Error(`wordpress.browser-actions capture supports steps, console, errors, html, network, screenshot: ${item}`)
    }
  }

  const stepTimeoutMs = durationArg(args, "step-timeout", BROWSER_STEP_DEFAULT_TIMEOUT_MS)
  const totalTimeoutMs = durationArg(args, "timeout", BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS)

  const browserDirectory = join(artifactRoot, "files", "browser")
  await mkdir(browserDirectory, { recursive: true })

  const stepRecords: BrowserStepRecord[] = []
  const consoleMessages: Record<string, unknown>[] = []
  const errors: BrowserProbeErrorRecord[] = []
  const network: BrowserProbeNetworkRecord[] = []
  const networkTasks: Array<Promise<void>> = []
  const stepsPath = join(browserDirectory, "steps.jsonl")
  const consolePath = join(browserDirectory, "console.jsonl")
  const errorsPath = join(browserDirectory, "errors.jsonl")
  const htmlPath = join(browserDirectory, "snapshot.html")
  const networkPath = join(browserDirectory, "network.jsonl")
  const screenshotPath = join(browserDirectory, "screenshot.png")
  const summaryPath = join(browserDirectory, "action-summary.json")
  const startedAt = now()
  const startedAtMs = Date.now()
  const { chromium } = await import("playwright")
  const browser = await chromium.launch()
  let requestedUrl = initialUrl ? resolveBrowserProbeUrl(initialUrl, server.serverUrl) : server.serverUrl
  let finalUrl = requestedUrl
  let htmlSha256: string | undefined
  let screenshotSha256: string | undefined
  let viewport: BrowserProbeViewport | null = null
  let pendingError: Error | undefined
  let artifact: BrowserProbeArtifact | undefined

  try {
    const page = await browser.newPage()
    viewport = await browserProbeViewport(page)
    if (capture.has("console")) {
      page.on("console", (message) => consoleMessages.push(serializeBrowserConsoleMessage(message)))
    }
    if (capture.has("errors")) {
      page.on("pageerror", (error) => errors.push(serializeBrowserError("pageerror", error)))
    }
    if (capture.has("network")) {
      page.on("requestfinished", (request) => {
        const task = serializeBrowserFinishedRequest(request).then((record) => {
          network.push(record)
        }).catch(() => undefined)
        networkTasks.push(task)
      })
      page.on("requestfailed", (request) => network.push(serializeBrowserRequestFailure(request)))
    }

    for (const [index, step] of steps.entries()) {
      const recordStartedAt = now()
      const recordStartedAtMs = Date.now()
      // Total-script timeout: stop before starting a step that would exceed the budget.
      if (totalTimeoutMs > 0 && recordStartedAtMs - startedAtMs >= totalTimeoutMs) {
        const timeoutError = new Error(`wordpress.browser-actions exceeded total timeout of ${totalTimeoutMs}ms before step ${index} (${step.kind})`)
        const serialized = serializeBrowserError("probe-error", timeoutError)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(index, step, "failed", recordStartedAt, recordStartedAtMs, page.url(), { error: serialized }))
        pendingError = timeoutError
        break
      }
      try {
        const outcome = await executeBrowserInteractionStep(page, step, server.serverUrl, stepTimeoutMs, screenshotPath, browserDirectory)
        finalUrl = page.url()
        if (step.kind === "navigate") {
          requestedUrl = resolveBrowserProbeUrl((step.url ?? "").trim(), server.serverUrl)
        }
        if (outcome.screenshot && capture.has("screenshot") && outcome.screenshotIsDefault) {
          screenshotSha256 = await fileSha256(screenshotPath)
        }
        stepRecords.push(browserStepRecord(index, step, "ok", recordStartedAt, recordStartedAtMs, finalUrl, outcome))
        // A failed expect/evaluate assertion is a clean step failure: no silent partial success.
        if (outcome.assertion && !outcome.assertion.passed) {
          pendingError = new Error(`wordpress.browser-actions ${step.kind} assertion failed at step ${index}`)
          break
        }
      } catch (error) {
        const serialized = serializeBrowserError("probe-error", error)
        errors.push(serialized)
        stepRecords.push(browserStepRecord(index, step, "failed", recordStartedAt, recordStartedAtMs, page.url(), { error: serialized }))
        pendingError = error instanceof Error ? error : new Error(String(error))
        break
      }
    }

    if (capture.has("html")) {
      const html = await page.content()
      await writeFile(htmlPath, html)
      htmlSha256 = sha256(Buffer.from(html, "utf8"))
    }

    if (capture.has("screenshot")) {
      await page.screenshot({ path: screenshotPath, fullPage: true })
      screenshotSha256 = await fileSha256(screenshotPath)
    }
  } finally {
    if (networkTasks.length > 0) {
      await Promise.all(networkTasks)
    }
    await browser.close()
    if (capture.has("steps")) {
      await writeFile(stepsPath, jsonLines(stepRecords))
    }
    if (capture.has("console")) {
      await writeFile(consolePath, jsonLines(consoleMessages))
    }
    if (capture.has("errors")) {
      await writeFile(errorsPath, jsonLines(errors))
    }
    if (capture.has("network")) {
      await writeFile(networkPath, jsonLines(network))
    }

    const assertions = browserAssertionsSummary(stepRecords)
    artifact = {
      requestedUrl,
      url: requestedUrl,
      files: {
        ...(capture.has("steps") ? { steps: "files/browser/steps.jsonl" } : {}),
        ...(capture.has("console") ? { console: "files/browser/console.jsonl" } : {}),
        ...(capture.has("errors") ? { errors: "files/browser/errors.jsonl" } : {}),
        ...(capture.has("html") ? { html: "files/browser/snapshot.html" } : {}),
        ...(capture.has("network") ? { network: "files/browser/network.jsonl" } : {}),
        ...(capture.has("screenshot") ? { screenshot: "files/browser/screenshot.png" } : {}),
        summary: "files/browser/action-summary.json",
      },
      summary: {
        actions: stepRecords.length,
        steps: stepRecords.length,
        ...(assertions.total > 0 ? { assertions } : {}),
        consoleMessages: consoleMessages.length,
        errors: errors.length,
        finalUrl,
        htmlSnapshot: capture.has("html"),
        networkEvents: network.length,
        replayability: browserProbeReplayability(capture),
        screenshot: capture.has("screenshot"),
        viewport,
      },
    }
    await writeFile(summaryPath, `${JSON.stringify({
      schema: "wp-codebox/browser-actions/v1",
      requestedUrl,
      finalUrl,
      capture: [...capture].sort(),
      stepTimeoutMs,
      totalTimeoutMs,
      steps: stepRecords,
      ...(assertions.total > 0 ? { assertions } : {}),
      startedAt,
      finishedAt: now(),
      files: artifact.files,
      hashes: {
        ...(htmlSha256 ? { html: { algorithm: "sha256", value: htmlSha256 } } : {}),
        ...(screenshotSha256 ? { screenshot: { algorithm: "sha256", value: screenshotSha256 } } : {}),
      },
      viewport,
      summary: artifact.summary,
    }, null, 2)}\n`)
  }

  if (pendingError) {
    throw new Error(`wordpress.browser-actions failed after ${stepRecords.length} step(s): ${pendingError.message}`)
  }

  return {
    artifact,
    output: `${JSON.stringify({
      command: "wordpress.browser-actions",
      requestedUrl,
      finalUrl: artifact.summary.finalUrl ?? finalUrl,
      files: artifact.files,
      summary: artifact.summary,
      steps: stepRecords,
    }, null, 2)}\n`,
  }
}

function now(): string {
  return new Date().toISOString()
}

function resolveBrowserProbeUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return new URL(pathOrUrl).toString()
  } catch {
    return new URL(pathOrUrl, baseUrl).toString()
  }
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path))
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

function durationArg(args: string[], name: string, fallbackMs: number): number {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return fallbackMs
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) {
    throw new Error(`${name} must be a duration like 500ms or 2s`)
  }

  const value = Number.parseFloat(match[1])
  return Math.max(0, Math.round(match[2] === "ms" ? value : value * 1000))
}
