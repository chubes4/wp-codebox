import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { calculateArtifactContentDigest, verifyArtifactBundle } from "@chubes4/wp-codebox-core"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-verifier-"))

try {
  const validBundle = join(workspace, "valid")
  await writeValidBundle(validBundle)

  const valid = await verifyArtifactBundle(validBundle)
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.violations, [])

  const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "artifacts", "verify", "--bundle", validBundle, "--json"], { cwd: root })
  assert.equal(JSON.parse(stdout).valid, true)

  const missingManifest = join(workspace, "missing-manifest")
  await mkdir(missingManifest, { recursive: true })
  assertViolation(await verifyArtifactBundle(missingManifest), "missing-manifest")

  const missingFile = await copyBundle(validBundle, join(workspace, "missing-file"))
  await rm(join(missingFile, "files/patch.diff"))
  assertViolation(await verifyArtifactBundle(missingFile), "missing-file")

  const traversalPath = await copyBundle(validBundle, join(workspace, "traversal-path"))
  const traversalManifest = manifestFixture(await calculateArtifactContentDigest(traversalPath, ["files/changed-files.json", "files/patch.diff"]))
  traversalManifest.files.push({ path: "../escape.txt", kind: "file", contentType: "text/plain" })
  await writeJson(join(traversalPath, "manifest.json"), traversalManifest)
  assertViolation(await verifyArtifactBundle(traversalPath), "invalid-path")

  const digestMismatch = await copyBundle(validBundle, join(workspace, "digest-mismatch"))
  await writeFile(join(digestMismatch, "files/patch.diff"), "diff --git a/file.txt b/file.txt\n+tampered\n")
  assertViolation(await verifyArtifactBundle(digestMismatch), "digest-mismatch")

  const malformedManifest = join(workspace, "malformed-manifest")
  await mkdir(malformedManifest, { recursive: true })
  await writeFile(join(malformedManifest, "manifest.json"), "{not-json")
  assertViolation(await verifyArtifactBundle(malformedManifest), "malformed-manifest")

  const reviewMismatch = await copyBundle(validBundle, join(workspace, "review-mismatch"))
  const review = reviewFixture("0".repeat(64))
  await writeJson(join(reviewMismatch, "files/review.json"), review)
  assertViolation(await verifyArtifactBundle(reviewMismatch), "review-evidence-mismatch")

  const invalidTrace = await copyBundle(validBundle, join(workspace, "invalid-runtime-episode-trace"))
  await writeJson(join(invalidTrace, "files/runtime-episode-trace.json"), { schema: "wrong" })
  assertViolation(await verifyArtifactBundle(invalidTrace), "malformed-reference")

  console.log("Artifact bundle verifier smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeValidBundle(directory: string): Promise<void> {
  await mkdir(join(directory, "files"), { recursive: true })
  const changedFiles = `${JSON.stringify({ schema: "wp-codebox/changed-files/v1", files: [{ path: "/wordpress/wp-content/plugins/example/file.txt", status: "added", mountIndex: 0, mountTarget: "/wordpress/wp-content/plugins/example", relativePath: "file.txt", patchPath: "files/diffs/0-file.txt.diff" }] }, null, 2)}\n`
  const patch = "diff --git /dev/null b/wordpress/wp-content/plugins/example/file.txt\n--- /dev/null\n+++ b/wordpress/wp-content/plugins/example/file.txt\n@@ -0,0 +1 @@\n+cooked\n"
  await writeFile(join(directory, "files/changed-files.json"), changedFiles)
  await writeFile(join(directory, "files/patch.diff"), patch)
  await writeFile(join(directory, "metadata.json"), "{}\n")
  await writeFile(join(directory, "files/test-results.json"), "{}\n")

  const digest = await calculateArtifactContentDigest(directory, ["files/changed-files.json", "files/patch.diff"])
  await writeJson(join(directory, "files/runtime-episode-trace.json"), runtimeEpisodeTraceFixture(digest))
  await writeFile(join(directory, "files/runtime-episode.jsonl"), `${JSON.stringify({ type: "episode.artifacts", id: `artifact-bundle-sha256-${digest}` })}\n`)
  await writeJson(join(directory, "files/review.json"), reviewFixture(digest))
  await writeJson(join(directory, "metadata.json"), {
    id: `artifact-bundle-sha256-${digest}`,
    artifacts: {
      changedFiles: "files/changed-files.json",
      patch: "files/patch.diff",
      review: "files/review.json",
      testResults: "files/test-results.json",
      runtimeEpisodeTrace: "files/runtime-episode-trace.json",
      runtimeEpisodeEvents: "files/runtime-episode.jsonl",
    },
  })
  await writeJson(join(directory, "manifest.json"), manifestFixture(digest))
}

function manifestFixture(digest: string) {
  return {
    id: `artifact-bundle-sha256-${digest}`,
    contentDigest: {
      algorithm: "sha256",
      inputs: ["files/changed-files.json", "files/patch.diff"],
      value: digest,
    },
    createdAt: "2026-05-27T00:00:00.000Z",
    runtime: {
      id: "runtime-fixture",
      backend: "wordpress-playground",
      status: "destroyed",
      environment: { kind: "wordpress", version: "latest" },
      createdAt: "2026-05-27T00:00:00.000Z",
    },
    files: [
      { path: "manifest.json", kind: "manifest", contentType: "application/json" },
      { path: "metadata.json", kind: "metadata", contentType: "application/json" },
      { path: "files/changed-files.json", kind: "changed-files", contentType: "application/json" },
      { path: "files/patch.diff", kind: "patch", contentType: "text/x-diff" },
      { path: "files/review.json", kind: "review", contentType: "application/json" },
      { path: "files/test-results.json", kind: "test-results", contentType: "application/json" },
      { path: "files/runtime-episode-trace.json", kind: "runtime-episode-trace", contentType: "application/json" },
      { path: "files/runtime-episode.jsonl", kind: "runtime-episode-events", contentType: "application/x-ndjson" },
    ],
  }
}

function runtimeEpisodeTraceFixture(digest: string) {
  const runtime = {
    id: "runtime-fixture",
    backend: "wordpress-playground",
    status: "destroyed",
    environment: { kind: "wordpress", version: "latest" },
    createdAt: "2026-05-27T00:00:00.000Z",
  }

  return {
    schema: "wp-codebox/runtime-episode-trace/v1",
    version: 1,
    id: "trace-runtime-fixture",
    createdAt: "2026-05-27T00:00:00.000Z",
    runtime,
    reset: {
      id: "runtime-fixture:reset:0",
      runtime,
      observations: [],
      observationRefs: [],
    },
    steps: [],
    snapshots: [],
    artifactRef: {
      kind: "artifact-bundle",
      id: `artifact-bundle-sha256-${digest}`,
      artifactId: `artifact-bundle-sha256-${digest}`,
      path: "/tmp/wp-codebox-artifact-verifier/valid",
      digest: { algorithm: "sha256", value: digest },
    },
  }
}

function reviewFixture(digest: string) {
  const patch = "diff --git /dev/null b/wordpress/wp-content/plugins/example/file.txt\n--- /dev/null\n+++ b/wordpress/wp-content/plugins/example/file.txt\n@@ -0,0 +1 @@\n+cooked\n"
  return {
    schema: "wp-codebox/artifact-review/v1",
    artifactId: `artifact-bundle-sha256-${digest}`,
    evidence: {
      patch: "files/patch.diff",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      artifactContentDigest: digest,
      changedFiles: "files/changed-files.json",
      testResults: "files/test-results.json",
      runtimeEpisodeTrace: "files/runtime-episode-trace.json",
    },
    changedFiles: [{ path: "/wordpress/wp-content/plugins/example/file.txt", status: "added" }],
  }
}

async function copyBundle(source: string, target: string): Promise<string> {
  await cp(source, target, { recursive: true })
  return target
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function assertViolation(result: Awaited<ReturnType<typeof verifyArtifactBundle>>, code: string): void {
  assert.equal(result.valid, false)
  assert.ok(result.violations.some((violation) => violation.code === code), `Expected ${code}, got ${result.violations.map((violation) => violation.code).join(", ")}`)
}
