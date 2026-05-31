export interface PlaygroundRunResponse {
  exitCode?: number
  errors?: string
  text: string
}

export class PlaygroundCommandError extends Error {
  readonly code = "wp-codebox-playground-command-failed"

  constructor(readonly command: string, readonly response: PlaygroundRunResponse) {
    super(playgroundFailureMessage(command, response))
    this.name = "PlaygroundCommandError"
  }
}

export class PlaygroundCommandCrashError extends Error {
  readonly code = "wp-codebox-playground-command-crashed"

  constructor(readonly command: string, readonly cause: unknown) {
    super(`${command} crashed before producing a structured response\n\n${errorMessage(cause)}`)
    this.name = "PlaygroundCommandCrashError"
  }
}

export class PlaygroundCliExitError extends Error {
  readonly code = "wp-codebox-playground-cli-exited"

  constructor(readonly exitCode: number) {
    super(`WordPress Playground CLI exited while booting the runtime with exit code ${exitCode}.`)
    this.name = "PlaygroundCliExitError"
  }
}

export function assertPlaygroundResponseOk(command: string, response: PlaygroundRunResponse): void {
  if (typeof response.exitCode === "number" && response.exitCode !== 0) {
    throw new PlaygroundCommandError(command, response)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Extract a human-readable failure message from the structured wordpress.core-phpunit
 * diagnostics log (.pg-test-result.txt). The PHP runner emits STAGE_FAIL / STAGE_DIE /
 * STAGE_FATAL markers; when core's bootstrap.php die()s mid-require, the shutdown handler
 * records STAGE_DIE with whatever the bootstrap printed (e.g. the "PHPUnit 0" notice).
 * Returns undefined when the log contains no recognizable failure marker (#314).
 */
export function extractCorePhpunitFailureMessage(log: string): string | undefined {
  if (!log.trim()) {
    return undefined
  }

  const lines = log.split("\n")
  const stageFail = lines.find((line) => line.startsWith("STAGE_FAIL:"))
  const stageDie = lines.find((line) => line.startsWith("STAGE_DIE:"))
  const stageFatal = lines.find((line) => line.startsWith("STAGE_FATAL:"))

  const detail = (marker: string | undefined): string | undefined => {
    if (!marker) {
      return undefined
    }
    // Format is MARKER:<stage>:<message...>; drop the marker and stage prefix.
    const withoutMarker = marker.slice(marker.indexOf(":") + 1)
    const withoutStage = withoutMarker.slice(withoutMarker.indexOf(":") + 1)
    return withoutStage.trim() || withoutMarker.trim()
  }

  const messages = [detail(stageFail), detail(stageDie), detail(stageFatal)].filter(
    (value): value is string => Boolean(value),
  )

  if (messages.length === 0) {
    return undefined
  }

  return messages.join(" | ")
}

function playgroundFailureMessage(command: string, response: PlaygroundRunResponse): string {
  const lines = [`${command} failed with exit code ${response.exitCode ?? "unknown"}`]
  const errors = response.errors?.trim()
  const text = response.text?.trim()

  if (errors) {
    lines.push("", "--- Playground errors ---", errors)
  }

  if (text) {
    lines.push("", "--- Playground output ---", text)
  }

  return lines.join("\n")
}
