import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { MountSpec } from "@chubes4/wp-codebox-core"
import {
  MAX_CAPTURED_MOUNT_FILE_BYTES,
  MAX_CAPTURED_MOUNT_FILES,
  SKIPPED_CAPTURE_DIRECTORIES,
  type ArtifactRedactor,
  type CapturedMountFiles,
  type ChangedFile,
  type MountDiff,
  type MountDiffsResult,
  directoryDiff,
  isReplayableText,
  mountTargetPath,
} from "./artifacts.js"

export async function captureMountedFiles(filesDirectory: string, mounts: MountSpec[], redactor: ArtifactRedactor): Promise<CapturedMountFiles> {
  const captured: CapturedMountFiles = {
    files: [],
    skipped: [],
    limits: {
      maxFiles: MAX_CAPTURED_MOUNT_FILES,
      maxFileBytes: MAX_CAPTURED_MOUNT_FILE_BYTES,
      skippedDirectories: [...SKIPPED_CAPTURE_DIRECTORIES].sort(),
    },
  }

  for (const [mountIndex, mount] of mounts.entries()) {
    if (mount.mode !== "readwrite") {
      continue
    }

    const mountStats = await stat(mount.source)
    if (mountStats.isDirectory()) {
      await captureMountedDirectory(filesDirectory, captured, mount, mountIndex, mount.source, "", redactor)
      continue
    }

    if (mountStats.isFile()) {
      await captureMountedFile(filesDirectory, captured, mount, mountIndex, mount.source, basename(mount.source), redactor)
    }
  }

  return captured
}

export async function captureMountDiffs(artifactRoot: string, filesDirectory: string, mounts: MountSpec[], redactor: ArtifactRedactor): Promise<MountDiffsResult> {
  const diffsDirectory = join(filesDirectory, "diffs")
  await mkdir(diffsDirectory, { recursive: true })
  const diffs: MountDiff[] = []
  const changedFiles: ChangedFile[] = []
  const patches: string[] = []

  for (const [mountIndex, mount] of mounts.entries()) {
    const baselineSource = typeof mount.metadata?.baselineSource === "string" ? mount.metadata.baselineSource : ""
    if (mount.mode !== "readwrite" || !baselineSource) {
      continue
    }

    const diff = await directoryDiff(baselineSource, mount.source, mount.target)
    const artifactPath = `files/diffs/mount-${mountIndex}.patch`
    await writeFile(join(artifactRoot, artifactPath), redactor.redact(artifactPath, diff.patch))
    diffs.push({
      mountIndex,
      source: mount.source,
      target: mount.target,
      baselineSource,
      artifactPath,
      changed: diff.patch.trim().length > 0,
    })
    patches.push(diff.patch)
    changedFiles.push(
      ...diff.files.map((file) => ({
        ...file,
        mountIndex,
        mountTarget: mount.target,
        patchPath: artifactPath,
      })),
    )
  }

  return {
    mountDiffs: diffs,
    changedFiles: {
      schema: "wp-codebox/changed-files/v1",
      files: changedFiles,
    },
    patch: patches.filter((patch) => patch.length > 0).join("\n"),
  }
}

async function captureMountedDirectory(
  filesDirectory: string,
  captured: CapturedMountFiles,
  mount: MountSpec,
  mountIndex: number,
  directory: string,
  relativeDirectory: string,
  redactor: ArtifactRedactor,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const sourcePath = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (SKIPPED_CAPTURE_DIRECTORIES.has(entry.name)) {
        captured.skipped.push({
          mountIndex,
          source: sourcePath,
          target: mountTargetPath(mount, relativePath),
          relativePath,
          reason: "directory-skipped",
        })
        continue
      }

      await captureMountedDirectory(filesDirectory, captured, mount, mountIndex, sourcePath, relativePath, redactor)
      continue
    }

    if (entry.isFile()) {
      await captureMountedFile(filesDirectory, captured, mount, mountIndex, sourcePath, relativePath, redactor)
    }
  }
}

async function captureMountedFile(
  filesDirectory: string,
  captured: CapturedMountFiles,
  mount: MountSpec,
  mountIndex: number,
  sourcePath: string,
  relativePath: string,
  redactor: ArtifactRedactor,
): Promise<void> {
  const target = mount.type === "file" ? mount.target : mountTargetPath(mount, relativePath)

  if (captured.files.length >= MAX_CAPTURED_MOUNT_FILES) {
    captured.skipped.push({ mountIndex, source: sourcePath, target, relativePath, reason: "max-files-exceeded" })
    return
  }

  const fileStats = await stat(sourcePath)
  if (fileStats.size > MAX_CAPTURED_MOUNT_FILE_BYTES) {
    captured.skipped.push({ mountIndex, source: sourcePath, target, relativePath, reason: "max-file-bytes-exceeded" })
    return
  }

  const artifactRelativePath = `mounts/${mountIndex}/${relativePath}`
  const artifactPath = join(filesDirectory, artifactRelativePath)
  await mkdir(dirname(artifactPath), { recursive: true })

  const buffer = await readFile(sourcePath)
  const text = buffer.toString("utf8")
  const replayable = isReplayableText(buffer, text)
  const artifactBundlePath = `files/${artifactRelativePath}`
  const artifactContents = replayable ? redactor.redact(artifactBundlePath, text) : buffer
  if (typeof artifactContents === "string") {
    await writeFile(artifactPath, artifactContents)
  } else {
    await copyFile(sourcePath, artifactPath)
  }
  const artifactBuffer = typeof artifactContents === "string" ? Buffer.from(artifactContents, "utf8") : buffer

  captured.files.push({
    mountIndex,
    source: sourcePath,
    target,
    relativePath,
    artifactPath: artifactBundlePath,
    size: artifactBuffer.byteLength,
    sha256: createHash("sha256").update(artifactBuffer).digest("hex"),
    contentType: replayable ? "text/plain; charset=utf-8" : "application/octet-stream",
    replayable,
    ...(replayable ? { replayContents: artifactContents as string } : {}),
  })
}
