import * as Chunk from "effect/Chunk"
import { describe, expect, it } from "vitest"

import { makeRouter } from "../../src/app/program.js"

const config = {
  host: "127.0.0.1",
  jobTtlMs: 3_600_000,
  maxUploadBytes: 10 * 1024 * 1024,
  murmurAiApiKey: "test",
  murmurAiBaseUrl: "http://localhost:8880",
  pollIntervalMs: 10,
  port: 0,
  transcriptTimeoutMs: 100
}

describe("web server routes", () => {
  it("defines the root web UI route", () => {
    const router = makeRouter(config)
    const root = Chunk.toReadonlyArray(router.routes).find((route) => route.path === "/" && route.method === "GET")

    expect(root).toBeDefined()
  })

  it("keeps API routes under the documented paths", () => {
    const paths = Chunk.toReadonlyArray(makeRouter(config).routes).map((route) => route.path)

    expect(paths).toContain("/api/jobs")
    expect(paths).toContain("/api/jobs/:id")
    expect(paths).toContain("/api/jobs/:id/download")
  })
})
