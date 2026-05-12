import { NodeContext, NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, pipe } from "effect"
import { createServer } from "node:http"

import { readAppConfig } from "../shell/config.js"
import { makeServerLayer } from "./program.js"

/**
 * Starts the VideoTranscribe web server with Node platform services.
 *
 * @pure false - opens an HTTP server and reads process env
 * @effect HttpServer, HttpClient, FileSystem, CommandExecutor
 * @invariant server layer is launched only after config decoding succeeds
 * @complexity O(1) time / O(1) space
 */
const main = pipe(
  readAppConfig,
  Effect.flatMap((config) =>
    Layer.launch(
      pipe(
        makeServerLayer(config),
        Layer.provide(NodeContext.layer),
        Layer.provide(NodeHttpClient.layerUndici),
        Layer.provide(
          NodeHttpServer.layerConfig(
            createServer,
            Config.succeed({ host: config.host, port: config.port })
          )
        )
      )
    )
  )
)

NodeRuntime.runMain(main)
