import { pathToFileURL } from "node:url"
import { basename, relative, resolve } from "node:path"
import { createRuntime } from "@chubes4/sandbox-runtime-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/sandbox-runtime-playground"

const input = process.argv[2]

if (!input) {
  console.error("Usage: npm run hello-runtime -- <plugin-or-fixture-directory>")
  process.exit(1)
}

const source = resolve(input)

function displayPath(path: string): string {
  const relativePath = relative(process.cwd(), path)
  return relativePath.startsWith("..") ? path : `./${relativePath}`
}

const runtime = await createRuntime(
  {
    backend: "wordpress-playground",
    environment: {
      kind: "wordpress",
      name: "hello-runtime",
      version: "latest",
      blueprint: {
        steps: [],
      },
    },
    policy: {
      network: "deny",
      filesystem: "readwrite-mounts",
      commands: ["inspect-mounted-inputs"],
      secrets: "none",
      approvals: "never",
    },
  },
  createPlaygroundRuntimeBackend(),
)

console.log("Sandbox Runtime hello")
console.log("Thesis: product surfaces can create disposable WordPress sandboxes, run work there, and apply only the artifact bundle.")
console.log("WordPress inception: WordPress can safely orchestrate a WordPress Playground runtime instead of writing directly to a live site.")
console.log("")
console.log("Created runtime: wordpress-playground")

await runtime.mount({
  type: "directory",
  source,
  target: `/wordpress/wp-content/plugins/${basename(source)}`,
  mode: "readwrite",
})

console.log(`Mounted: ${basename(source)}`)

const result = await runtime.execute({ command: "inspect-mounted-inputs" })
console.log(`Executed: ${result.command}`)

await runtime.observe({ type: "runtime-info" })
await runtime.observe({ type: "mounts" })

const artifacts = await runtime.collectArtifacts({ includeLogs: true, includeObservations: true })
console.log("Collected artifacts:")
console.log(`- Directory: ${displayPath(artifacts.directory)}`)
console.log(`- Open: ${pathToFileURL(artifacts.directory).href}`)
console.log(`- Manifest: ${displayPath(artifacts.manifestPath)}`)
console.log(`- Metadata: ${displayPath(artifacts.metadataPath)}`)
console.log(`- Events: ${displayPath(artifacts.eventsPath)}`)
console.log(`- Runtime log: ${displayPath(artifacts.runtimeLogPath)}`)
console.log(`- Commands log: ${displayPath(artifacts.commandsLogPath)}`)
console.log(`- Mounts: ${displayPath(artifacts.mountsPath)}`)
console.log(`- Observations: ${displayPath(artifacts.observationsPath)}`)

await runtime.destroy()
console.log("Destroyed runtime")
