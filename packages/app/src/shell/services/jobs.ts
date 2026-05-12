import { Context, Data, Effect, Layer, Option, Ref } from "effect"

import type { TranscriptMode } from "../../core/transcript.js"

export type JobStatus = "queued" | "processing" | "completed" | "failed"

export interface JobRecord {
  readonly id: string
  readonly status: JobStatus
  readonly progress: number
  readonly mode: TranscriptMode
  readonly createdAt: number
  readonly updatedAt: number
  readonly error: string | undefined
  readonly preview: string | undefined
  readonly downloadPath: string | undefined
  readonly workDir: string
}

export class JobError extends Data.TaggedError("JobError")<{
  readonly message: string
}> {}

export interface CreateJobInput {
  readonly id: string
  readonly mode: TranscriptMode
  readonly now: number
  readonly workDir: string
}

export class JobStore extends Context.Tag("JobStore")<
  JobStore,
  {
    readonly create: (input: CreateJobInput) => Effect.Effect<JobRecord>
    readonly get: (id: string) => Effect.Effect<Option.Option<JobRecord>>
    readonly update: (id: string, f: (job: JobRecord) => JobRecord) => Effect.Effect<void>
  }
>() {}

const makeInitialJob = (input: CreateJobInput): JobRecord => ({
  createdAt: input.now,
  downloadPath: undefined,
  error: undefined,
  id: input.id,
  mode: input.mode,
  preview: undefined,
  progress: 0,
  status: "queued",
  updatedAt: input.now,
  workDir: input.workDir
})

export const JobStoreLive = Layer.effect(
  JobStore,
  Effect.gen(function*() {
    const ref = yield* Ref.make<ReadonlyMap<string, JobRecord>>(new Map())

    return {
      create: (input) =>
        Effect.gen(function*() {
          const job = makeInitialJob(input)
          yield* Ref.update(ref, (jobs) => new Map(jobs).set(job.id, job))
          return job
        }),
      get: (id) => pipeGet(ref, id),
      update: (id, f) =>
        Ref.update(ref, (jobs) => {
          const current = jobs.get(id)
          if (current === undefined) {
            return jobs
          }
          return new Map(jobs).set(id, f(current))
        })
    }
  })
)

const pipeGet = (
  ref: Ref.Ref<ReadonlyMap<string, JobRecord>>,
  id: string
): Effect.Effect<Option.Option<JobRecord>> => Effect.map(Ref.get(ref), (jobs) => Option.fromNullable(jobs.get(id)))

const updateStampedJob = (
  id: string,
  update: (job: JobRecord, now: number) => JobRecord
): Effect.Effect<void, never, JobStore> =>
  Effect.gen(function*() {
    const jobs = yield* JobStore
    const now = yield* Effect.sync(() => Date.now())
    yield* jobs.update(id, (job) => update(job, now))
  })

export const setJobProcessing = (id: string, progress: number): Effect.Effect<void, never, JobStore> =>
  updateStampedJob(id, (job, now) => ({ ...job, progress, status: "processing", updatedAt: now }))

export const setJobCompleted = (
  id: string,
  preview: string,
  downloadPath: string
): Effect.Effect<void, never, JobStore> =>
  updateStampedJob(id, (job, now) => ({
    ...job,
    downloadPath,
    error: undefined,
    preview,
    progress: 100,
    status: "completed",
    updatedAt: now
  }))

export const setJobFailed = (id: string, message: string): Effect.Effect<void, never, JobStore> =>
  updateStampedJob(id, (job, now) => ({
    ...job,
    error: message,
    progress: 100,
    status: "failed",
    updatedAt: now
  }))
