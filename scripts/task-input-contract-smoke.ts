import { readFile } from "node:fs/promises"
import { normalizeTaskInput, TASK_INPUT_JSON_SCHEMA, TASK_INPUT_SCHEMA, TASK_INPUT_VERSION } from "@chubes4/wp-codebox-core"

interface Fixture {
  name: string
  input: Parameters<typeof normalizeTaskInput>[0]
  normalized: ReturnType<typeof normalizeTaskInput>
}

const fixtures = JSON.parse(await readFile(new URL("../tests/fixtures/task-input-normalization.json", import.meta.url), "utf8")) as Fixture[]

if (TASK_INPUT_JSON_SCHEMA.$id !== TASK_INPUT_SCHEMA) throw new Error("Task input schema id drifted.")
if (TASK_INPUT_JSON_SCHEMA.properties.version.const !== TASK_INPUT_VERSION) throw new Error("Task input schema version drifted.")

for (const fixture of fixtures) {
  const normalized = normalizeTaskInput(fixture.input)
  if (JSON.stringify(normalized) !== JSON.stringify(fixture.normalized)) {
    throw new Error(`Task input fixture failed: ${fixture.name}`)
  }
}

console.log(`task input contract smoke ok (${fixtures.length} fixtures)`)
