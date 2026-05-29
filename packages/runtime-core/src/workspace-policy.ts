import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, normalize, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type WorkspacePolicyViolationCode =
  | "invalid-policy-path"
  | "path-outside-workspace"
  | "path-outside-writable-roots"
  | "hidden-path"
  | "symlink"
  | "hardlink"
  | "gitlink"
  | "nested-git-metadata"
  | "ignored-path"
  | "special-file"
  | "unmerged-index"

export interface WorkspacePolicyViolation {
  code: WorkspacePolicyViolationCode
  path: string
  message: string
  details?: Record<string, unknown>
}

export interface WorkspacePolicyCheckOptions {
  workspaceRoot: string
  writableRoots: string[]
  hiddenPaths?: string[]
  gitBacked?: boolean
}

export interface WorkspacePolicyResult {
  schema: "wp-codebox/workspace-policy-result/v1"
  passed: boolean
  policy_sha256: string
  violations: WorkspacePolicyViolation[]
}

interface NormalizedWorkspacePolicy {
  workspaceRoot: string
  writableRoots: string[]
  hiddenPaths: string[]
  gitBacked: boolean
}

interface GitStatusEntry {
  status: string
  path: string
}

export async function checkWorkspacePolicy(options: WorkspacePolicyCheckOptions): Promise<WorkspacePolicyResult> {
  const workspaceRoot = resolve(options.workspaceRoot)
  const policy: NormalizedWorkspacePolicy = {
    workspaceRoot,
    writableRoots: options.writableRoots.map(normalizePolicyPath),
    hiddenPaths: (options.hiddenPaths ?? []).map(normalizePolicyPath),
    gitBacked: options.gitBacked ?? false,
  }
  const violations: WorkspacePolicyViolation[] = []

  for (const [kind, paths] of [
    ["writable root", policy.writableRoots],
    ["hidden path", policy.hiddenPaths],
  ] as const) {
    for (const path of paths) {
      if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
        violations.push({
          code: "invalid-policy-path",
          path,
          message: `Invalid ${kind}: ${path || "<empty>"}`,
        })
      }
    }
  }

  const paths = new Set<string>()
  for (const path of await listWorkspacePaths(workspaceRoot, { skipRootGitMetadata: policy.gitBacked })) {
    paths.add(path)
  }

  if (policy.gitBacked) {
    const gitEntries = await readGitStatusEntries(workspaceRoot)
    for (const entry of gitEntries) {
      paths.add(entry.path)
      if (entry.status === "!!") {
        violations.push({ code: "ignored-path", path: entry.path, message: `Ignored path is present in git-backed workspace: ${entry.path}` })
      }
      if (isUnmergedStatus(entry.status)) {
        violations.push({ code: "unmerged-index", path: entry.path, message: `Unmerged index entry: ${entry.path}`, details: { status: entry.status } })
      }
    }
    for (const path of await readGitlinkPaths(workspaceRoot)) {
      paths.add(path)
      violations.push({ code: "gitlink", path, message: `Gitlink/submodule entry is not allowed: ${path}` })
    }
    for (const path of await readUnmergedIndexPaths(workspaceRoot)) {
      paths.add(path)
      violations.push({ code: "unmerged-index", path, message: `Unmerged index entry: ${path}` })
    }
  }

  for (const path of paths) {
    violations.push(...(await checkWorkspacePath(policy, path)))
  }

  return {
    schema: "wp-codebox/workspace-policy-result/v1",
    passed: violations.length === 0,
    policy_sha256: workspacePolicySha256(policy),
    violations: sortViolations(dedupeViolations(violations)),
  }
}

export function workspacePolicySha256(policy: WorkspacePolicyCheckOptions | NormalizedWorkspacePolicy): string {
  const normalized = {
    workspaceRoot: resolve(policy.workspaceRoot),
    writableRoots: [...policy.writableRoots].map(normalizePolicyPath).sort(),
    hiddenPaths: [...(policy.hiddenPaths ?? [])].map(normalizePolicyPath).sort(),
    gitBacked: policy.gitBacked ?? false,
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

async function checkWorkspacePath(policy: NormalizedWorkspacePolicy, path: string): Promise<WorkspacePolicyViolation[]> {
  const violations: WorkspacePolicyViolation[] = []
  const normalizedPath = normalizePolicyPath(path)
  const absolutePath = resolve(policy.workspaceRoot, normalizedPath)
  const relativePath = relative(policy.workspaceRoot, absolutePath)

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return [{ code: "path-outside-workspace", path, message: `Path escapes workspace root: ${path}` }]
  }

  if (!isPathUnderAny(normalizedPath, policy.writableRoots)) {
    violations.push({ code: "path-outside-writable-roots", path: normalizedPath, message: `Path is outside writable roots: ${normalizedPath}` })
  }

  if (isPathUnderAny(normalizedPath, policy.hiddenPaths)) {
    violations.push({ code: "hidden-path", path: normalizedPath, message: `Path is under a hidden policy path: ${normalizedPath}` })
  }

  if (hasNestedGitMetadata(normalizedPath)) {
    violations.push({ code: "nested-git-metadata", path: normalizedPath, message: `Nested .git metadata is not allowed: ${normalizedPath}` })
  }

  let stat
  try {
    stat = await lstat(absolutePath)
  } catch {
    return violations
  }

  if (stat.isSymbolicLink()) {
    violations.push({ code: "symlink", path: normalizedPath, message: `Symlink is not allowed: ${normalizedPath}` })
    return violations
  }

  if (stat.isFile()) {
    if (typeof stat.nlink !== "number" || !Number.isFinite(stat.nlink)) {
      violations.push({ code: "hardlink", path: normalizedPath, message: `Unable to determine link count for regular file: ${normalizedPath}`, details: { linkCountAvailable: false } })
    } else if (stat.nlink > 1) {
      violations.push({ code: "hardlink", path: normalizedPath, message: `Hardlink is not allowed: ${normalizedPath}`, details: { links: stat.nlink } })
    }
  }

  if (!stat.isFile() && !stat.isDirectory()) {
    violations.push({ code: "special-file", path: normalizedPath, message: `Special file is not allowed: ${normalizedPath}` })
  }

  if (stat.isDirectory()) {
    try {
      const entryRealpath = await realpath(absolutePath)
      const rootRealpath = await realpath(policy.workspaceRoot)
      const realRelative = relative(rootRealpath, entryRealpath)
      if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
        violations.push({ code: "path-outside-workspace", path: normalizedPath, message: `Path resolves outside workspace root: ${normalizedPath}` })
      }
    } catch {
      // lstat already proved the entry exists; realpath can fail on broken trees.
    }
  }

  return violations
}

async function listWorkspacePaths(workspaceRoot: string, options: { skipRootGitMetadata?: boolean } = {}): Promise<string[]> {
  const paths: string[] = []
  const queue = [""]
  while (queue.length > 0) {
    const current = queue.shift() ?? ""
    const absolute = current ? resolve(workspaceRoot, current) : workspaceRoot
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = normalizePolicyPath(current ? `${current}/${entry.name}` : entry.name)
      if (options.skipRootGitMetadata && (relativePath === ".git" || relativePath.startsWith(".git/"))) {
        continue
      }
      paths.push(relativePath)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        queue.push(relativePath)
      }
    }
  }
  return paths
}

async function readGitStatusEntries(workspaceRoot: string): Promise<GitStatusEntry[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"], {
    cwd: workspaceRoot,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 20,
  })
  const tokens = stdout.toString("utf8").split("\0").filter(Boolean)
  const entries: GitStatusEntry[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const status = token.slice(0, 2)
    const path = normalizePolicyPath(token.slice(3))
    entries.push({ status, path })
    if (status.includes("R") || status.includes("C")) {
      index++
      if (tokens[index]) {
        entries.push({ status, path: normalizePolicyPath(tokens[index]) })
      }
    }
  }
  return entries
}

async function readGitlinkPaths(workspaceRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-s", "-z"], {
    cwd: workspaceRoot,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 20,
  })
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => normalizePolicyPath(entry.slice(entry.indexOf("\t") + 1)))
}

async function readUnmergedIndexPaths(workspaceRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-u", "-z"], {
    cwd: workspaceRoot,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 20,
  })
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => normalizePolicyPath(entry.slice(entry.indexOf("\t") + 1)))
}

function normalizePolicyPath(path: string): string {
  return normalize(path.replaceAll("\\", "/")).replaceAll("\\", "/").replace(/^\.\//, "")
}

function isPathUnderAny(path: string, roots: string[]): boolean {
  return roots.some((root) => root === "." || path === root || path.startsWith(`${root}/`))
}

function hasNestedGitMetadata(path: string): boolean {
  const parts = path.split("/")
  return parts.includes(".git")
}

function isUnmergedStatus(status: string): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status)
}

function dedupeViolations(violations: WorkspacePolicyViolation[]): WorkspacePolicyViolation[] {
  const seen = new Set<string>()
  return violations.filter((violation) => {
    const key = `${violation.code}\0${violation.path}\0${violation.message}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function sortViolations(violations: WorkspacePolicyViolation[]): WorkspacePolicyViolation[] {
  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code))
}
