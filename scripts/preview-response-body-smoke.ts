import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-preview-body-"))

try {
  const previewPort = await reserveFreePort()
  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "preview-body-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.wp-cli"],
        secrets: "none",
        approvals: "never",
      },
      artifactsDirectory,
      metadata: {
        runtime: { version: "0.0.0" },
        task: { kind: "preview-response-body-smoke" },
      },
      preview: { port: previewPort },
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    const createPost = await runtime.execute({
      command: "wordpress.wp-cli",
      args: ["command=post create --post_type=page --post_status=publish --post_title='Preview Body Smoke' --post_content='Tunnel-visible response body' --porcelain"],
    })
    assert.equal(createPost.exitCode, 0)

    const postId = createPost.stdout.trim()
    assert.match(postId, /^\d+$/)

    const previewUrl = (await runtime.info()).previewUrl
    assert.equal(previewUrl, `http://127.0.0.1:${previewPort}`)

    const response = await fetch(`${previewUrl}/?p=${postId}`)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /Preview Body Smoke/)
    assert.match(body, /Tunnel-visible response body/)
    assertExplicitResponseFraming(response, body)
  } finally {
    await runtime.destroy()
  }

  console.log("Preview response body smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}

async function reserveFreePort(): Promise<number> {
  const server = await listenOnPort(0)
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await closeServer(server)
  return port
}

async function listenOnPort(port: number): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(port, "127.0.0.1", () => resolveListen())
  })
  return server
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}

function assertExplicitResponseFraming(response: Response, body: string): void {
  const contentLength = response.headers.get("content-length")
  const transferEncoding = response.headers.get("transfer-encoding")

  assert.ok(
    contentLength === String(Buffer.byteLength(body)) || transferEncoding === "chunked",
    `expected content-length=${Buffer.byteLength(body)} or transfer-encoding=chunked; got content-length=${contentLength}, transfer-encoding=${transferEncoding}`,
  )
}
