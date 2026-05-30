import assert from "node:assert/strict"
import {
  BROWSER_INTERACTION_STEP_KINDS,
  browserInteractionScriptUsesEvaluate,
  validateBrowserInteractionScript,
} from "@chubes4/wp-codebox-core"

// Backend-agnostic step-schema validation unit smoke (issue #310). Exercises the
// contract declared in runtime-core without booting a browser, so the parsing/
// validation logic is covered even when Playwright is unavailable.

// Every documented step kind is recognized.
const everyKind = BROWSER_INTERACTION_STEP_KINDS.map((kind) => {
  switch (kind) {
    case "navigate":
      return { kind, url: "/" }
    case "click":
    case "hover":
      return { kind, selector: ".thing" }
    case "fill":
    case "type":
      return { kind, selector: "#field", value: "x" }
    case "press":
      return { kind, key: "Enter" }
    case "drag":
      return { kind, from: ".source", to: { x: 10, y: 20 } }
    case "select":
      return { kind, selector: "#sel", value: "a" }
    case "waitFor":
      return { kind, selector: ".ready" }
    case "evaluate":
      return { kind, expression: "1 + 1", assert: 2 }
    case "expect":
      return { kind, selector: ".ok", state: "visible" }
    case "screenshot":
      return { kind, name: "shot" }
    case "capture":
      return { kind }
  }
})

const allValid = validateBrowserInteractionScript(everyKind)
assert.equal(allValid.valid, true, `expected all kinds valid, got: ${JSON.stringify(allValid.issues)}`)
assert.equal(allValid.steps.length, everyKind.length)

// evaluate detection drives the separate policy gate.
assert.equal(browserInteractionScriptUsesEvaluate(allValid.steps), true)
assert.equal(browserInteractionScriptUsesEvaluate(validateBrowserInteractionScript([{ kind: "click", selector: ".x" }]).steps), false)

// Non-array input is rejected.
assert.equal(validateBrowserInteractionScript({ kind: "click" }).valid, false)

// Unknown kind is rejected with a per-index issue.
const unknownKind = validateBrowserInteractionScript([{ kind: "teleport" }])
assert.equal(unknownKind.valid, false)
assert.equal(unknownKind.issues[0]?.index, 0)

// Missing required fields are flagged per kind.
assert.equal(validateBrowserInteractionScript([{ kind: "navigate" }]).valid, false)
assert.equal(validateBrowserInteractionScript([{ kind: "fill", selector: "#a" }]).valid, false) // missing value
assert.equal(validateBrowserInteractionScript([{ kind: "press" }]).valid, false) // missing key
assert.equal(validateBrowserInteractionScript([{ kind: "drag", from: ".a" }]).valid, false) // missing to
assert.equal(validateBrowserInteractionScript([{ kind: "evaluate" }]).valid, false) // missing expression
assert.equal(validateBrowserInteractionScript([{ kind: "expect" }]).valid, false) // missing selector

// drag accepts both selector and coordinate drop targets.
assert.equal(validateBrowserInteractionScript([{ kind: "drag", from: ".a", to: { selector: ".b" } }]).valid, true)
assert.equal(validateBrowserInteractionScript([{ kind: "drag", from: ".a", to: { x: 1, y: 2 } }]).valid, true)

// expect rejects an unknown state.
assert.equal(validateBrowserInteractionScript([{ kind: "expect", selector: ".a", state: "glowing" }]).valid, false)

// click accepts either selector or text.
assert.equal(validateBrowserInteractionScript([{ kind: "click", text: "Save" }]).valid, true)
assert.equal(validateBrowserInteractionScript([{ kind: "click" }]).valid, false)

console.log("Browser interaction script validation smoke passed")
