import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntimeEpisode } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-episode-"))

try {
  const episode = await createRuntimeEpisode(
    {
      runtime: {
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "episode-smoke", version: "7.0", blueprint: { steps: [] } },
        policy: {
          network: "deny",
          filesystem: "readwrite-mounts",
          commands: ["wordpress.wp-cli", "wordpress.run-php"],
          secrets: "none",
          approvals: "never",
        },
        artifactsDirectory,
        metadata: {
          runtime: { version: "0.0.0" },
          task: { kind: "runtime-episode-smoke" },
        },
      },
      resetObservations: [{ type: "runtime-info" }],
      stepObservation: { type: "runtime-info" },
      artifactSpec: { includeLogs: true, includeObservations: true },
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    const createPost = await episode.step({
      command: "wordpress.wp-cli",
      args: ["command=post create --post_type=page --post_status=publish --post_title='Episode Smoke' --porcelain"],
    })
    assert.equal(createPost.index, 0)
    assert.equal(createPost.execution.exitCode, 0)
    assert.match(createPost.execution.stdout, /\d+/)
    assert.equal(createPost.observation?.type, "runtime-info")

    const queryPost = await episode.step({
      command: "wordpress.run-php",
      args: ["code=$post = get_page_by_title('Episode Smoke'); echo $post ? $post->post_title : '';"],
    })
    assert.equal(queryPost.index, 1)
    assert.equal(queryPost.execution.stdout.trim(), "Episode Smoke")

    const snapshot = await episode.snapshot()
    assert.match(snapshot.id, /^snapshot-/)

    const artifacts = await episode.collectArtifacts()
    const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8"))
    assert.equal(metadata.provenance.task.kind, "runtime-episode-smoke")

    const trace = await episode.trace()
    assert.equal(trace.schema, "wp-codebox/runtime-episode-trace/v1")
    assert.equal(trace.steps.length, 2)
    assert.equal(trace.snapshots.length, 1)
    assert.equal(trace.reset.observations.length, 1)
    assert.equal(trace.artifacts?.id, artifacts.id)
  } finally {
    await episode.close()
  }

  console.log("Runtime episode smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
