import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-dry-run-smoke")
const recipePath = resolve(workspace, "recipe.json")
const invalidRecipePath = resolve(workspace, "invalid-recipe.json")
const dryRunArtifacts = resolve(workspace, "dry-run-artifacts")

mkdirSync(workspace, { recursive: true })
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "dry-run-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    secretEnv: ["DRY_RUN_TOKEN"],
    workspaces: [
      {
        seed: {
          type: "plugin_scaffold",
          slug: "dry-run-plugin",
        },
      },
    ],
    extraPlugins: [
      {
        source: "../../examples/simple-plugin",
        slug: "simple-plugin",
        pluginFile: "simple-plugin/simple-plugin.php",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'dry run';"],
      },
      {
        command: "wordpress.wp-cli",
        args: ["command=option get home"],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(invalidRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [],
      },
    ],
  },
}, null, 2)}\n`)

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  dryRunArtifacts,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, DRY_RUN_TOKEN: "redacted-value" } })

assert.equal(result.status, 0, result.stderr || result.stdout)
assert.equal(existsSync(dryRunArtifacts), false, "dry-run must not create artifact directories")

const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.schema, "wp-codebox/recipe-run-dry-run/v1")
assert.equal(output.dryRun, true)
assert.equal(output.valid, true)
assert.equal(output.plan.runtime.backend, "wordpress-playground")
assert.equal(output.plan.workspaces.length, 1)
assert.equal(output.plan.workspaces[0].generated, true)
assert.equal(output.plan.workspaces[0].source, undefined)
assert.equal(output.plan.extra_plugins[0].target, "/wordpress/wp-content/plugins/simple-plugin")
assert.equal(output.plan.secretEnv[0].name, "DRY_RUN_TOKEN")
assert.equal(Object.prototype.hasOwnProperty.call(output.plan.secretEnv[0], "value"), false)
assert.equal(output.plan.secretEnv[0].available, true)
assert.equal(output.plan.workflow.steps.length, 3)
assert.equal(output.plan.workflow.steps[0].command, "activate-extra-plugins")
assert.equal(output.plan.workflow.steps[0].policy.status, "allowed")
assert.equal(output.plan.workflow.steps[1].resolvedCommand, "wordpress.run-php")
assert.equal(output.plan.workflow.steps[1].resolvedParsedArgs.code, "echo 'dry run';")
assert.equal(output.plan.workflow.steps[2].parsedArgs.command, "option get home")
assert.equal(output.plan.workflow.steps[2].policy.status, "allowed")
assert.equal(output.runtime, undefined)
assert.equal(output.executions, undefined)
assert.equal(output.artifacts, undefined)

const invalidResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  invalidRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(invalidResult.status, 1, invalidResult.stderr || invalidResult.stdout)
const invalidOutput = JSON.parse(invalidResult.stdout)
assert.equal(invalidOutput.success, false)
assert.equal(invalidOutput.valid, false)
assert.equal(invalidOutput.validation.issues[0].code, "missing-code")

console.log("recipe dry-run smoke passed")
