import { execFile } from "node:child_process"
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises"
import { arch, platform } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const releaseRoot = resolve(repoRoot, "dist", "release")
const packageRoot = join(releaseRoot, "wp-codebox-cli")
const platformName = process.env.WP_CODEBOX_RELEASE_PLATFORM ?? normalizePlatform(platform())
const archName = process.env.WP_CODEBOX_RELEASE_ARCH ?? normalizeArch(arch())
const artifactName = `wp-codebox-cli-${platformName}-${archName}.tar.gz`
const artifactPath = resolve(repoRoot, "dist", artifactName)

await execFileAsync("npm", ["run", "build"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 })

await rm(releaseRoot, { recursive: true, force: true })
await mkdir(packageRoot, { recursive: true })

await copyIfPresent("README.md")
await copyIfPresent("LICENSE")
await cp(resolve(repoRoot, "package.json"), join(packageRoot, "package.json"))
await cp(resolve(repoRoot, "package-lock.json"), join(packageRoot, "package-lock.json"))

for (const packageName of ["runtime-core", "runtime-playground", "cli"]) {
  const sourceRoot = resolve(repoRoot, "packages", packageName)
  const targetRoot = join(packageRoot, "packages", packageName)
  await mkdir(targetRoot, { recursive: true })
  await cp(join(sourceRoot, "package.json"), join(targetRoot, "package.json"))
  await cp(join(sourceRoot, "dist"), join(targetRoot, "dist"), { recursive: true })
}

await execFileAsync("npm", ["install", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-fund", "--no-audit"], {
  cwd: packageRoot,
  maxBuffer: 1024 * 1024 * 20,
})

const binDir = join(packageRoot, "bin")
await mkdir(binDir, { recursive: true })
const binPath = join(binDir, "wp-codebox")
await writeFile(binPath, "#!/usr/bin/env bash\nset -euo pipefail\nSCRIPT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"\nexec node \"${SCRIPT_DIR}/../packages/cli/dist/index.js\" \"$@\"\n")
await chmod(binPath, 0o755)

await execFileAsync("tar", ["-czf", artifactPath, "-C", releaseRoot, "wp-codebox-cli"], {
  cwd: repoRoot,
  maxBuffer: 1024 * 1024 * 10,
})

process.stdout.write(JSON.stringify([{ path: `dist/${artifactName}`, type: "node-cli-tarball", platform: `${platformName}-${archName}` }]) + "\n")

async function copyIfPresent(relativePath: string): Promise<void> {
  try {
    await cp(resolve(repoRoot, relativePath), join(packageRoot, relativePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }
}

function normalizePlatform(value: NodeJS.Platform): string {
  if (value === "darwin") {
    return "macos"
  }
  if (value === "win32") {
    return "windows"
  }
  return value
}

function normalizeArch(value: string): string {
  if (value === "x64") {
    return "x64"
  }
  if (value === "arm64") {
    return "arm64"
  }
  return value
}
