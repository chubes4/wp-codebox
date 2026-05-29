import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/ability-login-blueprint-smoke")
const artifactDirectory = resolve(workspace, "artifacts")
const sourceRecipePath = resolve(root, "examples/recipes/datamachine-agent-bundle.json")
const bundlePath = resolve(root, "examples/datamachine-bundle/world-creator-lite")
const agentsApiPath = resolve(root, "../agents-api")
const dataMachinePath = resolve(root, "../data-machine")

for (const requiredPath of [sourceRecipePath, bundlePath, agentsApiPath, dataMachinePath]) {
  assert(existsSync(requiredPath), `Missing required smoke fixture path: ${requiredPath}`)
}

mkdirSync(workspace, { recursive: true })

function writeRecipe(name: string, blueprint: Record<string, unknown>): string {
  const recipe = JSON.parse(readFileSync(sourceRecipePath, "utf8"))
  recipe.runtime.blueprint = blueprint
  recipe.inputs.extra_plugins[0].source = agentsApiPath
  recipe.inputs.extra_plugins[1].source = dataMachinePath
  recipe.inputs.mounts[0].source = bundlePath

  const path = resolve(workspace, `${name}.json`)
  writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`)
  return path
}

function runRecipe(path: string): Record<string, any> {
  const result = spawnSync(process.execPath, [
    cli,
    "recipe-run",
    "--recipe",
    path,
    "--artifacts",
    artifactDirectory,
    "--json",
  ], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 20 })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function assertAbilityImport(output: Record<string, any>, label: string): void {
  assert.equal(output.success, true, `${label} recipe should succeed`)
  const abilityExecution = output.executions.find((execution: { command: string }) => execution.command === "wordpress.ability")
  assert(abilityExecution, `${label} recipe should execute wordpress.ability`)
  assert.equal(abilityExecution.exitCode, 0)
  assert.notEqual(abilityExecution.stdout.trim(), "", `${label} wordpress.ability stdout must not be empty`)

  const abilityOutput = JSON.parse(abilityExecution.stdout)
  assert.equal(abilityOutput.command, "wordpress.ability")
  assert.equal(abilityOutput.name, "datamachine/import-agent")
  assert.equal(abilityOutput.result?.success, true)
  assert.equal(abilityOutput.result?.summary?.agent_slug, "world-creator-lite")
}

assertAbilityImport(runRecipe(writeRecipe("without-login", { steps: [] })), "without-login")
assertAbilityImport(runRecipe(writeRecipe("with-login", {
  steps: [{
    step: "login",
    username: "admin",
    password: "password",
  }],
})), "with-login")
