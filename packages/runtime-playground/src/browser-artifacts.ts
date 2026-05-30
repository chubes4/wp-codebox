import { join } from "node:path"
import type { ArtifactManifestFile, ArtifactReviewBrowserSummary } from "@chubes4/wp-codebox-core"
import type { Request } from "playwright"
import { fileEntry } from "./artifacts.js"

export interface BrowserProbeArtifact {
  requestedUrl: string
  url: string
  files: {
    actions?: string
    steps?: string
    checkpoints?: string
    console?: string
    errors?: string
    html?: string
    memory?: string
    network?: string
    performance?: string
    screenshot?: string
    summary: string
  }
  summary: {
    actions?: number
    steps?: number
    assertions?: BrowserAssertionsSummary
    consoleMessages: number
    errors: number
    finalUrl: string
    htmlSnapshot: boolean
    memory?: BrowserProbeMemorySummary
    metrics?: Record<string, number>
    networkEvents: number
    performance?: BrowserProbePerformanceSummary
    replayability: BrowserProbeReplayability
    screenshot: boolean
    scriptResult?: unknown
    viewport: BrowserProbeViewport | null
  }
}

export interface BrowserAssertionsSummary {
  total: number
  passed: number
  failed: number
  results: BrowserStepAssertion[]
}

export interface BrowserProbeMetricDigest {
  final: number | null
  peak: number | null
}

export interface BrowserProbeMemorySummary {
  usedJSHeapSize: BrowserProbeMetricDigest
  totalJSHeapSize: BrowserProbeMetricDigest
  jsHeapSizeLimit: number | null
  domNodes: BrowserProbeMetricDigest
  documents: BrowserProbeMetricDigest
  jsEventListeners: BrowserProbeMetricDigest
}

export interface BrowserProbePerformanceSummary {
  resources: number
  transferSizeBytes: number
  encodedBodySizeBytes: number
  decodedBodySizeBytes: number
  longTasks: number
  longTaskDurationMs: number
  domNodes: BrowserProbeMetricDigest
  cdpMetrics: Record<string, BrowserProbeMetricDigest>
}

export interface BrowserProbeCheckpointRecord {
  schema: "wp-codebox/browser-checkpoint/v1"
  name: string
  metadata?: unknown
  timestamp: string
  metrics: BrowserProbeMetricsSnapshot
}

export interface BrowserProbeMetricsSnapshot {
  timestamp: string
  memory: {
    performanceMemory: {
      usedJSHeapSize: number | null
      totalJSHeapSize: number | null
      jsHeapSizeLimit: number | null
    }
    cdpHeap: {
      usedSize: number | null
      totalSize: number | null
    }
    domCounters: {
      documents: number | null
      nodes: number | null
      jsEventListeners: number | null
    }
  }
  performance: {
    cdpMetrics: Record<string, number>
    dom: {
      nodes: number
      documents: number
      iframes: number
    }
    resources: {
      count: number
      transferSizeBytes: number
      encodedBodySizeBytes: number
      decodedBodySizeBytes: number
    }
    longTasks: {
      count: number
      totalDurationMs: number
      maxDurationMs: number
    }
  }
}

export interface BrowserProbeMemoryArtifact {
  schema: "wp-codebox/browser-memory/v1"
  version: 1
  capturedAt: string
  final: BrowserProbeMetricsSnapshot["memory"]
  peak: BrowserProbeMemorySummary
  checkpoints: BrowserProbeCheckpointRecord[]
}

export interface BrowserProbePerformanceArtifact {
  schema: "wp-codebox/browser-performance/v1"
  version: 1
  capturedAt: string
  final: BrowserProbeMetricsSnapshot["performance"]
  peak: BrowserProbePerformanceSummary
  checkpoints: BrowserProbeCheckpointRecord[]
}

export interface BrowserProbeViewport {
  width: number
  height: number
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  userAgent: string
}

export type BrowserProbeReplayability = "artifact-backed" | "partial" | "diagnostic-only"

export interface BrowserStepRecord {
  index: number
  kind: string
  status: "ok" | "failed"
  startedAt: string
  finishedAt: string
  durationMs: number
  url?: string
  selector?: string
  text?: string
  key?: string
  waitFor?: string
  duration?: string
  /** Machine-readable assertion outcome for expect/evaluate steps. */
  assertion?: BrowserStepAssertion
  screenshot?: string
  finalUrl?: string
  error?: BrowserProbeErrorRecord
}

export interface BrowserStepAssertion {
  kind: "expect" | "evaluate"
  selector?: string
  state?: string
  expression?: string
  expected?: unknown
  actual?: unknown
  passed: boolean
}

export interface BrowserProbeErrorRecord {
  type: "pageerror" | "probe-error"
  name: string
  message: string
  stack?: string
  timestamp: string
}

export interface BrowserProbeNetworkRecord {
  type: "response" | "requestfailed"
  url: string
  method: string
  resourceType: string
  timestamp: string
  status?: number
  statusText?: string
  ok?: boolean
  contentType?: string | null
  timing?: Record<string, number>
  sizes?: BrowserProbeNetworkSizes
  transferSize?: number
  bodySize?: number
  requestBodySize?: number
  responseBodySize?: number
  failure?: ReturnType<Request["failure"]>
}

export interface BrowserProbeNetworkSizes {
  requestBodySize: number
  requestHeadersSize: number
  responseBodySize: number
  responseHeadersSize: number
}

export function browserReviewSummary(probes: BrowserProbeArtifact[]): ArtifactReviewBrowserSummary | undefined {
  if (probes.length === 0) {
    return undefined
  }

  const consoleMessages = probes.reduce((total, probe) => total + probe.summary.consoleMessages, 0)
  const errors = probes.reduce((total, probe) => total + probe.summary.errors, 0)
  const screenshots = probes.filter((probe) => probe.summary.screenshot).length
  const actions = probes.reduce((total, probe) => total + (probe.summary.actions ?? 0), 0)
  return {
    summary: `Browser evidence captured ${actions} action${actions === 1 ? "" : "s"}, ${consoleMessages} console message${consoleMessages === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}, and ${screenshots} screenshot${screenshots === 1 ? "" : "s"}.`,
    probes: probes.map((probe) => ({
      url: probe.url,
      requestedUrl: probe.requestedUrl,
      finalUrl: probe.summary.finalUrl,
      viewport: probe.summary.viewport,
      replayability: probe.summary.replayability,
      consoleMessages: probe.summary.consoleMessages,
      errors: probe.summary.errors,
      html: probe.files.html,
      network: probe.files.network,
      networkEvents: probe.summary.networkEvents,
      screenshot: probe.files.screenshot,
      console: probe.files.console,
      checkpoints: probe.files.checkpoints,
      errorsFile: probe.files.errors,
      memory: probe.files.memory,
      actions: probe.files.steps ?? probe.files.actions,
      actionCount: probe.summary.steps ?? probe.summary.actions,
      steps: probe.files.steps,
      stepCount: probe.summary.steps,
      ...(probe.summary.assertions ? { assertions: { total: probe.summary.assertions.total, passed: probe.summary.assertions.passed, failed: probe.summary.assertions.failed } } : {}),
      performance: probe.files.performance,
      summaryFile: probe.files.summary,
    })),
  }
}

export function browserManifestFiles(artifactRoot: string, probes: BrowserProbeArtifact[]): ArtifactManifestFile[] {
  if (probes.length === 0) {
    return []
  }

  const files = new Map<string, { kind: string; contentType: string }>()
  for (const probe of probes) {
    if (probe.files.steps) {
      files.set(probe.files.steps, { kind: "browser-steps", contentType: "application/x-ndjson" })
    }
    if (probe.files.actions) {
      files.set(probe.files.actions, { kind: "browser-actions", contentType: "application/x-ndjson" })
    }
    if (probe.files.console) {
      files.set(probe.files.console, { kind: "browser-console", contentType: "application/x-ndjson" })
    }
    if (probe.files.checkpoints) {
      files.set(probe.files.checkpoints, { kind: "browser-checkpoints", contentType: "application/x-ndjson" })
    }
    if (probe.files.errors) {
      files.set(probe.files.errors, { kind: "browser-errors", contentType: "application/x-ndjson" })
    }
    if (probe.files.html) {
      files.set(probe.files.html, { kind: "browser-html-snapshot", contentType: "text/html; charset=utf-8" })
    }
    if (probe.files.memory) {
      files.set(probe.files.memory, { kind: "browser-memory", contentType: "application/json" })
    }
    if (probe.files.network) {
      files.set(probe.files.network, { kind: "browser-network", contentType: "application/x-ndjson" })
    }
    if (probe.files.performance) {
      files.set(probe.files.performance, { kind: "browser-performance", contentType: "application/json" })
    }
    if (probe.files.screenshot) {
      files.set(probe.files.screenshot, { kind: "browser-screenshot", contentType: "image/png" })
    }
    files.set(probe.files.summary, { kind: "browser-summary", contentType: "application/json" })
  }

  return [...files.entries()].map(([path, entry]) => fileEntry(join(artifactRoot, path), entry.kind, entry.contentType))
}

export function browserRedactionPaths(probe: BrowserProbeArtifact): string[] {
  return [probe.files.steps, probe.files.actions, probe.files.checkpoints, probe.files.console, probe.files.errors, probe.files.html, probe.files.memory, probe.files.network, probe.files.performance, probe.files.summary]
    .filter((path): path is string => typeof path === "string" && path.length > 0)
}
