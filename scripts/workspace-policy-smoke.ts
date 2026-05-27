import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { checkWorkspacePolicy } from "@chubes4/wp-codebox-core"

const execFileAsync = promisify(execFile)

const root = await mkdtemp(join(tmpdir(), "wp-codebox-workspace-policy-"))
await mkdir(join(root, "src"), { recursive: true })
await writeFile(join(root, "src", "index.js"), "export const ok = true\n")

const passing = await checkWorkspacePolicy({
  workspaceRoot: root,
  writableRoots: ["src/../src"],
  hiddenPaths: ["private"],
})
assert.equal(passing.passed, true)
assert.equal(passing.schema, "wp-codebox/workspace-policy-result/v1")
assert.match(passing.policy_sha256, /^[a-f0-9]{64}$/)

await mkdir(join(root, "private"), { recursive: true })
await writeFile(join(root, "private", "secret.txt"), "secret\n")
await symlink("../private/secret.txt", join(root, "src", "secret-link"))
await writeFile(join(root, "src", "hardlink-source.txt"), "linked\n")
await link(join(root, "src", "hardlink-source.txt"), join(root, "src", "hardlink-copy.txt"))
await mkdir(join(root, "src", "nested", ".git"), { recursive: true })
await writeFile(join(root, "src", "nested", ".git", "config"), "[core]\n")
await execFileAsync("mkfifo", [join(root, "src", "pipe")])

const failing = await checkWorkspacePolicy({
  workspaceRoot: root,
  writableRoots: ["src"],
  hiddenPaths: ["private"],
})
const violationCodes = new Set(failing.violations.map((violation) => violation.code))
assert.equal(failing.passed, false)
assert.ok(violationCodes.has("path-outside-writable-roots"))
assert.ok(violationCodes.has("hidden-path"))
assert.ok(violationCodes.has("symlink"))
assert.ok(violationCodes.has("hardlink"))
assert.ok(violationCodes.has("nested-git-metadata"))
assert.ok(violationCodes.has("special-file"))

const invalidPolicy = await checkWorkspacePolicy({
  workspaceRoot: root,
  writableRoots: ["../outside"],
})
assert.equal(invalidPolicy.passed, false)
assert.ok(invalidPolicy.violations.some((violation) => violation.code === "invalid-policy-path"))

const gitRoot = await mkdtemp(join(tmpdir(), "wp-codebox-workspace-policy-git-"))
await execFileAsync("git", ["init"], { cwd: gitRoot })
await mkdir(join(gitRoot, "src"), { recursive: true })
await writeFile(join(gitRoot, ".gitignore"), "src/ignored.txt\n")
await writeFile(join(gitRoot, "src", "ignored.txt"), "ignored\n")
await execFileAsync("git", ["update-index", "--add", "--cacheinfo", "160000", "0123456789012345678901234567890123456789", "src/submodule"], { cwd: gitRoot })
await writeFile(join(gitRoot, "base.txt"), "base\n")
await writeFile(join(gitRoot, "ours.txt"), "ours\n")
await writeFile(join(gitRoot, "theirs.txt"), "theirs\n")
const baseHash = (await execFileAsync("git", ["hash-object", "-w", "base.txt"], { cwd: gitRoot })).stdout.trim()
const oursHash = (await execFileAsync("git", ["hash-object", "-w", "ours.txt"], { cwd: gitRoot })).stdout.trim()
const theirsHash = (await execFileAsync("git", ["hash-object", "-w", "theirs.txt"], { cwd: gitRoot })).stdout.trim()
const unmerged = spawnSync("git", ["update-index", "--index-info"], {
  cwd: gitRoot,
  input: `100644 ${baseHash} 1\tsrc/conflict.txt\n100644 ${oursHash} 2\tsrc/conflict.txt\n100644 ${theirsHash} 3\tsrc/conflict.txt\n`,
})
assert.equal(unmerged.status, 0, unmerged.stderr.toString())
const gitBacked = await checkWorkspacePolicy({
  workspaceRoot: gitRoot,
  writableRoots: ["src"],
  gitBacked: true,
})
assert.equal(gitBacked.passed, false)
assert.ok(gitBacked.violations.some((violation) => violation.code === "ignored-path" && violation.path === "src/ignored.txt"))
assert.ok(gitBacked.violations.some((violation) => violation.code === "gitlink" && violation.path === "src/submodule"))
assert.ok(gitBacked.violations.some((violation) => violation.code === "unmerged-index" && violation.path === "src/conflict.txt"))

const cli = await execFileAsync(process.execPath, [
  "packages/cli/dist/index.js",
  "workspace-policy",
  "check",
  "--workspace-root",
  root,
  "--writable-root",
  "src",
  "--hidden-path",
  "private",
  "--json",
], { cwd: process.cwd(), encoding: "utf8" }).catch((error: unknown) => {
  const failed = error as { stdout?: string }
  return { stdout: failed.stdout ?? "" }
})
const cliOutput = JSON.parse(cli.stdout) as Awaited<ReturnType<typeof checkWorkspacePolicy>>
assert.equal(cliOutput.schema, "wp-codebox/workspace-policy-result/v1")
assert.equal(cliOutput.passed, false)

console.log("Workspace policy smoke passed")
