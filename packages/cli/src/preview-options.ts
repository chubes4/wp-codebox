export const PREVIEW_HOLD_MAX_SECONDS = 3600
export const PREVIEW_PORT_MIN = 1
export const PREVIEW_PORT_MAX = 65535

export interface PreviewOptionsInput {
  preview_hold_seconds?: unknown
  preview_hold?: unknown
  preview_port?: unknown
  preview_bind?: unknown
  preview_public_url?: unknown
}

export interface PreviewOptions {
  preview_hold_seconds: number
  preview_port: number | null
  preview_bind: string | null
  preview_public_url: string | null
}

export class PreviewOptionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "PreviewOptionError"
  }
}

export const previewInputSchema = {
  preview_hold_seconds: {
    type: "integer",
    minimum: 0,
    maximum: PREVIEW_HOLD_MAX_SECONDS,
    description: "Seconds to keep the live Playground preview URL available after capture. Max 3600.",
  },
  preview_port: {
    type: "integer",
    minimum: PREVIEW_PORT_MIN,
    maximum: PREVIEW_PORT_MAX,
    description: "Optional fixed local WP Codebox preview proxy port. Omit to keep the default loopback-only random-port behavior.",
  },
  preview_bind: {
    type: "string",
    description: "Optional fixed-port preview proxy bind host or IP. Requires preview_port. Defaults to 127.0.0.1 when omitted.",
  },
  preview_public_url: {
    type: "string",
    format: "uri",
    description: "Optional public http/https URL reported in preview metadata and passed to the sandbox for site URL alignment.",
  },
} as const

export function normalizePreviewOptions(input: PreviewOptionsInput): PreviewOptions {
  const port = parsePreviewPortValue(input.preview_port)
  const bind = parsePreviewBindValue(input.preview_bind)
  const publicUrl = parsePreviewPublicUrlValue(input.preview_public_url)

  if (bind !== null && port === null) {
    throw new PreviewOptionError("wp_codebox_preview_bind_requires_port", "preview_bind requires preview_port.")
  }

  return {
    preview_hold_seconds: parsePreviewHoldSecondsValue(input.preview_hold_seconds ?? input.preview_hold ?? 0),
    preview_port: port,
    preview_bind: bind,
    preview_public_url: publicUrl,
  }
}

export function parsePreviewHoldSeconds(value: unknown): number {
  return parsePreviewHoldSecondsValue(value)
}

export function parsePreviewPort(value: unknown): number {
  const port = parsePreviewPortValue(value, "--preview-port")
  if (port === null) {
    throw new PreviewOptionError("wp_codebox_preview_port_invalid", "--preview-port must be an integer between 1 and 65535")
  }
  return port
}

export function parsePreviewBind(value: unknown): string {
  const bind = parsePreviewBindValue(value)
  if (bind === null) {
    throw new PreviewOptionError("wp_codebox_preview_bind_invalid", "--preview-bind must not be empty")
  }
  return bind
}

export function parsePreviewPublicUrl(value: unknown): string {
  const publicUrl = parsePreviewPublicUrlValue(value)
  if (publicUrl === null) {
    throw new PreviewOptionError("wp_codebox_preview_public_url_invalid", "--preview-public-url must include a URL")
  }
  return publicUrl
}

function parsePreviewHoldSecondsValue(value: unknown): number {
  const raw = String(value).trim()
  const match = raw.match(/^(\d+)(s|m)?$/)
  const seconds = match ? Number.parseInt(match[1], 10) * (match[2] === "m" ? 60 : 1) : Number.parseInt(raw, 10)
  if (!Number.isFinite(seconds)) {
    return 0
  }

  return Math.max(0, Math.min(PREVIEW_HOLD_MAX_SECONDS, Math.floor(seconds)))
}

function parsePreviewPortValue(value: unknown, label = "preview_port"): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null
  }

  const trimmed = String(value).trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new PreviewOptionError("wp_codebox_preview_port_invalid", `${label} must be an integer between 1 and 65535.`)
  }

  const port = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(port) || port < PREVIEW_PORT_MIN || port > PREVIEW_PORT_MAX) {
    throw new PreviewOptionError("wp_codebox_preview_port_invalid", `${label} must be an integer between 1 and 65535.`)
  }

  return port
}

function parsePreviewBindValue(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null
  }

  const trimmed = String(value).trim()
  if (/[/\\\s]/.test(trimmed)) {
    throw new PreviewOptionError("wp_codebox_preview_bind_invalid", "preview_bind must be a hostname or IP address, not a URL.")
  }

  return trimmed
}

function parsePreviewPublicUrlValue(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null
  }

  let url: URL
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new PreviewOptionError("wp_codebox_preview_public_url_invalid", "preview_public_url must be an http or https URL with a hostname.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PreviewOptionError("wp_codebox_preview_public_url_invalid", "preview_public_url must be an http or https URL with a hostname.")
  }

  if (!url.hostname) {
    throw new PreviewOptionError("wp_codebox_preview_public_url_invalid", "preview_public_url must be an http or https URL with a hostname.")
  }

  return url.toString()
}
