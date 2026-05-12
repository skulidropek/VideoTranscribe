import { Context, Data, Effect, Layer } from "effect"
import Tesseract from "tesseract.js"

import type { ExtractedFrame } from "./media.js"

export class OcrError extends Data.TaggedError("OcrError")<{
  readonly message: string
}> {}

export class OcrService extends Context.Tag("OcrService")<
  OcrService,
  {
    readonly recognizeFrames: (
      frames: ReadonlyArray<ExtractedFrame>,
      language: string
    ) => Effect.Effect<ReadonlyArray<ExtractedFrame>, OcrError>
  }
>() {}

const recognizeFrame = (frame: ExtractedFrame, language: string): Effect.Effect<ExtractedFrame, OcrError> =>
  Effect.tryPromise({
    catch: () => new OcrError({ message: `OCR failed for ${frame.fileName}` }),
    try: () => Tesseract.recognize(frame.path, language)
  }).pipe(
    Effect.map((result) => ({
      ...frame,
      ocrText: result.data.text.trim()
    }))
  )

export const OcrServiceLive = Layer.succeed(OcrService, {
  recognizeFrames: (frames, language) =>
    Effect.forEach(frames, (frame) => recognizeFrame(frame, language), { concurrency: 1 })
})
