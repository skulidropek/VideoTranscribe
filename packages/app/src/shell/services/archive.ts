import { FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Layer } from "effect"
import { strToU8, zipSync } from "fflate"

import {
  buildTranscriptMetadata,
  renderTranscriptMarkdown,
  renderTranscriptText,
  type TranscriptArtifact
} from "../../core/transcript.js"
import { formatError } from "../format-error.js"
import type { ExtractedFrame } from "./media.js"

export class ArchiveError extends Data.TaggedError("ArchiveError")<{
  readonly message: string
}> {}

export class ArchiveService extends Context.Tag("ArchiveService")<
  ArchiveService,
  {
    readonly buildZip: (
      artifact: TranscriptArtifact,
      frames: ReadonlyArray<ExtractedFrame>,
      workDir: string
    ) => Effect.Effect<string, ArchiveError, FileSystem.FileSystem | Path.Path>
  }
>() {}

const ocrJson = (frames: ReadonlyArray<ExtractedFrame>): string =>
  JSON.stringify(
    frames.map((frame) => ({
      fileName: frame.fileName,
      ocrText: frame.ocrText,
      timeMs: frame.timestampMs
    })),
    null,
    2
  )

export const ArchiveServiceLive = Layer.succeed(ArchiveService, {
  buildZip: (artifact, frames, workDir) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const entries: Record<string, Uint8Array> = {
        "metadata.json": strToU8(JSON.stringify(buildTranscriptMetadata(artifact), null, 2)),
        "ocr.json": strToU8(ocrJson(frames)),
        "transcript.md": strToU8(renderTranscriptMarkdown(artifact)),
        "transcript.txt": strToU8(renderTranscriptText(artifact))
      }

      yield* Effect.forEach([...frames], (frame) =>
        Effect.gen(function*() {
          const bytes = yield* fs.readFile(frame.path)
          entries[`frames/${frame.fileName}`] = bytes
        }))

      const archivePath = pathService.join(workDir, "videotranscribe-result.zip")
      yield* fs.writeFile(archivePath, zipSync(entries))
      return archivePath
    }).pipe(Effect.mapError((cause) => new ArchiveError({ message: `ZIP build failed: ${formatError(cause)}` })))
})
