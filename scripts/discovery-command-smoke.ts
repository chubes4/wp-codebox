import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import Ajv2020 from "ajv/dist/2020.js"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cliPath = resolve(repoRoot, "packages/cli/dist/index.js")

interface CommandCatalogOutput {
  schema: "wp-codebox/command-catalog/v1"
  commands: Array<{
    id: string
    description: string
    acceptedArgs: Array<{ name: string; description: string; required?: boolean; repeatable?: boolean; format?: string }>
    outputShape: string
    policyRequirement: string
    recipe: boolean
  }>
}

interface RecipeSchemaOutput {
  schema: "wp-codebox/json-schema/v1"
  id: "wp-codebox/workspace-recipe/v1"
  jsonSchema: Record<string, unknown>
}

const expectedCommandIds = [
  "inspect-mounted-inputs",
  "wordpress.run-php",
  "wordpress.wp-cli",
  "wordpress.ability",
  "wordpress.bench",
  "wordpress.phpunit",
  "wordpress.core-phpunit",
  "wordpress.browser-probe",
  "wp-codebox.agent-runtime-probe",
  "wp-codebox.agent-sandbox-run",
]

async function cliJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: repoRoot })
  return JSON.parse(stdout) as T
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  const catalog = await cliJson<CommandCatalogOutput>(["commands", "--json"])
  assert(catalog.schema === "wp-codebox/command-catalog/v1", "Unexpected command catalog schema")
  assert(JSON.stringify(catalog.commands.map((command) => command.id)) === JSON.stringify(expectedCommandIds), "Command ids changed unexpectedly")

  for (const command of catalog.commands) {
    assert(command.description.length > 0, `${command.id} is missing description`)
    assert(Array.isArray(command.acceptedArgs), `${command.id} acceptedArgs must be an array`)
    assert(command.outputShape.length > 0, `${command.id} is missing outputShape`)
    assert(command.policyRequirement.length > 0, `${command.id} is missing policyRequirement`)
  }

  const wpCli = catalog.commands.find((command) => command.id === "wordpress.wp-cli")
  assert(wpCli?.acceptedArgs.some((arg) => arg.name === "command" && arg.required), "wordpress.wp-cli must document required command arg")

  const schemaOutput = await cliJson<RecipeSchemaOutput>(["schema", "recipe", "--json"])
  assert(schemaOutput.schema === "wp-codebox/json-schema/v1", "Unexpected recipe schema envelope")
  assert(schemaOutput.id === "wp-codebox/workspace-recipe/v1", "Unexpected recipe schema id")

  const ajv = new Ajv2020({ strict: false })
  const validate = ajv.compile(schemaOutput.jsonSchema)
  for (const recipePath of [
    "examples/recipes/simple-plugin.json",
    "examples/recipes/seeded-plugin-workspace.json",
    "examples/recipes/bench-plugin.json",
    "examples/recipes/cookbook/seeded-content.json",
  ]) {
    const recipe = JSON.parse(await readFile(resolve(repoRoot, recipePath), "utf8"))
    assert(validate(recipe), `${recipePath} does not validate against discovery schema: ${ajv.errorsText(validate.errors)}`)
  }

  assert(validate({
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      extraPlugins: [{
        source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        pluginFile: "bbpress/bbpress.php",
        activate: false,
      }],
      secretEnv: ["OPENAI_API_KEY"],
      inherit: { connectors: ["primary-ai"], settings: ["site-defaults"] },
      inheritance: {
        connectors: [{ name: "primary-ai", status: "resolved", provider: "openai", model: "gpt-5.5", secretEnv: ["OPENAI_API_KEY"] }],
        settings: [{ name: "site-defaults", status: "resolved", scope: "site" }],
      },
    },
    workflow: { steps: [{ command: "wp-codebox.agent-sandbox-run", args: ["task=Cook dinner"] }] },
  }), `inheritance recipe shape does not validate against discovery schema: ${ajv.errorsText(validate.errors)}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
