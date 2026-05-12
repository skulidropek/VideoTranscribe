import { Match } from "effect"

export type TranscriptMode =
  | { readonly kind: "text" }
  | { readonly kind: "text-with-visuals"; readonly includeOcrText: boolean }

export type Utterance = {
  readonly speaker: string
  readonly text: string
  readonly startMs: number
  readonly endMs: number
}

export type VisualFrame = {
  readonly fileName: string
  readonly timeMs?: number
  readonly ocrText: string
  readonly title?: string
  readonly description?: string
  readonly timestampMs?: number
}

export type TranscriptArtifact = {
  readonly title: string
  readonly mode: TranscriptMode
  readonly utterances: ReadonlyArray<Utterance>
  readonly visualFrames: ReadonlyArray<VisualFrame>
  readonly metadata: TranscriptMetadata
  readonly text: string
  readonly markdown: string
}

export type TranscriptMetadata = {
  readonly title: string
  readonly mode: TranscriptMode["kind"]
  readonly durationMs: number
  readonly utteranceCount: number
  readonly visualFrameCount: number
  readonly speakerCount: number
  readonly speakers: ReadonlyArray<string>
  readonly hasVisualFrames: boolean
  readonly hasOcrText: boolean
}

/**
 * Formats a millisecond offset into a deterministic transcript timecode.
 *
 * @param milliseconds - Non-negative media offset in milliseconds.
 * @returns `MM:SS` below one hour, otherwise `HH:MM:SS`.
 *
 * @pure true
 * @invariant milliseconds < 3_600_000 ⇒ result.length = 5
 * @complexity O(1) time / O(1) space
 */
export const formatTimecode = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = padTimeUnit(minutes)
  const ss = padTimeUnit(seconds)

  return hours > 0 ? `${padTimeUnit(hours)}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Builds deterministic transcript metadata from the artifact value only.
 *
 * @param artifact - Complete transcript value.
 * @returns Stable metadata object with counts and duration.
 *
 * @pure true
 * @invariant durationMs = max(endMs, timeMs) over artifact content, or 0 for empty artifacts
 * @complexity O(u + v) time / O(s) space
 */
export const buildTranscriptMetadata = (
  artifact: TranscriptArtifact
): TranscriptMetadata => {
  const speakers = collectSpeakers(artifact.utterances)
  const durationMs = Math.max(
    0,
    maxUtteranceEndMs(artifact.utterances),
    maxVisualTimestampMs(artifact.visualFrames)
  )

  return {
    title: artifact.title,
    mode: artifact.mode.kind,
    durationMs,
    utteranceCount: artifact.utterances.length,
    visualFrameCount: artifact.visualFrames.length,
    speakerCount: speakers.length,
    speakers,
    hasVisualFrames: artifact.visualFrames.length > 0,
    hasOcrText: artifact.visualFrames.some((frame) => frame.ocrText.trim().length > 0)
  }
}

/**
 * Renders transcript content into plain text.
 *
 * @param artifact - Complete transcript value.
 * @returns Plain text transcript, optionally including visual frames by mode.
 *
 * @pure true
 * @invariant order(result.utterances) = order(artifact.utterances)
 * @complexity O(u + v) time / O(u + v) space
 */
export const renderTranscriptText = (artifact: TranscriptArtifact): string =>
  joinSections([
    renderTextHeader(artifact),
    renderUtteranceTextBlock(artifact.utterances),
    renderVisualTextBlock(artifact.mode, artifact.visualFrames)
  ])

/**
 * Renders transcript content into Markdown.
 *
 * @param artifact - Complete transcript value.
 * @returns Markdown transcript, optionally including visual frames by mode.
 *
 * @pure true
 * @invariant markdown contains exactly artifact.utterances.length utterance bullets
 * @complexity O(u + v) time / O(u + v) space
 */
export const renderTranscriptMarkdown = (artifact: TranscriptArtifact): string =>
  joinSections([
    `# ${artifact.title}`,
    renderMetadataMarkdown(buildTranscriptMetadata(artifact)),
    renderUtteranceMarkdownBlock(artifact.utterances),
    renderVisualMarkdownBlock(artifact.mode, artifact.visualFrames)
  ])

export const formatVisualFrameText = (
  mode: TranscriptMode,
  frame: VisualFrame
): string =>
  formatVisualFrame(mode, frame, {
    kind: "plain",
    marker: `[${formatTimecode(frameTimestampMs(frame))}] VISUAL: ${frameTitle(frame)}`,
    body: frameDescription(frame),
    ocrPrefix: "OCR: "
  })

export const formatVisualFrameMarkdown = (
  mode: TranscriptMode,
  frame: VisualFrame
): string =>
  formatVisualFrame(mode, frame, {
    kind: "markdown",
    marker: `- \`${formatTimecode(frameTimestampMs(frame))}\` **${frameTitle(frame)}**`,
    body: `  ${frameDescription(frame)}`,
    ocrPrefix: "  OCR: "
  })

type VisualFrameFormat = {
  readonly kind: "plain" | "markdown"
  readonly marker: string
  readonly body: string
  readonly ocrPrefix: string
}

const formatVisualFrame = (
  mode: TranscriptMode,
  frame: VisualFrame,
  format: VisualFrameFormat
): string =>
  Match.value(mode).pipe(
    Match.when({ kind: "text" }, () => ""),
    Match.when({ kind: "text-with-visuals" }, ({ includeOcrText }) =>
      joinLines([
        format.marker,
        format.body,
        includeOcrText ? renderOcrLine(frame, format.ocrPrefix) : ""
      ])),
    Match.exhaustive
  )

const padTimeUnit = (value: number): string => String(value).padStart(2, "0")

const collectSpeakers = (
  utterances: ReadonlyArray<Utterance>
): ReadonlyArray<string> =>
  utterances
    .map((utterance) => utterance.speaker)
    .filter((speaker, index, speakers) => speakers.indexOf(speaker) === index)

const maxUtteranceEndMs = (utterances: ReadonlyArray<Utterance>): number =>
  Math.max(0, ...utterances.map((utterance) => utterance.endMs))

const maxVisualTimestampMs = (frames: ReadonlyArray<VisualFrame>): number =>
  Math.max(0, ...frames.map((frame) => frameTimestampMs(frame)))

const frameTimestampMs = (frame: VisualFrame): number => frame.timestampMs ?? frame.timeMs ?? 0

const frameTitle = (frame: VisualFrame): string => frame.title ?? frame.fileName

const frameDescription = (frame: VisualFrame): string => frame.description ?? `Captured frame ${frame.fileName}`

const joinLines = (lines: ReadonlyArray<string>): string => lines.filter((line) => line.length > 0).join("\n")

const joinSections = (sections: ReadonlyArray<string>): string =>
  sections.filter((section) => section.length > 0).join("\n\n")

const renderTextHeader = (artifact: TranscriptArtifact): string => {
  const metadata = buildTranscriptMetadata(artifact)

  return joinLines([
    artifact.title,
    `Duration: ${formatTimecode(metadata.durationMs)}`,
    `Speakers: ${metadata.speakers.join(", ")}`
  ])
}

const renderUtteranceTextBlock = (
  utterances: ReadonlyArray<Utterance>
): string =>
  utterances
    .map(
      (utterance) => `[${formatTimecode(utterance.startMs)}] ${utterance.speaker}:\n${utterance.text.trim()}`
    )
    .join("\n\n")

const renderVisualTextBlock = (mode: TranscriptMode, frames: ReadonlyArray<VisualFrame>): string =>
  renderVisualBlock(mode, frames, "", formatVisualFrameText)

const renderMetadataMarkdown = (metadata: TranscriptMetadata): string =>
  joinLines([
    `- Duration: \`${formatTimecode(metadata.durationMs)}\``,
    `- Mode: \`${metadata.mode}\``,
    `- Utterances: \`${metadata.utteranceCount.toString()}\``,
    `- Visual frames: \`${metadata.visualFrameCount.toString()}\``,
    `- Speakers: ${metadata.speakers.join(", ")}`
  ])

const renderUtteranceMarkdownBlock = (
  utterances: ReadonlyArray<Utterance>
): string =>
  joinSections([
    "## Transcript",
    utterances
      .map(
        (utterance) => `- \`${formatTimecode(utterance.startMs)}\` **${utterance.speaker}**: ${utterance.text.trim()}`
      )
      .join("\n")
  ])

const renderVisualMarkdownBlock = (mode: TranscriptMode, frames: ReadonlyArray<VisualFrame>): string =>
  renderVisualBlock(mode, frames, "## Visual frames", formatVisualFrameMarkdown)

const renderVisualBlock = (
  mode: TranscriptMode,
  frames: ReadonlyArray<VisualFrame>,
  heading: string,
  renderFrame: (mode: TranscriptMode, frame: VisualFrame) => string
): string =>
  Match.value(mode).pipe(
    Match.when({ kind: "text" }, () => ""),
    Match.when({ kind: "text-with-visuals" }, () =>
      joinSections([heading, frames.map((frame) => renderFrame(mode, frame)).join("\n")])),
    Match.exhaustive
  )

const renderOcrLine = (frame: VisualFrame, prefix: string): string =>
  frame.ocrText.trim().length > 0 ? `${prefix}${frame.ocrText.trim()}` : ""
