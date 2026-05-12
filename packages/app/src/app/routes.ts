import type { CommandExecutor, HttpClient, HttpPlatform } from "@effect/platform"
import { FileSystem, HttpRouter, HttpServerRequest, HttpServerResponse, Multipart, Path } from "@effect/platform"
import type { Scope } from "effect"
import { Effect, Match, Option, pipe, Runtime } from "effect"
import * as S from "effect/Schema"

import {
  renderTranscriptText,
  type TranscriptArtifact,
  type TranscriptMetadata,
  type TranscriptMode,
  type Utterance
} from "../core/transcript.js"
import type { AppConfig } from "../shell/config.js"
import { type AppError, appErrorMessage } from "../shell/errors.js"
import { formatError } from "../shell/format-error.js"
import { ArchiveService } from "../shell/services/archive.js"
import {
  JobError,
  type JobRecord,
  JobStore,
  setJobCompleted,
  setJobFailed,
  setJobProcessing
} from "../shell/services/jobs.js"
import { type ExtractedFrame, MediaService } from "../shell/services/media.js"
import { MurmurAiService, type TranscriptionInput } from "../shell/services/murmur-ai.js"
import { OcrService } from "../shell/services/ocr.js"

const uploadSchema = S.Struct({
  file: Multipart.SingleFileSchema,
  languageCode: S.optional(S.NonEmptyString),
  mode: S.Literal("text", "text+images", "text-images"),
  ocrLanguage: S.optional(S.NonEmptyString),
  speakersExpected: S.optional(S.NumberFromString)
})

type UploadInput = S.Schema.Type<typeof uploadSchema>

interface ProcessingInput {
  readonly contentType: string
  readonly fileName: string
  readonly id: string
  readonly inputPath: string
  readonly languageCode: string
  readonly mode: TranscriptMode
  readonly ocrLanguage: string
  readonly speakersExpected: number | undefined
  readonly workDir: string
}

type JobEnvironment =
  | ArchiveService
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | JobStore
  | MediaService
  | MurmurAiService
  | OcrService
  | Path.Path
  | Scope.Scope

export const json = (body: object, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeJson(body, { status })

export const errorJson = (message: string, status = 500): HttpServerResponse.HttpServerResponse =>
  json({ error: message }, status)

const toMode = (mode: UploadInput["mode"]): TranscriptMode =>
  mode === "text" ? { kind: "text" } : { includeOcrText: true, kind: "text-with-visuals" }

const optionalPositiveInteger = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined

const safeFileName = (fileName: string): string => {
  const sanitized = fileName.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 128)
  return sanitized.length > 0 ? sanitized : "upload.bin"
}

const getUpload = (
  config: AppConfig
): Effect.Effect<
  UploadInput,
  JobError,
  HttpServerRequest.HttpServerRequest | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  pipe(
    HttpServerRequest.schemaBodyMultipart(uploadSchema),
    HttpServerRequest.withMaxBodySize(Option.fromNullable(config.maxUploadBytes)),
    Effect.mapError((cause) => new JobError({ message: `Invalid upload: ${formatError(cause)}` }))
  )

const makeJobWorkDir: Effect.Effect<string, JobError, FileSystem.FileSystem> = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectory({ prefix: "videotranscribe-" })
}).pipe(Effect.mapError((cause) => new JobError({ message: `Cannot create job workspace: ${formatError(cause)}` })))

const copyUploadToJob = (
  file: Multipart.PersistedFile,
  workDir: string
): Effect.Effect<string, JobError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const destination = path.join(workDir, safeFileName(file.name))
    yield* fs.copyFile(file.path, destination)
    return destination
  }).pipe(Effect.mapError((cause) => new JobError({ message: `Cannot persist uploaded file: ${formatError(cause)}` })))

const createProcessingInput = (
  id: string,
  workDir: string,
  upload: UploadInput
): Effect.Effect<ProcessingInput, JobError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const inputPath = yield* copyUploadToJob(upload.file, workDir)
    return {
      contentType: upload.file.contentType.length > 0 ? upload.file.contentType : "application/octet-stream",
      fileName: upload.file.name,
      id,
      inputPath,
      languageCode: upload.languageCode ?? "ru",
      mode: toMode(upload.mode),
      ocrLanguage: upload.ocrLanguage ?? "rus+eng",
      speakersExpected: optionalPositiveInteger(upload.speakersExpected),
      workDir
    }
  })

const transcribeInput = (input: ProcessingInput): TranscriptionInput => ({
  contentType: input.contentType,
  fileName: input.fileName,
  inputPath: input.inputPath,
  languageCode: input.languageCode,
  speakersExpected: input.speakersExpected
})

const extractVisualFrames = (
  input: ProcessingInput
): Effect.Effect<
  ReadonlyArray<ExtractedFrame>,
  AppError,
  CommandExecutor.CommandExecutor | MediaService | OcrService | FileSystem.FileSystem | Path.Path
> =>
  Match.value(input.mode).pipe(
    Match.when({ kind: "text" }, () => Effect.succeed([])),
    Match.when({ kind: "text-with-visuals" }, () =>
      Effect.gen(function*() {
        const media = yield* MediaService
        const ocr = yield* OcrService
        const frames = yield* media.extractFrames({ inputPath: input.inputPath, workDir: input.workDir })
        return yield* ocr.recognizeFrames(frames, input.ocrLanguage)
      })),
    Match.exhaustive
  )

const buildArtifact = (
  input: ProcessingInput,
  utterances: ReadonlyArray<Utterance>,
  frames: ReadonlyArray<ExtractedFrame>
): TranscriptArtifact => {
  const metadata: TranscriptMetadata = {
    durationMs: 0,
    hasOcrText: false,
    hasVisualFrames: frames.length > 0,
    mode: input.mode.kind,
    speakerCount: 0,
    speakers: [],
    title: input.fileName,
    utteranceCount: utterances.length,
    visualFrameCount: frames.length
  }

  return {
    markdown: "",
    metadata,
    mode: input.mode,
    text: "",
    title: input.fileName,
    utterances,
    visualFrames: frames
  }
}

const processJob = (
  input: ProcessingInput
): Effect.Effect<void, AppError, JobEnvironment> =>
  Effect.gen(function*() {
    const transcriber = yield* MurmurAiService
    const archive = yield* ArchiveService
    yield* setJobProcessing(input.id, 10)
    const utterances = yield* transcriber.transcribe(transcribeInput(input))
    yield* setJobProcessing(input.id, 65)
    const frames = yield* extractVisualFrames(input)
    yield* setJobProcessing(input.id, 90)
    const artifact = buildArtifact(input, utterances, frames)
    const archivePath = yield* archive.buildZip(artifact, frames, input.workDir)
    yield* setJobCompleted(input.id, renderTranscriptText(artifact).slice(0, 12_000), archivePath)
  })

const runJob = (input: ProcessingInput): Effect.Effect<void, never, JobEnvironment> =>
  Effect.matchEffect(processJob(input), {
    onFailure: (error) => setJobFailed(input.id, appErrorMessage(error)),
    onSuccess: () => Effect.void
  })

const forkJob = (input: ProcessingInput): Effect.Effect<void, never, JobEnvironment> =>
  Effect.gen(function*() {
    const context = yield* Effect.context<JobEnvironment>()
    const runtime = yield* Effect.runtime()
    yield* Effect.sync(() => {
      Runtime.runFork(runtime, pipe(runJob(input), Effect.provide(context)))
    })
  })

export const createJobRoute = (
  config: AppConfig
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  JobError,
  JobEnvironment | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function*() {
    const upload = yield* getUpload(config)
    const jobs = yield* JobStore
    const id = yield* Effect.sync(() => globalThis.crypto.randomUUID())
    const now = yield* Effect.sync(() => Date.now())
    const workDir = yield* makeJobWorkDir
    const input = yield* createProcessingInput(id, workDir, upload)
    const job = yield* jobs.create({ id, mode: input.mode, now, workDir })
    yield* forkJob(input)
    return json(jobResponse(job), 202)
  })

const readJob = (id: string): Effect.Effect<JobRecord, JobError, JobStore> =>
  Effect.gen(function*() {
    const jobs = yield* JobStore
    const job = yield* jobs.get(id)
    return yield* Option.match(job, {
      onNone: () => Effect.fail(new JobError({ message: "Job not found" })),
      onSome: Effect.succeed
    })
  })

const readRouteJob: Effect.Effect<JobRecord, JobError, HttpRouter.RouteContext | JobStore> = Effect.gen(function*() {
  const params = yield* HttpRouter.params
  const id = params["id"]
  if (id === undefined) {
    return yield* Effect.fail(new JobError({ message: "Job id is required" }))
  }
  return yield* readJob(id)
})

const jobResponse = (job: JobRecord): object => ({
  error: job.error,
  id: job.id,
  preview: job.preview,
  progress: job.progress,
  status: job.status
})

export const statusRoute: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  JobError,
  HttpRouter.RouteContext | JobStore
> = Effect.gen(function*() {
  const job = yield* readRouteJob
  return json(jobResponse(job))
})

export const downloadRoute: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  JobError,
  HttpRouter.RouteContext | HttpPlatform.HttpPlatform | JobStore
> = Effect.gen(function*() {
  const job = yield* readRouteJob
  if (job.status !== "completed" || job.downloadPath === undefined) {
    return yield* Effect.fail(new JobError({ message: "Job result is not ready" }))
  }
  return yield* HttpServerResponse.file(job.downloadPath, {
    contentType: "application/zip",
    headers: {
      "content-disposition": `attachment; filename="${job.id}.zip"`
    }
  }).pipe(Effect.mapError((cause) => new JobError({ message: `Cannot read archive: ${formatError(cause)}` })))
})
