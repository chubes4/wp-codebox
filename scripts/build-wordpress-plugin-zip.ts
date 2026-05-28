import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const pluginSource = join(repoRoot, "packages", "wordpress-plugin")
const outputDirectory = join(pluginSource, "dist")
const outputZip = join(outputDirectory, "wp-codebox.zip")
const stagingRoot = await mkdtemp(join(tmpdir(), "wp-codebox-plugin-"))
const stagingPlugin = join(stagingRoot, "wp-codebox")
const cliPackageRoot = join(repoRoot, "dist", "release", "wp-codebox-cli")

try {
	await execFileAsync("npm", ["run", "release:package"], {
		cwd: repoRoot,
		env: {
			...process.env,
			WP_CODEBOX_RELEASE_PLATFORM: process.env.WP_CODEBOX_RELEASE_PLATFORM ?? "linux",
			WP_CODEBOX_RELEASE_ARCH: process.env.WP_CODEBOX_RELEASE_ARCH ?? "x64",
		},
		maxBuffer: 1024 * 1024 * 20,
	})
	await mkdir(outputDirectory, { recursive: true })
	await mkdir(stagingPlugin, { recursive: true })
	await cp(join(pluginSource, "wp-codebox.php"), join(stagingPlugin, "wp-codebox.php"))
	await cp(join(pluginSource, "README.md"), join(stagingPlugin, "README.md"))
	await cp(join(pluginSource, "src"), join(stagingPlugin, "src"), { recursive: true })
	await cp(cliPackageRoot, join(stagingPlugin, "vendor", "wp-codebox-cli"), { recursive: true })
	await rm(outputZip, { force: true })
  await execFileAsync("zip", ["-qr", outputZip, "wp-codebox"], { cwd: stagingRoot })
  console.log(`Built ${outputZip}`)
} finally {
  await rm(stagingRoot, { recursive: true, force: true })
}
