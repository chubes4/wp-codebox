import type { RuntimeCreateSpec } from "@chubes4/wp-codebox-core"

export function normalizeBlueprint(blueprint: unknown): { extraLibraries?: unknown; landingPage?: unknown; preferredVersions?: unknown; steps: unknown[] } {
  if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) {
    return { steps: [] }
  }

  const candidate = blueprint as Record<string, unknown>
  const steps = Array.isArray(candidate.steps) ? candidate.steps : []

  return {
    extraLibraries: candidate.extraLibraries,
    landingPage: candidate.landingPage,
    preferredVersions: candidate.preferredVersions,
    steps,
  }
}

export function playgroundBlueprint(blueprint: unknown, policy: RuntimeCreateSpec["policy"]): unknown {
  if (!policy.commands.includes("wordpress.wp-cli")) {
    return blueprint
  }

  const base = !blueprint || typeof blueprint !== "object" || Array.isArray(blueprint) ? {} : blueprint as Record<string, unknown>
  const extraLibraries = Array.isArray(base.extraLibraries) ? base.extraLibraries : []

  return {
    ...base,
    extraLibraries: [...new Set([...extraLibraries, "wp-cli"])],
  }
}

export function preferredVersionsForEnvironment(
  wpVersion: string | undefined,
  baseBlueprint: { preferredVersions?: unknown },
): unknown {
  if (baseBlueprint.preferredVersions) {
    return baseBlueprint.preferredVersions
  }

  if (!wpVersion) {
    return undefined
  }

  return { wp: wpVersion }
}
