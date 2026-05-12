import { FileSystem, HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Context, Data, Duration, Effect, Layer, pipe } from "effect"
import * as S from "effect/Schema"

import type { Utterance } from "../../core/transcript.js"
import type { AppConfig } from "../config.js"
import { formatError } from "../format-error.js"

const submittedSchema = S.Struct({
  id: S.String
})

const utteranceSchema = S.Struct({
  end: S.Number,
  speaker: S.String,
  start: S.Number,
  text: S.String
})

const transcriptStatusSchema = S.Struct({
  error: S.NullishOr(S.String),
  id: S.String,
  status: S.Literal("queued", "processing", "completed", "error"),
  text: S.NullishOr(S.String),
  utterances: S.NullishOr(S.Array(utteranceSchema))
})

type TranscriptStatus = S.Schema.Type<typeof transcriptStatusSchema>
type SubmittedTranscript = S.Schema.Type<typeof submittedSchema>

export interface TranscriptionInput {
  readonly contentType: string
  readonly fileName: string
  readonly inputPath: string
  readonly languageCode: string
  readonly speakersExpected: number | undefined
}

export class TranscriptionError extends Data.TaggedError("TranscriptionError")<{
  readonly message: string
}> {}

export class MurmurAiService extends Context.Tag("MurmurAiService")<
  MurmurAiService,
  {
    readonly transcribe: (
      input: TranscriptionInput
    ) => Effect.Effect<ReadonlyArray<Utterance>, TranscriptionError, FileSystem.FileSystem | HttpClient.HttpClient>
  }
>() {}

const endpoint = (config: AppConfig, path: string): string => `${config.murmurAiBaseUrl}${path}`

const withAuth = (config: AppConfig) => HttpClientRequest.setHeader("Authorization", config.murmurAiApiKey)

interface MultipartBody {
  readonly body: Uint8Array
  readonly contentType: string
}

interface MultipartField {
  readonly name: string
  readonly value: string
}

const textEncoder = new TextEncoder()

const encodeText = (value: string): Uint8Array => textEncoder.encode(value)

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const headerValue = (value: string): string => value.replaceAll(/[\r\n"]/g, "_")

const languageFields = (input: TranscriptionInput): ReadonlyArray<MultipartField> => {
  const languageCode = input.languageCode.trim()
  return languageCode.length > 0 ? [{ name: "language_code", value: languageCode }] : []
}

const speakerFields = (input: TranscriptionInput): ReadonlyArray<MultipartField> =>
  input.speakersExpected === undefined
    ? [{ name: "speaker_labels", value: "true" }]
    : [
      { name: "speaker_labels", value: "true" },
      { name: "speakers_expected", value: String(input.speakersExpected) }
    ]

const multipartFields = (input: TranscriptionInput): ReadonlyArray<MultipartField> => [
  ...languageFields(input),
  ...speakerFields(input),
  { name: "vad_method", value: "silero" }
]

const fieldPart = (boundary: string, field: MultipartField): Uint8Array =>
  encodeText(
    `--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(field.name)}"\r\n\r\n${field.value}\r\n`
  )

const fileHeader = (boundary: string, input: TranscriptionInput): Uint8Array =>
  encodeText(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${headerValue(input.fileName)}"`,
      `Content-Type: ${input.contentType}`,
      "",
      ""
    ].join("\r\n")
  )

const makeMultipartBody = (
  input: TranscriptionInput
): Effect.Effect<MultipartBody, TranscriptionError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const bytes = yield* fs.readFile(input.inputPath)
    const boundary = `videotranscribe-${yield* Effect.sync(() => globalThis.crypto.randomUUID())}`
    return {
      body: concatBytes([
        ...multipartFields(input).map((field) => fieldPart(boundary, field)),
        fileHeader(boundary, input),
        bytes,
        encodeText(`\r\n--${boundary}--\r\n`)
      ]),
      contentType: `multipart/form-data; boundary=${boundary}`
    }
  }).pipe(
    Effect.mapError((cause) => new TranscriptionError({ message: `Cannot read uploaded media: ${formatError(cause)}` }))
  )

const submitTranscript = (
  config: AppConfig,
  input: TranscriptionInput
): Effect.Effect<SubmittedTranscript, TranscriptionError, FileSystem.FileSystem | HttpClient.HttpClient> =>
  pipe(
    makeMultipartBody(input),
    Effect.map((multipart) =>
      pipe(
        HttpClientRequest.post(endpoint(config, "/v1/transcript")),
        withAuth(config),
        HttpClientRequest.bodyUint8Array(multipart.body, multipart.contentType)
      )
    ),
    Effect.flatMap((request) => HttpClient.execute(request)),
    Effect.flatMap((response) => HttpClientResponse.filterStatusOk(response)),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(submittedSchema)),
    Effect.mapError((cause) => new TranscriptionError({ message: `MurmurAI submit failed: ${formatError(cause)}` }))
  )

const getTranscriptStatus = (
  config: AppConfig,
  id: string
): Effect.Effect<TranscriptStatus, TranscriptionError, HttpClient.HttpClient> =>
  pipe(
    HttpClientRequest.get(endpoint(config, `/v1/transcript/${id}`)),
    withAuth(config),
    HttpClient.execute,
    Effect.flatMap((response) => HttpClientResponse.filterStatusOk(response)),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(transcriptStatusSchema)),
    Effect.mapError((cause) => new TranscriptionError({ message: `MurmurAI polling failed: ${formatError(cause)}` }))
  )

const normalizeUtterance = (utterance: S.Schema.Type<typeof utteranceSchema>): Utterance => ({
  endMs: Math.max(0, Math.round(utterance.end)),
  speaker: utterance.speaker.trim().length > 0 ? utterance.speaker : "UNKNOWN",
  startMs: Math.max(0, Math.round(utterance.start)),
  text: utterance.text.trim()
})

const completedUtterances = (status: TranscriptStatus): ReadonlyArray<Utterance> =>
  (status.utterances ?? []).length > 0
    ? (status.utterances ?? []).map((utterance) => normalizeUtterance(utterance))
    : [{
      endMs: 0,
      speaker: "SPEAKER_00",
      startMs: 0,
      text: status.text?.trim() ?? ""
    }]

const pollTranscript = (
  config: AppConfig,
  id: string,
  remainingAttempts: number
): Effect.Effect<ReadonlyArray<Utterance>, TranscriptionError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    if (remainingAttempts <= 0) {
      return yield* Effect.fail(new TranscriptionError({ message: "MurmurAI transcription timed out" }))
    }

    const status = yield* getTranscriptStatus(config, id)
    if (status.status === "completed") {
      return completedUtterances(status)
    }
    if (status.status === "error") {
      return yield* Effect.fail(new TranscriptionError({ message: status.error ?? "MurmurAI job failed" }))
    }

    yield* Effect.sleep(Duration.millis(config.pollIntervalMs))
    return yield* pollTranscript(config, id, remainingAttempts - 1)
  })

const maxAttempts = (config: AppConfig): number =>
  Math.max(1, Math.ceil(config.transcriptTimeoutMs / config.pollIntervalMs))

export const MurmurAiServiceLive = (config: AppConfig) =>
  Layer.succeed(MurmurAiService, {
    transcribe: (input) =>
      Effect.gen(function*() {
        const submitted = yield* submitTranscript(config, input)
        return yield* pollTranscript(config, submitted.id, maxAttempts(config))
      })
  })
