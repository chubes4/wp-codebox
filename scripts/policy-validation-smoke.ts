import assert from "node:assert/strict"
import {
  RuntimeCommandPolicyViolationError,
  RuntimePolicyValidationError,
  assertRuntimeCommandAllowed,
  assertRuntimePolicy,
  validateRuntimePolicy,
  type RuntimePolicy,
} from "@chubes4/wp-codebox-core"

const policy: RuntimePolicy = {
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["inspect-mounted-inputs"],
  secrets: "none",
  approvals: "never",
}

assert.deepEqual(validateRuntimePolicy(policy), { valid: true, issues: [] })
assert.doesNotThrow(() => assertRuntimePolicy(policy))
assert.doesNotThrow(() => assertRuntimeCommandAllowed("inspect-mounted-inputs", policy))

assert.throws(
  () => assertRuntimePolicy({ ...policy, commands: [""] }),
  (error) => {
    assert.ok(error instanceof RuntimePolicyValidationError)
    assert.equal(error.code, "runtime-policy-invalid")
    assert.deepEqual(error.toJSON(), {
      code: "runtime-policy-invalid",
      issues: [
        {
          code: "invalid-command",
          field: "commands",
          message: "commands must be a list of non-empty command names",
        },
      ],
      message: "Runtime policy is invalid: commands must be a list of non-empty command names",
      name: "RuntimePolicyValidationError",
    })
    return true
  },
)

assert.throws(
  () => assertRuntimeCommandAllowed("write-production", policy),
  (error) => {
    assert.ok(error instanceof RuntimeCommandPolicyViolationError)
    assert.deepEqual(error.toJSON(), {
      code: "runtime-command-disallowed",
      command: "write-production",
      allowedCommands: ["inspect-mounted-inputs"],
      policy,
      message: "Command is not allowed by runtime policy: write-production",
      name: "RuntimeCommandPolicyViolationError",
    })
    return true
  },
)

console.log("Policy validation smoke passed")
