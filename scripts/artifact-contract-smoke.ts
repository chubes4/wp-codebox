import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { RUNTIME_REFERENCE_MANIFEST_SCHEMA, RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA, createRuntime, runtimeReferenceManifestDigest, runtimeReplayReferenceIndexDigest, verifyArtifactBundle } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

const execFileAsync = promisify(execFile)
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-artifacts-"))

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "packages/cli/dist/index.js",
      "recipe-run",
      "--recipe",
      "./examples/recipes/seeded-plugin-workspace.json",
      "--artifacts",
      artifactsDirectory,
      "--preview-hold",
      "1s",
      "--preview-public-url",
      "https://preview.example.test/codebox/",
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  const output = JSON.parse(stdout)
  assert.equal(output.success, true)
  assert.equal(output.runtime.status, "created")
  assert.equal(output.runtime.previewUrl, "https://preview.example.test/codebox/")

  const artifacts = output.artifacts
  const verification = await verifyArtifactBundle(artifacts.directory)
  assert.equal(verification.valid, true, JSON.stringify(verification.violations, null, 2))
  assert.ok(artifacts.changedFilesPath, "artifact bundle should expose changedFilesPath")
  assert.ok(artifacts.patchPath, "artifact bundle should expose patchPath")
  assert.ok(artifacts.testResultsPath, "artifact bundle should expose testResultsPath")
  assert.ok(artifacts.reviewPath, "artifact bundle should expose reviewPath")
  assert.equal(artifacts.preview.status, "available")
  assert.equal(artifacts.preview.lifecycle, "held-after-run")
  assert.equal(artifacts.preview.holdSeconds, 1)
  assert.equal(artifacts.preview.url, "https://preview.example.test/codebox/")
  assert.equal(artifacts.preview.publicUrl, "https://preview.example.test/codebox/")
  assert.equal(artifacts.preview.siteUrl, "https://preview.example.test/codebox/")
  assert.match(artifacts.preview.localUrl, /^http:\/\/127\.0\.0\.1:/)
  assert.equal(artifacts.preview.source, "public-url-override")

  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
  const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8"))
  const changedFiles = JSON.parse(await readFile(artifacts.changedFilesPath, "utf8"))
  const changedFilesJson = await readFile(artifacts.changedFilesPath, "utf8")
  const patch = await readFile(artifacts.patchPath, "utf8")
  const testResults = JSON.parse(await readFile(artifacts.testResultsPath, "utf8"))
  const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8"))
  const runtimeReferenceManifest = JSON.parse(await readFile(artifacts.runtimeReferenceManifestPath, "utf8"))
  const runtimeReplayReferenceIndex = JSON.parse(await readFile(artifacts.runtimeReplayReferenceIndexPath, "utf8"))
  const contentDigest = createHash("sha256")
    .update("wp-codebox/artifact-content/v1\n")
    .update("files/changed-files.json\n")
    .update(changedFilesJson)
    .update("\nfiles/patch.diff\n")
    .update(patch)
    .digest("hex")

  assert.equal(artifacts.id, `artifact-bundle-sha256-${contentDigest}`)
  assert.equal(artifacts.contentDigest, contentDigest)
  assert.equal(manifest.id, artifacts.id)
  assert.deepEqual(manifest.contentDigest, {
    algorithm: "sha256",
    inputs: ["files/changed-files.json", "files/patch.diff"],
    value: contentDigest,
  })
  assert.deepEqual(metadata.contentDigest, manifest.contentDigest)
  assert.deepEqual(metadata.preview, artifacts.preview)
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/changed-files.json" && file.kind === "changed-files"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/patch.diff" && file.kind === "patch"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/test-results.json" && file.kind === "test-results"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/review.json" && file.kind === "review"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-reference-manifest.json" && file.kind === "runtime-reference-manifest"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-replay-index.json" && file.kind === "runtime-replay-index"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/runtime-evidence/run-attestation.json" && file.kind === "run-attestation"))
  const runtimeEvidence = metadata.artifacts.runtimeEvidence
  assert.match(runtimeEvidence["run-attestation"].sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(metadata.artifacts, {
    changedFiles: "files/changed-files.json",
    patch: "files/patch.diff",
    testResults: "files/test-results.json",
    review: "files/review.json",
    runtimeReferenceManifest: "files/runtime-reference-manifest.json",
    runtimeReplayReferenceIndex: "files/runtime-replay-index.json",
    mountDiffs: "files/diffs.json",
    runtimeEvidence,
  })
  assert.equal(metadata.provenance.runtime.backend, "wordpress-playground")
  assert.equal(metadata.provenance.runtime.version, "0.0.0")
  assert.equal(metadata.provenance.runtime.wordpressVersion, "latest")
  assert.equal(metadata.provenance.task.kind, "recipe-run")
  assert.equal(metadata.provenance.task.recipePath.endsWith("examples/recipes/seeded-plugin-workspace.json"), true)
  assert.equal(metadata.provenance.task.previewPublicUrl, "https://preview.example.test/codebox/")
  assert.ok(metadata.provenance.task.inputs.workspaces.length > 0)
  assert.equal(metadata.provenance.workspace.schema, "wp-codebox/sandbox-workspace/v1")
  assert.equal(metadata.provenance.workspace.root, "/workspace")
  assert.equal(metadata.provenance.workspace.defaultMode, "repo-backed")
  assert.ok(metadata.provenance.workspace.dmc.safeAbilities.includes("datamachine/workspace-edit"))
  assert.ok(metadata.provenance.workspace.dmc.safeAbilities.includes("datamachine/get-github-file"))
  assert.ok(metadata.provenance.workspace.dmc.parentOnlyAbilities.includes("datamachine/workspace-git-push"))
  assert.ok(metadata.provenance.workspace.dmc.parentOnlyAbilities.includes("datamachine/create-github-pull-request"))
  assert.equal(metadata.provenance.workspace.dmc.safeAbilities.includes("datamachine/workspace-git-push"), false)
  assert.ok(metadata.provenance.workspace.mounts.some((mount: { target: string; sourceMode: string; mountRole?: string }) =>
    mount.target === "/wordpress/wp-content/plugins/seeded-helper" && mount.sourceMode === "repo-backed" && mount.mountRole === "recipe-workspace",
  ))
  assert.ok(metadata.provenance.mounts.some((mount: { target: string; mode: string; metadata?: { kind?: string } }) =>
    mount.target === "/wordpress/wp-content/plugins/seeded-helper" && mount.mode === "readwrite" && mount.metadata?.kind === "recipe-workspace",
  ))
  assert.equal(changedFiles.schema, "wp-codebox/changed-files/v1")
  assert.ok(
    changedFiles.files.some((file: { path: string; status: string }) =>
      file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
    ),
  )
  assert.match(patch, /generated\.txt/)
  assert.match(patch, /\+cooked/)
  assert.equal(testResults.schema, "wp-codebox/test-results/v1")
  assert.equal(testResults.status, "unknown")
  assert.deepEqual(testResults.summary, { total: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 })
  assert.deepEqual(testResults.suites, [])
  assert.ok(testResults.rawLogReferences.some((log: { path: string }) => log.path === "logs/commands.log"))
  assert.equal(review.schema, "wp-codebox/artifact-review/v1")
  assert.equal(review.artifactId, artifacts.id)
  assert.deepEqual(review.preview, artifacts.preview)
  assert.equal(review.provenance.task.kind, "recipe-run")
  assert.equal(review.provenance.runtime.wordpressVersion, "latest")
  assert.equal(review.evidence.patch, "files/patch.diff")
  assert.equal(review.evidence.artifactContentDigest, contentDigest)
  assert.equal(review.evidence.changedFiles, "files/changed-files.json")
  assert.equal(review.evidence.testResults, "files/test-results.json")
  assert.equal(review.evidence.runtimeReferenceManifest, "files/runtime-reference-manifest.json")
  assert.equal(runtimeReplayReferenceIndex.schema, RUNTIME_REPLAY_REFERENCE_INDEX_SCHEMA)
  assert.equal(runtimeReplayReferenceIndex.artifactBundle.id, artifacts.id)
  assert.equal(runtimeReplayReferenceIndex.artifactBundle.digest.value, artifacts.contentDigest)
  assert.equal(runtimeReplayReferenceIndex.digest.value, runtimeReplayReferenceIndexDigest(runtimeReplayReferenceIndex).value)
  assert.equal(runtimeReplayReferenceIndex.id, `runtime-replay-reference-index-sha256-${runtimeReplayReferenceIndex.digest.value}`)
  assert.equal(runtimeReplayReferenceIndex.references.runtimeReferenceManifest.path, "files/runtime-reference-manifest.json")
  assert.equal(runtimeReplayReferenceIndex.references.changedFiles.path, "files/changed-files.json")
  assert.equal(runtimeReplayReferenceIndex.references.patch.path, "files/patch.diff")
  assert.equal(runtimeReplayReferenceIndex.replay.status, "partial")
  assert.equal(runtimeReplayReferenceIndex.snapshots.length, 0)
  assert.equal(runtimeReferenceManifest.schema, RUNTIME_REFERENCE_MANIFEST_SCHEMA)
  assert.equal(runtimeReferenceManifest.artifactBundle.id, artifacts.id)
  assert.equal(runtimeReferenceManifest.artifactBundle.digest.value, artifacts.contentDigest)
  assert.equal(runtimeReferenceManifest.digest.value, runtimeReferenceManifestDigest(runtimeReferenceManifest).value)
  assert.equal(runtimeReferenceManifest.id, `runtime-reference-manifest-sha256-${runtimeReferenceManifest.digest.value}`)
  assert.equal(runtimeReferenceManifest.snapshots.length, 0)
  assert.ok(runtimeReferenceManifest.files.some((file: { path: string }) => file.path === "files/changed-files.json"))
  assert.ok(review.changedFiles.some((file: { path: string; status: string }) =>
    file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
  ))
  assert.ok(review.actions.some((action: { kind: string; requiresApprovedFiles?: boolean }) => action.kind === "approve" && action.requiresApprovedFiles === true))
  assert.ok(review.actions.some((action: { kind: string }) => action.kind === "discard"))
  assert.ok(review.progress.some((event: { type: string; label: string }) => event.type === "complete" && event.label === "Ready for your review."))

  const { stdout: runStdout } = await execFileAsync(
    process.execPath,
    [
      "packages/cli/dist/index.js",
      "run",
      "--mount",
      "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
      "--command",
      "wordpress.run-php",
      "--arg",
      "code-file=./examples/simple-plugin/probe.php",
      "--artifacts",
      artifactsDirectory,
      "--preview-public-url",
      "https://run-preview.example.test/",
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  const runOutput = JSON.parse(runStdout)
  assert.equal(runOutput.success, true)
  assert.equal(runOutput.runtime.status, "destroyed")
  assert.equal(runOutput.artifacts.preview.url, "https://run-preview.example.test/")
  assert.equal(runOutput.artifacts.preview.publicUrl, "https://run-preview.example.test/")
  assert.match(runOutput.artifacts.preview.localUrl, /^http:\/\/127\.0\.0\.1:/)

  const agentMount = join(artifactsDirectory, "agent-mounted-component")
  await mkdir(agentMount, { recursive: true })
  await writeFile(join(agentMount, "component.php"), "<?php // fixture\n")

  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      [
        "packages/cli/dist/index.js",
        "run",
        "--mount",
        `${agentMount}:/wordpress/wp-content/plugins/provenance-smoke`,
        "--command",
        "wordpress.phpunit",
        "--arg",
        "code=throw new Error('wp-codebox-canary-cli-fatal');",
        "--artifacts",
        artifactsDirectory,
        "--json",
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        maxBuffer: 1024 * 1024 * 10,
      },
    ),
    (error) => {
      const childError = error as { stdout?: string; stderr?: string }
      assert.match(childError.stdout ?? "", /wp-codebox-canary-cli-fatal/)
      assert.match(childError.stderr ?? "", /wp-codebox-canary-cli-fatal/)
      const output = JSON.parse(childError.stdout ?? "{}")
      assert.match(readFileSync(output.artifacts.commandsLogPath, "utf8"), /wp-codebox-canary-cli-fatal/)
      return true
    },
  )

  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "provenance-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.run-php", "wordpress.phpunit"],
        secrets: "none",
        approvals: "never",
      },
      artifactsDirectory,
      metadata: {
        runtime: { version: "0.0.0" },
        task: { kind: "agent-sandbox-run", input: "Cook provenance smoke" },
        agent: { agent: "sandbox-agent", provider: "openai", model: "gpt-5.5" },
      },
    },
    createPlaygroundRuntimeBackend(),
  )
  await runtime.mount({
    type: "directory",
    source: agentMount,
    target: "/wordpress/wp-content/plugins/provenance-smoke",
    mode: "readonly",
    metadata: { kind: "component", slug: "provenance-smoke" },
  })
  const agentArtifacts = await runtime.collectArtifacts({ includeLogs: true })
  const agentMetadata = JSON.parse(await readFile(agentArtifacts.metadataPath, "utf8"))
  const agentReview = JSON.parse(await readFile(agentArtifacts.reviewPath, "utf8"))
  assert.equal(agentArtifacts.preview?.status, "expired-on-completion")
  assert.equal(agentReview.preview.status, "expired-on-completion")
  assert.equal(agentReview.preview.lifecycle, "destroyed-on-completion")
  assert.equal(agentMetadata.provenance.task.input, "Cook provenance smoke")
  assert.deepEqual(agentMetadata.provenance.agent, { agent: "sandbox-agent", provider: "openai", model: "gpt-5.5" })
  assert.equal(agentReview.provenance.agent.model, "gpt-5.5")
  assert.ok(agentReview.provenance.mounts.some((mount: { target: string; metadata?: { slug?: string } }) =>
    mount.target === "/wordpress/wp-content/plugins/provenance-smoke" && mount.metadata?.slug === "provenance-smoke",
  ))

  await assert.rejects(
    () => runtime.execute({
      command: "wordpress.phpunit",
      args: ["code=throw new Error('wp-codebox-canary-bootstrap-fatal');"],
    }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /wordpress\.phpunit (failed with exit code|crashed before producing a structured response)/)
      assert.match(error.message, /wp-codebox-canary-bootstrap-fatal/)
      assert.match(error.message, /Playground output|Playground errors|=== Stdout ===|=== Stderr ===/)
      return true
    },
  )
  await runtime.destroy()

  const secretName = "WP_CODEBOX_SMOKE_SECRET"
  const secretValue = "fixture-secret-value-64"
  const commonToken = "sk-fixtureSecretTokenForRedaction123456"
  const redactionBaseline = join(artifactsDirectory, "redaction-baseline")
  const redactionMount = join(artifactsDirectory, "redaction-mounted-component")
  await mkdir(redactionBaseline, { recursive: true })
  await mkdir(redactionMount, { recursive: true })
  await writeFile(join(redactionMount, "component.php"), "<?php // redaction fixture\n")
  const redactionRuntime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "redaction-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.run-php"],
        secrets: "connector-scoped",
        approvals: "never",
      },
      artifactsDirectory,
      secretEnv: { [secretName]: secretValue },
      metadata: {
        runtime: { version: "0.0.0" },
        task: {
          kind: "agent-sandbox-run",
          input: `Redact ${secretName}`,
          inheritance: {
            connectors: [
              {
                name: "primary-ai",
                status: "resolved",
                provider: "openai",
                model: "gpt-5.5",
                credentials: {
                  schema: "wp-codebox/connector-credentials/v1",
                  connector: "primary-ai",
                  scope: "connector",
                  status: "available",
                  secrets: [
                    { name: secretName, status: "available", scope: "primary-ai", source: "parent-env" },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    createPlaygroundRuntimeBackend(),
  )
  await redactionRuntime.mount({
    type: "directory",
    source: redactionMount,
    target: "/wordpress/wp-content/plugins/redaction-smoke",
    mode: "readwrite",
    metadata: { kind: "component", slug: "redaction-smoke", baselineSource: redactionBaseline },
  })
  await redactionRuntime.execute({
    command: "wordpress.run-php",
    args: [
      `code=file_put_contents('/wordpress/wp-content/plugins/redaction-smoke/leak.txt', getenv('${secretName}') . "\\n${commonToken}\\n"); echo getenv('${secretName}') . " ${commonToken}";`,
    ],
  })
  const redactionArtifacts = await redactionRuntime.collectArtifacts({ includeLogs: true })
  const redactionMetadataText = await readFile(redactionArtifacts.metadataPath, "utf8")
  const redactionPatch = await readFile(redactionArtifacts.patchPath, "utf8")
  const redactionCommandsLog = await readFile(redactionArtifacts.commandsLogPath, "utf8")
  const redactionReview = JSON.parse(await readFile(redactionArtifacts.reviewPath, "utf8"))
  const redactionMountedFile = await readFile(join(redactionArtifacts.directory, "files/mounts/0/leak.txt"), "utf8")

  for (const [artifactName, artifactText] of Object.entries({
    metadata: redactionMetadataText,
    patch: redactionPatch,
    commandsLog: redactionCommandsLog,
    mountedFile: redactionMountedFile,
  })) {
    assert.equal(artifactText.includes(secretName), false, `${artifactName} should redact configured secret names`)
    assert.equal(artifactText.includes(secretValue), false, `${artifactName} should redact configured secret values`)
    assert.equal(artifactText.includes(commonToken), false, `${artifactName} should redact common token patterns`)
  }
  assert.match(redactionPatch, /\[REDACTED:configured-secret-value\]/)
  assert.match(redactionPatch, /\[REDACTED:openai-api-key\]/)
  assert.equal(redactionReview.redaction.status, "redacted")
  assert.ok(redactionReview.redaction.total >= 3)
  assert.ok(redactionReview.riskFlags.includes("secrets-redacted"))
  assert.equal(redactionReview.provenance.task.inheritance.connectors[0].credentials.schema, "wp-codebox/connector-credentials/v1")
  assert.equal(redactionReview.provenance.task.inheritance.connectors[0].credentials.status, "available")
  await redactionRuntime.destroy()

  console.log("Artifact contract smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
