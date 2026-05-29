import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RUNTIME_ACTION_OBSERVATION_SCHEMA,
  RuntimeActionPolicyError,
  createRuntimeEpisode,
  runRuntimeAction,
  validateRuntimeEpisodeTrace,
} from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

const tempRoot = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-action-"))
const workspaceRoot = join(tempRoot, "workspace")
const artifactsDirectory = join(tempRoot, "artifacts")

try {
  await mkdir(workspaceRoot, { recursive: true })
  await writeFile(join(workspaceRoot, "seed.txt"), "seed")

  const mounts = [{ type: "directory" as const, source: workspaceRoot, target: "/workspace", mode: "readwrite" as const }]
  const episode = await createRuntimeEpisode(
    {
      runtime: {
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "runtime-action-adapter-smoke", version: "7.0", blueprint: { steps: [] } },
        policy: {
          network: "deny",
          filesystem: "readwrite-mounts",
          commands: ["wordpress.wp-cli", "wordpress.browser-actions", "inspect-mounted-inputs"],
          secrets: "none",
          approvals: "never",
        },
        artifactsDirectory,
        metadata: { task: { kind: "runtime-action-adapter-smoke" } },
      },
      mounts,
      resetObservations: [{ type: "mounts" }],
      artifactSpec: { includeLogs: true, includeObservations: true },
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    const policy = { mounts, filesystem: "readwrite-mounts" as const, writableRoots: ["/workspace"] }

    const wpCli = await runRuntimeAction(episode, { type: "wp_cli", command: "wp option get siteurl" }, policy)
    assert.equal(wpCli.schema, RUNTIME_ACTION_OBSERVATION_SCHEMA)
    assert.equal(wpCli.type, "wp_cli")
    assert.equal(wpCli.step?.action.command, "wordpress.wp-cli")
    assert.deepEqual(wpCli.step?.action.args, ["command=option get siteurl"])
    assert.equal(wpCli.step?.observation?.type, "command-result")
    assert.match(String(wpCli.data.stdout), /^http/)
    assert.equal(wpCli.digest.algorithm, "sha256")

    const write = await runRuntimeAction(episode, { type: "filesystem", operation: "write", path: "notes/hello.txt", content: "hello" }, policy)
    assert.equal(write.schema, RUNTIME_ACTION_OBSERVATION_SCHEMA)
    assert.equal(write.step?.action.kind, "filesystem")
    assert.equal(write.step?.action.command, "inspect-mounted-inputs")
    assert.equal(write.step?.action.path, "/workspace/notes/hello.txt")
    assert.equal(write.step?.action.operation, "write")
    assert.equal(await readFile(join(workspaceRoot, "notes/hello.txt"), "utf8"), "hello")

    const read = await runRuntimeAction(episode, { type: "filesystem", operation: "read", path: "/workspace/notes/hello.txt" }, policy)
    assert.equal(read.data.content, "hello")

    const list = await runRuntimeAction(episode, { type: "filesystem", operation: "list", path: "/workspace" }, policy)
    assert.deepEqual(
      (list.data.entries as Array<{ name: string }>).map((entry) => entry.name),
      ["notes", "seed.txt"],
    )

    const browser = await runRuntimeAction(episode, { type: "browser", operation: "navigate", url: "/", capture: ["actions", "errors"] }, policy)
    assert.equal(browser.schema, RUNTIME_ACTION_OBSERVATION_SCHEMA)
    assert.equal(browser.type, "browser")
    assert.equal(browser.data.operation, "navigate")
    assert.equal(browser.step?.action.kind, "browser")
    assert.equal(browser.step?.execution.command, "wordpress.browser-actions")
    assert.deepEqual(browser.step?.execution.args, [
      'actions-json=[{"type":"navigate","url":"/"}]',
      "capture=actions,errors",
    ])

    const deleteResult = await runRuntimeAction(episode, { type: "filesystem", operation: "delete", path: "/workspace/notes/hello.txt" }, policy)
    assert.equal(deleteResult.data.deleted, true)

    await assert.rejects(
      () => runRuntimeAction(episode, { type: "filesystem", operation: "write", path: "/tmp/outside.txt", content: "nope" }, policy),
      RuntimeActionPolicyError,
    )
    await assert.rejects(
      () => runRuntimeAction(episode, { type: "filesystem", operation: "write", path: "/workspace/nope.txt", content: "nope" }, { ...policy, writableRoots: ["/workspace/allowed"] }),
      RuntimeActionPolicyError,
    )

    const trace = await episode.trace()
    assert.equal(trace.steps.length, 6)
    assert.equal(trace.steps.filter((step) => step.action.kind === "filesystem").length, 4)
    assert.equal(trace.steps.filter((step) => step.action.kind === "browser").length, 1)
    assert.equal(validateRuntimeEpisodeTrace(trace).valid, true)
  } finally {
    await episode.close()
  }

  console.log("Runtime action adapter smoke passed")
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
