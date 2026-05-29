import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import {
  buildRuntimeReferenceManifest,
  buildRuntimeReplayReferenceIndex,
  calculateArtifactManifestFileSha256,
  type ArtifactBundle,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactPreview,
  type ArtifactReviewBrowserSummary,
  type ArtifactSpec,
  type ExecutionResult,
  type LifecycleEvent,
  type MountSpec,
  type ObservationResult,
  type RuntimeCreateSpec,
  type RuntimeInfo,
} from "@chubes4/wp-codebox-core"
import {
  ArtifactRedactor,
  artifactContentDigest,
  buildArtifactProvenance,
  buildArtifactReview,
  buildBlueprintAfter,
  buildBlueprintAfterNotes,
  buildTestResults,
  fileEntry,
  serializeCapturedMountFiles,
  type CapturedMountFiles,
  type MountDiffsResult,
} from "./artifacts.js"

export interface ArtifactBundleBuilderSource {
  artifactRoot: string
  runtimeId: string
  runtimeCreatedAt: string
  spec: RuntimeCreateSpec
  mounts: MountSpec[]
  commands: ExecutionResult[]
  observations: ObservationResult[]
  events: LifecycleEvent[]
  info(): Promise<RuntimeInfo>
  previewInfo(createdAt: string, previewHoldSeconds?: number): Promise<ArtifactPreview | undefined>
  browserReviewSummary(): ArtifactReviewBrowserSummary | undefined
  captureMountedFiles(filesDirectory: string, redactor: ArtifactRedactor): Promise<CapturedMountFiles>
  captureMountDiffs(filesDirectory: string, redactor: ArtifactRedactor): Promise<MountDiffsResult>
  redactBrowserArtifacts(redactor: ArtifactRedactor): Promise<void>
  redactPluginCheckArtifacts(redactor: ArtifactRedactor): Promise<void>
  redactThemeCheckArtifacts(redactor: ArtifactRedactor): Promise<void>
  browserManifestFiles(): ArtifactManifestFile[]
  pluginCheckArtifactPaths(): string[]
  themeCheckArtifactPaths(): string[]
  observationManifestFiles(): ArtifactManifestFile[]
  pluginCheckManifestFiles(): ArtifactManifestFile[]
  themeCheckManifestFiles(): ArtifactManifestFile[]
  formatRuntimeLog(): string
  formatCommandsLog(): string
  recordArtifactsCollected(bundleId: string, createdAt: string, spec: ArtifactSpec): void
}

export class ArtifactBundleBuilder {
  constructor(private readonly source: ArtifactBundleBuilderSource) {}

  async build(spec: ArtifactSpec = {}): Promise<ArtifactBundle> {
    const { source } = this
    await mkdir(source.artifactRoot, { recursive: true })
    const logsDirectory = join(source.artifactRoot, "logs")
    const filesDirectory = join(source.artifactRoot, "files")
    await mkdir(logsDirectory, { recursive: true })
    await mkdir(filesDirectory, { recursive: true })

    const createdAt = new Date().toISOString()
    const manifestPath = join(source.artifactRoot, "manifest.json")
    const metadataPath = join(source.artifactRoot, "metadata.json")
    const blueprintAfterPath = join(source.artifactRoot, "blueprint.after.json")
    const blueprintAfterNotesPath = join(source.artifactRoot, "blueprint.after-notes.json")
    const eventsPath = join(source.artifactRoot, "events.jsonl")
    const commandsPath = join(source.artifactRoot, "commands.jsonl")
    const observationsPath = join(source.artifactRoot, "observations.jsonl")
    const runtimeLogPath = join(logsDirectory, "runtime.log")
    const commandsLogPath = join(logsDirectory, "commands.log")
    const mountsPath = join(filesDirectory, "mounts.json")
    const capturedMountsPath = join(filesDirectory, "mounted-files.json")
    const diffsPath = join(filesDirectory, "diffs.json")
    const changedFilesPath = join(filesDirectory, "changed-files.json")
    const patchPath = join(filesDirectory, "patch.diff")
    const testResultsPath = join(filesDirectory, "test-results.json")
    const reviewPath = join(filesDirectory, "review.json")
    const runtimeReferenceManifestPath = join(filesDirectory, "runtime-reference-manifest.json")
    const runtimeReplayReferenceIndexPath = join(filesDirectory, "runtime-replay-index.json")
    const redactor = new ArtifactRedactor(source.spec.secretEnv)

    await source.redactBrowserArtifacts(redactor)
    await source.redactPluginCheckArtifacts(redactor)
    await source.redactThemeCheckArtifacts(redactor)

    const preview = await source.previewInfo(createdAt, spec.previewHoldSeconds)
    const browser = source.browserReviewSummary()
    const runtime = await source.info()
    const capturedMounts = await source.captureMountedFiles(filesDirectory, redactor)
    const { mountDiffs, changedFiles, patch } = await source.captureMountDiffs(filesDirectory, redactor)
    const changedFilesJson = redactor.redact("files/changed-files.json", `${JSON.stringify(changedFiles, null, 2)}\n`)
    const redactedPatch = redactor.redact("files/patch.diff", patch)
    const contentDigest = artifactContentDigest(changedFilesJson, redactedPatch)
    const bundleId = `artifact-bundle-sha256-${contentDigest}`
    const contentDigestMetadata = {
      algorithm: "sha256",
      inputs: ["files/changed-files.json", "files/patch.diff"],
      value: contentDigest,
    }
    const provenance = buildArtifactProvenance({
      runtime,
      context: source.spec.metadata ?? {},
      mounts: source.mounts,
    })
    const metadata: Record<string, unknown> = {
      id: bundleId,
      contentDigest: contentDigestMetadata,
      createdAt,
      runtime,
      provenance,
      mounts: source.mounts,
      policy: source.spec.policy,
      context: source.spec.metadata ?? {},
      spec,
    }
    source.recordArtifactsCollected(bundleId, createdAt, spec)
    const testResults = buildTestResults()
    const review = buildArtifactReview({
      artifactId: bundleId,
      createdAt,
      provenance,
      changedFiles,
      patch: redactedPatch,
      contentDigest,
      runtimeCreatedAt: source.runtimeCreatedAt,
      mounts: source.mounts,
      preview,
      browser,
    })
    const artifactFiles = {
      changedFiles: relative(source.artifactRoot, changedFilesPath),
      patch: relative(source.artifactRoot, patchPath),
      testResults: relative(source.artifactRoot, testResultsPath),
      review: relative(source.artifactRoot, reviewPath),
      runtimeReferenceManifest: relative(source.artifactRoot, runtimeReferenceManifestPath),
      runtimeReplayReferenceIndex: relative(source.artifactRoot, runtimeReplayReferenceIndexPath),
      mountDiffs: relative(source.artifactRoot, diffsPath),
      ...(browser ? { browser: "files/browser/summary.json" } : {}),
      ...(source.pluginCheckArtifactPaths().length > 0 ? { pluginChecks: source.pluginCheckArtifactPaths() } : {}),
      ...(source.themeCheckArtifactPaths().length > 0 ? { themeChecks: source.themeCheckArtifactPaths() } : {}),
    }
    metadata.artifacts = artifactFiles
    const blueprintAfter = buildBlueprintAfter({
      environment: source.spec.environment,
      capturedMounts,
    })
    const blueprintAfterNotes = buildBlueprintAfterNotes({
      createdAt,
      runtimeId: source.runtimeId,
      environment: source.spec.environment,
      mounts: source.mounts,
      capturedMounts,
    })

    const manifestFiles: ArtifactManifestFile[] = [
      fileEntry(manifestPath, "manifest", "application/json"),
      fileEntry(metadataPath, "metadata", "application/json"),
      fileEntry(blueprintAfterPath, "blueprint-after", "application/json"),
      fileEntry(blueprintAfterNotesPath, "blueprint-after-notes", "application/json"),
      fileEntry(eventsPath, "events", "application/x-ndjson"),
      fileEntry(commandsPath, "commands", "application/x-ndjson"),
      fileEntry(observationsPath, "observations", "application/x-ndjson"),
      fileEntry(runtimeLogPath, "log", "text/plain"),
      fileEntry(commandsLogPath, "log", "text/plain"),
      fileEntry(mountsPath, "mounts", "application/json"),
      fileEntry(capturedMountsPath, "mounted-files", "application/json"),
      fileEntry(diffsPath, "mount-diffs", "application/json"),
      fileEntry(changedFilesPath, "changed-files", "application/json"),
      fileEntry(patchPath, "patch", "text/x-diff"),
      fileEntry(testResultsPath, "test-results", "application/json"),
      fileEntry(reviewPath, "review", "application/json"),
      fileEntry(runtimeReferenceManifestPath, "runtime-reference-manifest", "application/json"),
      fileEntry(runtimeReplayReferenceIndexPath, "runtime-replay-index", "application/json"),
      ...source.browserManifestFiles(),
      ...source.observationManifestFiles(),
      ...source.pluginCheckManifestFiles(),
      ...source.themeCheckManifestFiles(),
      ...mountDiffs.map((diff) => fileEntry(join(source.artifactRoot, diff.artifactPath), "diff", "text/x-diff")),
      ...capturedMounts.files.map((file) =>
        fileEntry(join(source.artifactRoot, file.artifactPath), "file", file.contentType),
      ),
    ]

    metadata.preview = preview

    await writeRedactedArtifact(redactor, blueprintAfterPath, source.artifactRoot, `${JSON.stringify(blueprintAfter, null, 2)}\n`)
    await writeRedactedArtifact(redactor, blueprintAfterNotesPath, source.artifactRoot, `${JSON.stringify(blueprintAfterNotes, null, 2)}\n`)
    await writeJsonLines(eventsPath, source.events, redactor, source.artifactRoot)
    await writeJsonLines(commandsPath, source.commands, redactor, source.artifactRoot)
    await writeJsonLines(observationsPath, source.observations, redactor, source.artifactRoot)
    await writeRedactedArtifact(redactor, runtimeLogPath, source.artifactRoot, source.formatRuntimeLog())
    await writeRedactedArtifact(redactor, commandsLogPath, source.artifactRoot, source.formatCommandsLog())
    await writeRedactedArtifact(redactor, mountsPath, source.artifactRoot, `${JSON.stringify(source.mounts, null, 2)}\n`)
    await writeRedactedArtifact(redactor, capturedMountsPath, source.artifactRoot, `${JSON.stringify(serializeCapturedMountFiles(capturedMounts), null, 2)}\n`)
    await writeRedactedArtifact(redactor, diffsPath, source.artifactRoot, `${JSON.stringify(mountDiffs, null, 2)}\n`)
    await writeFile(changedFilesPath, changedFilesJson)
    await writeFile(patchPath, redactedPatch)
    await writeRedactedArtifact(redactor, testResultsPath, source.artifactRoot, `${JSON.stringify(testResults, null, 2)}\n`)
    const redaction = redactor.summary()
    if (redaction.total > 0) {
      review.redaction = redaction
      review.riskFlags.push("secrets-redacted")
    }
    await writeRedactedArtifact(redactor, reviewPath, source.artifactRoot, `${JSON.stringify(review, null, 2)}\n`)
    await writeFile(runtimeReferenceManifestPath, "{}\n")
    await writeFile(runtimeReplayReferenceIndexPath, "{}\n")
    metadata.redaction = redactor.summary()
    await writeRedactedArtifact(redactor, metadataPath, source.artifactRoot, `${JSON.stringify(metadata, null, 2)}\n`)

    const manifest: ArtifactManifest = {
      id: bundleId,
      contentDigest: {
        algorithm: "sha256",
        inputs: ["files/changed-files.json", "files/patch.diff"],
        value: contentDigest,
      },
      createdAt,
      runtime,
      files: manifestFiles.map((file) => ({
        ...file,
        path: relative(source.artifactRoot, file.path),
      })),
    }
    manifest.files = await Promise.all(manifest.files.map(async (file) => file.path === "manifest.json" ? file : ({
      ...file,
      sha256: {
        algorithm: "sha256" as const,
        value: await calculateArtifactManifestFileSha256(source.artifactRoot, manifest, file),
      },
    })))
    manifest.files = await Promise.all(manifest.files.map(async (file) => file.path !== "manifest.json" ? file : ({
      ...file,
      sha256: {
        algorithm: "sha256" as const,
        value: await calculateArtifactManifestFileSha256(source.artifactRoot, manifest, file),
      },
    })))
    const runtimeReferenceManifest = buildRuntimeReferenceManifest({
      createdAt,
      runtime,
      artifactBundle: {
        kind: "artifact-bundle",
        id: bundleId,
        digest: { algorithm: "sha256", value: contentDigest },
      },
      files: manifest.files
        .filter((file) => !["manifest.json", "metadata.json", "files/review.json", "files/runtime-reference-manifest.json", "files/runtime-replay-index.json"].includes(file.path))
        .map((file) => ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 })),
    })
    await writeFile(runtimeReferenceManifestPath, `${JSON.stringify(runtimeReferenceManifest, null, 2)}\n`)
    const runtimeReferenceManifestRef = {
      path: "files/runtime-reference-manifest.json",
      kind: "runtime-reference-manifest",
      contentType: "application/json",
      sha256: {
        algorithm: "sha256" as const,
        value: await calculateArtifactManifestFileSha256(source.artifactRoot, manifest, { path: "files/runtime-reference-manifest.json", kind: "runtime-reference-manifest", contentType: "application/json", sha256: { algorithm: "sha256", value: "0".repeat(64) } }),
      },
    }
    const runtimeReplayReferenceIndex = buildRuntimeReplayReferenceIndex({
      createdAt,
      runtime,
      artifactBundle: {
        kind: "artifact-bundle",
        id: bundleId,
        digest: { algorithm: "sha256", value: contentDigest },
      },
      files: manifest.files
        .filter((file) => !["manifest.json", "files/runtime-replay-index.json"].includes(file.path))
        .map((file) => file.path === "files/runtime-reference-manifest.json" ? runtimeReferenceManifestRef : ({ path: file.path, kind: file.kind, contentType: file.contentType, sha256: file.sha256 })),
      runtimeReferenceManifest: runtimeReferenceManifestRef,
    })
    await writeFile(runtimeReplayReferenceIndexPath, `${JSON.stringify(runtimeReplayReferenceIndex, null, 2)}\n`)
    manifest.files = await Promise.all(manifest.files.map(async (file) => file.path === "files/runtime-reference-manifest.json" ? ({
      ...file,
      sha256: {
        algorithm: "sha256" as const,
        value: await calculateArtifactManifestFileSha256(source.artifactRoot, manifest, file),
      },
    }) : file))
    manifest.files = await Promise.all(manifest.files.map(async (file) => file.path === "files/runtime-replay-index.json" ? ({
      ...file,
      sha256: {
        algorithm: "sha256" as const,
        value: await calculateArtifactManifestFileSha256(source.artifactRoot, manifest, file),
      },
    }) : file))
    manifest.files = await Promise.all(manifest.files.map(async (file) => file.path !== "manifest.json" ? file : ({
      ...file,
      sha256: {
        algorithm: "sha256" as const,
        value: await calculateArtifactManifestFileSha256(source.artifactRoot, manifest, file),
      },
    })))
    await writeRedactedArtifact(redactor, manifestPath, source.artifactRoot, `${JSON.stringify(manifest, null, 2)}\n`)

    return {
      id: bundleId,
      directory: source.artifactRoot,
      manifestPath,
      metadataPath,
      blueprintAfterPath,
      blueprintAfterNotesPath,
      eventsPath,
      commandsPath,
      observationsPath,
      runtimeLogPath,
      commandsLogPath,
      mountsPath,
      capturedMountsPath,
      diffsPath,
      changedFilesPath,
      patchPath,
      testResultsPath,
      reviewPath,
      runtimeReferenceManifestPath,
      runtimeReplayReferenceIndexPath,
      ...(preview ? { preview } : {}),
      contentDigest,
      createdAt,
    }
  }
}

async function writeJsonLines(path: string, records: unknown[], redactor: ArtifactRedactor, artifactRoot: string): Promise<void> {
  await writeRedactedArtifact(redactor, path, artifactRoot, records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "")
}

async function writeRedactedArtifact(redactor: ArtifactRedactor, path: string, artifactRoot: string, contents: string): Promise<void> {
  await writeFile(path, redactor.redact(relative(artifactRoot, path), contents))
}
