import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Ajv from "ajv"
import {
  RUNTIME_EPISODE_TRACE_JSON_SCHEMA,
  RUNTIME_EPISODE_TRACE_SCHEMA,
  RUNTIME_EPISODE_ACTION_SCHEMA,
  RUNTIME_EPISODE_OBSERVATION_SCHEMA,
  createRuntimeEpisode,
  validateRuntimeEpisodeTrace,
} from "@chubes4/wp-codebox-core"
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
    assert.match(createPost.id, /^command-.+:step:0$/)
    assert.equal(createPost.index, 0)
    assert.equal(createPost.action.schema, RUNTIME_EPISODE_ACTION_SCHEMA)
    assert.equal(createPost.action.kind, "command")
    assert.deepEqual(createPost.action.args, ["command=post create --post_type=page --post_status=publish --post_title='Episode Smoke' --porcelain"])
    assert.match(createPost.action.id, /:action$/)
    assert.equal(createPost.actionRef.id, createPost.action.id)
    assert.equal(createPost.actionRef.kind, "action")
    assert.equal(createPost.actionRef.digest?.algorithm, "sha256")
    assert.equal(createPost.actionRef.digest?.value, createPost.action.digest.value)
    assert.equal(createPost.execution.exitCode, 0)
    assert.equal(createPost.executionRef.id, createPost.execution.id)
    assert.equal(createPost.executionRef.digest?.value.length, 64)
    assert.match(createPost.execution.stdout, /\d+/)
    assert.equal(createPost.observation?.schema, RUNTIME_EPISODE_OBSERVATION_SCHEMA)
    assert.equal(createPost.observation?.type, "runtime-info")
    assert.ok(createPost.observation?.id)
    assert.equal(createPost.observation?.digest?.algorithm, "sha256")
    assert.equal(createPost.observationRef?.id, createPost.observation?.id)
    assert.equal(createPost.observationRef?.digest?.value, createPost.observation?.digest?.value)

    const queryPost = await episode.step({
      command: "wordpress.run-php",
      args: ["code=$post = get_page_by_title('Episode Smoke'); echo $post ? $post->post_title : '';"],
    })
    assert.equal(queryPost.index, 1)
    assert.equal(queryPost.execution.stdout.trim(), "Episode Smoke")

    const snapshot = await episode.snapshot()
    assert.match(snapshot.id, /^snapshot-/)
    assert.equal(snapshot.semantics, "metadata-only")

    const artifacts = await episode.collectArtifacts()
    const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8"))
    assert.equal(metadata.provenance.task.kind, "runtime-episode-smoke")

    const trace = await episode.trace()
    assert.equal(RUNTIME_EPISODE_TRACE_JSON_SCHEMA.$id, RUNTIME_EPISODE_TRACE_SCHEMA)
    const validateJsonSchema = new Ajv({ strict: false }).compile(RUNTIME_EPISODE_TRACE_JSON_SCHEMA)
    assert.equal(validateJsonSchema(trace), true, JSON.stringify(validateJsonSchema.errors, null, 2))
    assert.equal(trace.schema, RUNTIME_EPISODE_TRACE_SCHEMA)
    assert.equal(trace.version, 1)
    assert.match(trace.id, /^trace-runtime-/)
    assert.equal(trace.steps.length, 2)
    assert.equal(trace.snapshots.length, 1)
    assert.equal(trace.reset.observations.length, 1)
    assert.equal(trace.reset.observationRefs.length, 1)
    assert.equal(trace.artifacts?.id, artifacts.id)
    assert.equal(trace.artifactRef?.id, artifacts.id)
    assert.equal(trace.artifactRef?.digest?.value, artifacts.contentDigest)
    const validation = validateRuntimeEpisodeTrace(trace)
    assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2))
    assert.equal(
      validateRuntimeEpisodeTrace({ ...trace, reward: 1 }).valid,
      false,
      "trace validator must reject eval-specific fields",
    )

    const missingActionSchema = structuredClone(trace)
    delete (missingActionSchema.steps[0].action as Partial<typeof missingActionSchema.steps[0]["action"]>).schema
    assert.equal(
      validateRuntimeEpisodeTrace(missingActionSchema).valid,
      false,
      "trace validator must reject action envelopes without a schema",
    )

    const malformedActionArgs = structuredClone(trace)
    ;(malformedActionArgs.steps[0].action as unknown as { args: unknown }).args = "command=post list"
    assert.equal(
      validateRuntimeEpisodeTrace(malformedActionArgs).valid,
      false,
      "trace validator must reject action envelopes with non-array args",
    )

    const mismatchedActionRefDigest = structuredClone(trace)
    mismatchedActionRefDigest.steps[0].actionRef.digest = { algorithm: "sha256", value: "0".repeat(64) }
    assert.equal(
      validateRuntimeEpisodeTrace(mismatchedActionRefDigest).valid,
      false,
      "trace validator must reject action refs whose digest does not match the action envelope",
    )

    const missingObservationDigest = structuredClone(trace)
    delete missingObservationDigest.steps[0].observation?.digest
    assert.equal(
      validateRuntimeEpisodeTrace(missingObservationDigest).valid,
      false,
      "trace validator must reject observation envelopes without digests",
    )

    const malformedResetObservation = structuredClone(trace)
    ;(malformedResetObservation.reset.observations[0] as unknown as { observedAt: unknown }).observedAt = null
    assert.equal(
      validateRuntimeEpisodeTrace(malformedResetObservation).valid,
      false,
      "trace validator must reject malformed reset observation envelopes",
    )
  } finally {
    await episode.close()
  }

  console.log("Runtime episode smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
