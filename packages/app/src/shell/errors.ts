import { Match } from "effect"

import type { ArchiveError } from "./services/archive.js"
import type { JobError } from "./services/jobs.js"
import type { MediaError } from "./services/media.js"
import type { TranscriptionError } from "./services/murmur-ai.js"
import type { OcrError } from "./services/ocr.js"

export type AppError = ArchiveError | JobError | MediaError | OcrError | TranscriptionError

export const appErrorMessage = (error: AppError): string =>
  Match.value(error).pipe(
    Match.when({ _tag: "ArchiveError" }, (value) => value.message),
    Match.when({ _tag: "JobError" }, (value) => value.message),
    Match.when({ _tag: "MediaError" }, (value) => value.message),
    Match.when({ _tag: "OcrError" }, (value) => value.message),
    Match.when({ _tag: "TranscriptionError" }, (value) => value.message),
    Match.exhaustive
  )
