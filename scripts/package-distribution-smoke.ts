import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")

const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

assert.ok(
  rootPackage.dependencies?.["@wp-playground/cli"],
  "Published workspace package should install the Playground CLI runtime dependency",
)
assert.ok(
  rootPackage.dependencies?.playwright,
  "Published workspace package should install the Playwright runtime dependency",
)

const { stdout: packStdout } = await execFileAsync(
  "npm",
  ["pack", "--workspace", "@chubes4/wp-codebox-cli", "--dry-run", "--json"],
  { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 },
)
const [pack] = JSON.parse(packStdout) as Array<{ files: Array<{ path: string }>; entryCount: number }>
const packedFiles = new Set(pack.files.map((file) => file.path))

assert.ok(packedFiles.has("package.json"), "CLI package should include package.json")
assert.ok(packedFiles.has("README.md"), "CLI package should include README.md")
assert.ok(packedFiles.has("dist/index.js"), "CLI package should include compiled binary entrypoint")
assert.ok(packedFiles.has("dist/index.d.ts"), "CLI package should include generated types")
assert.equal(packedFiles.has("src/index.ts"), false, "CLI package should not ship TypeScript source")
assert.ok(pack.entryCount >= 4, "CLI package should contain expected publish files")

await execFileAsync("npm", ["run", "package:wordpress-plugin"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 })
const pluginZip = resolve(repoRoot, "packages", "wordpress-plugin", "dist", "wp-codebox.zip")
await access(pluginZip)

const { stdout: zipStdout } = await execFileAsync("unzip", ["-Z1", pluginZip], { cwd: repoRoot })
const zipEntries = new Set(zipStdout.trim().split("\n").filter(Boolean))

assert.ok(zipEntries.has("wp-codebox/wp-codebox.php"), "Plugin zip should include the main plugin file")
assert.ok(zipEntries.has("wp-codebox/README.md"), "Plugin zip should include README.md")
assert.ok(zipEntries.has("wp-codebox/src/class-wp-codebox-abilities.php"), "Plugin zip should include ability surface")
assert.ok(zipEntries.has("wp-codebox/src/class-wp-codebox-agent-sandbox-runner.php"), "Plugin zip should include sandbox runner")
assert.ok(zipEntries.has("wp-codebox/src/class-wp-codebox-artifacts.php"), "Plugin zip should include artifact helpers")
assert.ok(zipEntries.has("wp-codebox/vendor/wp-codebox-cli/bin/wp-codebox"), "Plugin zip should include packaged CLI wrapper")
assert.ok(
  zipEntries.has("wp-codebox/vendor/wp-codebox-cli/vendor/node/bin/node"),
  "Plugin zip should include packaged Node runtime for the plugin CLI path",
)
assert.ok(zipEntries.has("wp-codebox/vendor/wp-codebox-cli/packages/cli/dist/index.js"), "Plugin zip should include compiled CLI runtime")
assert.equal(zipEntries.has("wp-codebox/package.json"), false, "Plugin zip should not include package metadata")
assert.equal(zipEntries.has("wp-codebox/dist/wp-codebox.zip"), false, "Plugin zip should not include generated artifacts")

console.log("Package distribution smoke passed")
