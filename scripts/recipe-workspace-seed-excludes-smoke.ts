import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-workspace-seed-excludes-smoke")
const source = resolve(workspace, "source")
const recipePath = resolve(workspace, "recipe.json")

mkdirSync(resolve(source, "src"), { recursive: true })
mkdirSync(resolve(source, "target/release"), { recursive: true })
mkdirSync(resolve(source, "node_modules/example"), { recursive: true })
mkdirSync(resolve(source, ".git/objects"), { recursive: true })
writeFileSync(resolve(source, "src/keep.txt"), "keep\n")
writeFileSync(resolve(source, "target/release/build-output.txt"), "skip\n")
writeFileSync(resolve(source, "node_modules/example/index.js"), "skip\n")
writeFileSync(resolve(source, ".git/HEAD"), "skip\n")
writeFileSync(resolve(source, ".env"), "skip\n")

writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "workspace-seed-excludes-smoke",
    wp: "7.0",
  },
  inputs: {
    workspaces: [
      {
        seed: {
          type: "directory",
          source: "./source",
          slug: "seed-source",
        },
        target: "/workspace/seed-source",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [
          "code=$root = '/workspace/seed-source'; $git_head = $root . '/.git/HEAD'; echo wp_json_encode(array('keep' => file_exists($root . '/src/keep.txt'), 'target' => file_exists($root . '/target/release/build-output.txt'), 'node_modules' => file_exists($root . '/node_modules/example/index.js'), 'git_head' => file_exists($git_head) ? trim(file_get_contents($git_head)) : '', 'env' => file_exists($root . '/.env')));",
        ],
      },
    ],
  },
}, null, 2)}\n`)

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--json",
], { cwd: workspace, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)

const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
const executionOutput = JSON.parse(output.executions[0].stdout)
assert.equal(executionOutput.git_head.includes("skip"), false)
delete executionOutput.git_head
assert.deepEqual(executionOutput, {
  keep: true,
  target: false,
  node_modules: false,
  env: false,
})
