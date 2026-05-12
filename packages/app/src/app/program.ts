import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { Layer, pipe } from "effect"

import type { AppConfig } from "../shell/config.js"
import { ArchiveServiceLive } from "../shell/services/archive.js"
import { JobStoreLive } from "../shell/services/jobs.js"
import { MediaServiceLive } from "../shell/services/media.js"
import { MurmurAiServiceLive } from "../shell/services/murmur-ai.js"
import { OcrServiceLive } from "../shell/services/ocr.js"
import { indexHtml } from "../web/index.js"
import { createJobRoute, downloadRoute, errorJson, statusRoute } from "./routes.js"

export const makeRouter = (config: AppConfig) =>
  pipe(
    HttpRouter.empty,
    HttpRouter.get("/", HttpServerResponse.html(indexHtml)),
    HttpRouter.post("/api/jobs", createJobRoute(config)),
    HttpRouter.get("/api/jobs/:id", statusRoute),
    HttpRouter.get("/api/jobs/:id/download", downloadRoute),
    HttpRouter.catchTags({
      JobError: (error) => errorJson(error.message, error.message === "Job not found" ? 404 : 400)
    })
  )

export const makeServerLayer = (config: AppConfig) =>
  pipe(
    HttpServer.serve(makeRouter(config)),
    Layer.provide(
      Layer.mergeAll(
        ArchiveServiceLive,
        JobStoreLive,
        MediaServiceLive,
        MurmurAiServiceLive(config),
        OcrServiceLive
      )
    )
  )
