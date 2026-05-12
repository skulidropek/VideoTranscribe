import type { CommandExecutor } from "@effect/platform"
import { Command, FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Layer, Order } from "effect"
import * as Arr from "effect/Array"
import ffmpegPath from "ffmpeg-static"

import type { VisualFrame } from "../../core/transcript.js"
import { formatError } from "../format-error.js"

export interface ExtractedFrame extends VisualFrame {
  readonly fileName: string
  readonly path: string
}

export interface FrameExtractionInput {
  readonly inputPath: string
  readonly workDir: string
}

export class MediaError extends Data.TaggedError("MediaError")<{
  readonly message: string
}> {}

export class MediaService extends Context.Tag("MediaService")<
  MediaService,
  {
    readonly extractFrames: (
      input: FrameExtractionInput
    ) => Effect.Effect<
      ReadonlyArray<ExtractedFrame>,
      MediaError,
      CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path
    >
  }
>() {}

const requireFfmpeg = (): Effect.Effect<string, MediaError> =>
  ffmpegPath === null
    ? Effect.fail(new MediaError({ message: "ffmpeg-static binary is not available" }))
    : Effect.succeed(ffmpegPath)

const frameTimeMs = (index: number): number => index * 30_000

const isJpegFrameName = (name: string): boolean => name.endsWith(".jpg")

const filterJpegFrameNames = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.filter<string>((name) => isJpegFrameName(name))(names)

const insertSortedName = (sorted: ReadonlyArray<string>, name: string): ReadonlyArray<string> => {
  const [after, before] = Arr.partition(sorted, (current) => Order.string(current, name) <= 0)
  return [...before, name, ...after]
}

const sortNames = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.matchLeft(names, {
    onEmpty: () => [],
    onNonEmpty: (head, tail) => insertSortedName(sortNames(tail), head)
  })

const toExtractedFrame = (
  framesDir: string,
  fileName: string,
  index: number,
  pathService: Path.Path
): ExtractedFrame => ({
  description: `frames/${fileName}`,
  fileName,
  ocrText: "",
  path: pathService.join(framesDir, fileName),
  timestampMs: frameTimeMs(index),
  title: `Frame ${String(index + 1)}`
})

export const MediaServiceLive = Layer.succeed(MediaService, {
  extractFrames: (input) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const ffmpeg = yield* requireFfmpeg()
      const framesDir = pathService.join(input.workDir, "frames")
      yield* fs.makeDirectory(framesDir, { recursive: true })

      const outputPattern = pathService.join(framesDir, "frame-%04d.jpg")
      const command = Command.make(
        ffmpeg,
        "-y",
        "-i",
        input.inputPath,
        "-vf",
        "fps=1/30,scale=1280:-1",
        "-q:v",
        "3",
        outputPattern
      )
      const exitCode = yield* Command.exitCode(command)
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(new MediaError({ message: `ffmpeg exited with code ${Number(exitCode)}` }))
      }

      const names = yield* fs.readDirectory(framesDir)
      return sortNames(filterJpegFrameNames(names))
        .map((name, index) => toExtractedFrame(framesDir, name, index, pathService))
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "MediaError"
          ? cause
          : new MediaError({ message: `Frame extraction failed: ${formatError(cause)}` })
      )
    )
})
