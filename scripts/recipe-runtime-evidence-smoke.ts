import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-recipe-runtime-evidence-"))

try {
  const source = join(workspace, "source")
  await mkdir(join(source, "src"), { recursive: true })
  await writeFile(join(source, "src", "index.php"), "<?php\n")

  const passingRecipe = join(workspace, "passing.json")
  const passingArtifacts = join(workspace, "passing-artifacts")
  await writeRecipe(passingRecipe, source, passingArtifacts, {
    verify: { strict: true },
    workspacePolicy: { strict: true, writableRoots: ["src"], gitBacked: true },
  })

  const passing = await recipeRun(passingRecipe)
  assert.equal(passing.success, true, passing.error?.message)
  assert.ok(passing.artifacts?.directory, "recipe-run should return an artifact directory")

  const passingManifest = JSON.parse(await readFile(join(passing.artifacts.directory, "manifest.json"), "utf8"))
  assertManifestFile(passingManifest, "files/runtime-evidence/run-attestation.json", "run-attestation")
  assertManifestFile(passingManifest, "files/runtime-evidence/artifact-bundle-verification.json", "artifact-bundle-verification")
  assertManifestFile(passingManifest, "files/runtime-evidence/workspace-policy.json", "workspace-policy-result")

  const passingMetadata = JSON.parse(await readFile(join(passing.artifacts.directory, "metadata.json"), "utf8"))
  assert.match(passingMetadata.evidence.runtimeEvidence["run-attestation"].sha256, /^[a-f0-9]{64}$/)
  assert.match(passingMetadata.evidence.runtimeEvidence["artifact-bundle-verification"].sha256, /^[a-f0-9]{64}$/)
  assert.match(passingMetadata.evidence.runtimeEvidence["workspace-policy-result"].sha256, /^[a-f0-9]{64}$/)

  const passingReview = JSON.parse(await readFile(join(passing.artifacts.directory, "files/review.json"), "utf8"))
  assert.equal(passingReview.evidence.runtimeEvidence["run-attestation"].path, "files/runtime-evidence/run-attestation.json")
  assert.equal(passingReview.evidence.runtimeEvidence["artifact-bundle-verification"].path, "files/runtime-evidence/artifact-bundle-verification.json")
  assert.equal(passingReview.evidence.runtimeEvidence["workspace-policy-result"].path, "files/runtime-evidence/workspace-policy.json")

  const attestation = JSON.parse(await readFile(join(passing.artifacts.directory, "files/runtime-evidence/run-attestation.json"), "utf8"))
  assert.equal(attestation.schema, "wp-codebox/run-attestation/v1")
  assert.equal(attestation.package.name, "wp-codebox")
  assert.match(attestation.package.commit, /^[a-f0-9]{40}$/)
  assert.equal(attestation.backend.kind, "wordpress-playground")
  assert.equal(attestation.backend.package.name, "@chubes4/wp-codebox-playground")
  assert.equal(attestation.backend.engine.name, "@wp-playground/cli")
  assert.equal(attestation.runtime.kind, "wordpress")
  assert.equal(attestation.runtime.version, "7.0")
  assert.match(attestation.policy.command.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(attestation.policy.command.allowedCommands, ["inspect-mounted-inputs"])
  assert.equal(attestation.policy.network.enforcement, "enforced")
  assert.equal(attestation.policy.filesystem.enforcement, "enforced")
  assert.equal(attestation.policy.secrets.enforcement, "enforced")
  assert.equal(attestation.policy.approvals.enforcement, "enforced")
  assert.equal(attestation.policy.workspace.enforcement, "enforced")
  assert.equal(attestation.policy.artifactVerifier.enforcement, "enforced")
  assert.equal(attestation.evidenceRefs.workspacePolicyResult.path, "files/runtime-evidence/workspace-policy.json")
  assert.equal(attestation.evidenceRefs.artifactVerifierResult.path, "files/runtime-evidence/artifact-bundle-verification.json")
  assert.equal(attestation.secretEnvelope.count, 0)

  const verifier = JSON.parse(await readFile(join(passing.artifacts.directory, "files/runtime-evidence/artifact-bundle-verification.json"), "utf8"))
  assert.equal(verifier.schema, "wp-codebox/artifact-bundle-verification/v1")
  assert.equal(verifier.valid, true)

  const policy = JSON.parse(await readFile(join(passing.artifacts.directory, "files/runtime-evidence/workspace-policy.json"), "utf8"))
  assert.equal(policy.schema, "wp-codebox/workspace-policy-artifacts/v1")
  assert.equal(policy.passed, true)

  await mkdir(join(source, "private"), { recursive: true })
  await writeFile(join(source, "private", "secret.txt"), "secret\n")
  const failingRecipe = join(workspace, "failing-policy.json")
  const failingArtifacts = join(workspace, "failing-artifacts")
  await writeRecipe(failingRecipe, source, failingArtifacts, {
    verify: true,
    workspacePolicy: { strict: true, writableRoots: ["src", "private"], hiddenPaths: ["private"], gitBacked: true },
  })

  const failing = await recipeRun(failingRecipe, false)
  assert.equal(failing.success, false)
  assert.equal(failing.error?.code, "workspace-policy-failed")
  assert.ok(failing.artifacts?.directory, "failing strict policy run should keep artifacts")
  const failingPolicy = JSON.parse(await readFile(join(failing.artifacts.directory, "files/runtime-evidence/workspace-policy.json"), "utf8"))
  assert.equal(failingPolicy.passed, false)
  assert.ok(failingPolicy.checks[0].result.violations.some((violation: { code: string }) => violation.code === "hidden-path"))

  const uncheckedMountRecipe = join(workspace, "unchecked-readwrite-mount.json")
  const uncheckedMountArtifacts = join(workspace, "unchecked-readwrite-mount-artifacts")
  await writeRecipeWithUncheckedMount(uncheckedMountRecipe, source, uncheckedMountArtifacts)

  const uncheckedMount = await recipeRun(uncheckedMountRecipe, false)
  assert.equal(uncheckedMount.success, false)
  assert.equal(uncheckedMount.error?.code, "workspace-policy-failed")
  const uncheckedMountPolicy = JSON.parse(await readFile(join(uncheckedMount.artifacts.directory, "files/runtime-evidence/workspace-policy.json"), "utf8"))
  assert.equal(uncheckedMountPolicy.passed, false)
  assert.ok(uncheckedMountPolicy.checks.some((check: { workspace: { metadata?: { sourceField?: string } } }) => check.workspace.metadata?.sourceField === "inputs.mounts[0]"))

  console.log("Recipe runtime evidence smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeRecipeWithUncheckedMount(recipePath: string, source: string, artifacts: string): Promise<void> {
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    inputs: {
      mounts: [
        {
          source,
          target: "/workspace-unchecked",
          mode: "readwrite",
        },
      ],
    },
    workflow: {
      steps: [{ command: "inspect-mounted-inputs" }],
    },
    artifacts: {
      directory: artifacts,
      verify: true,
      workspacePolicy: { strict: true, writableRoots: ["."], gitBacked: false },
    },
  }, null, 2)}\n`)
}

async function writeRecipe(recipePath: string, source: string, artifacts: string, artifactOptions: Record<string, unknown>): Promise<void> {
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { wp: "7.0" },
    inputs: {
      workspaces: [
        {
          target: "/workspace",
          mode: "readwrite",
          seed: { type: "directory", source },
        },
      ],
    },
    workflow: {
      steps: [{ command: "inspect-mounted-inputs" }],
    },
    artifacts: {
      directory: artifacts,
      ...artifactOptions,
    },
  }, null, 2)}\n`)
}

async function recipeRun(recipePath: string, expectSuccess = true): Promise<any> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], { cwd: root })
    return JSON.parse(stdout)
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    if (expectSuccess) {
      throw error
    }
    assert.ok(failed.stdout, failed.stderr)
    return JSON.parse(failed.stdout)
  }
}

function assertManifestFile(manifest: { files: Array<{ path: string; kind: string }> }, path: string, kind: string): void {
  assert.ok(manifest.files.some((file) => file.path === path && file.kind === kind), `Expected manifest entry ${kind} at ${path}`)
}
