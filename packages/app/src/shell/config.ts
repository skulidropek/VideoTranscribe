import { Data, Effect } from "effect"

export interface AppConfig {
  readonly host: string
  readonly port: number
  readonly maxUploadBytes: number
  readonly murmurAiBaseUrl: string
  readonly murmurAiApiKey: string
  readonly jobTtlMs: number
  readonly pollIntervalMs: number
  readonly transcriptTimeoutMs: number
}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
}> {}

const readString = (key: string, fallback: string): string => process.env[key] ?? fallback

const readPositiveInteger = (key: string, fallback: number): Effect.Effect<number, ConfigError> =>
  Effect.gen(function*() {
    const raw = process.env[key]
    if (raw === undefined) {
      return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed
    }
    return yield* Effect.fail(new ConfigError({ message: `${key} must be a positive integer` }))
  })

/**
 * Read runtime configuration from process env at the shell boundary.
 *
 * @pure false
 * @effect process.env
 * @invariant maxUploadBytes > 0 and port > 0
 * @complexity O(1) time / O(1) space
 */
export const readAppConfig: Effect.Effect<AppConfig, ConfigError> = Effect.gen(function*() {
  const port = yield* readPositiveInteger("VIDEOTRANSCRIBE_PORT", 3000)
  const maxUploadMb = yield* readPositiveInteger("VIDEOTRANSCRIBE_MAX_UPLOAD_MB", 2048)
  const jobTtlMs = yield* readPositiveInteger("VIDEOTRANSCRIBE_JOB_TTL_MS", 3_600_000)
  const pollIntervalMs = yield* readPositiveInteger("VIDEOTRANSCRIBE_POLL_INTERVAL_MS", 2000)
  const transcriptTimeoutMs = yield* readPositiveInteger("VIDEOTRANSCRIBE_TIMEOUT_MS", 3_600_000)

  return {
    host: readString("VIDEOTRANSCRIBE_HOST", "127.0.0.1"),
    jobTtlMs,
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    murmurAiApiKey: readString("MURMURAI_API_KEY", "namastex888"),
    murmurAiBaseUrl: readString("MURMURAI_BASE_URL", "http://localhost:8880"),
    pollIntervalMs,
    port,
    transcriptTimeoutMs
  }
})
