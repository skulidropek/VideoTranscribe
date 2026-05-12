import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  buildTranscriptMetadata,
  formatTimecode,
  formatVisualFrameText,
  renderTranscriptMarkdown,
  renderTranscriptText,
  type TranscriptArtifact,
  type TranscriptMetadata,
  type VisualFrame
} from "../../src/core/transcript.js"

const dashboardFrame: VisualFrame = {
  fileName: "frame-0001.jpg",
  timeMs: 70_000,
  title: "Dashboard",
  description: "Revenue chart is visible.",
  timestampMs: 70_000,
  ocrText: "Q1 revenue"
}

const textMetadata: TranscriptMetadata = {
  title: "Demo meeting",
  mode: "text",
  durationMs: 70_000,
  utteranceCount: 2,
  visualFrameCount: 1,
  speakerCount: 2,
  speakers: ["SPEAKER_A", "SPEAKER_B"],
  hasVisualFrames: true,
  hasOcrText: true
}

const visualMetadata: TranscriptMetadata = {
  ...textMetadata,
  mode: "text-with-visuals"
}

const textArtifact: TranscriptArtifact = {
  title: "Demo meeting",
  mode: { kind: "text" },
  utterances: [
    {
      speaker: "SPEAKER_A",
      text: "Opening line.",
      startMs: 12_345,
      endMs: 15_000
    },
    {
      speaker: "SPEAKER_B",
      text: "Reply line.",
      startMs: 65_000,
      endMs: 68_500
    }
  ],
  visualFrames: [dashboardFrame],
  metadata: textMetadata,
  text: "",
  markdown: ""
}

const visualArtifact: TranscriptArtifact = {
  ...textArtifact,
  mode: { kind: "text-with-visuals", includeOcrText: true },
  metadata: visualMetadata
}

describe("formatTimecode", () => {
  it.effect("formats sub-hour offsets into MM:SS", () =>
    Effect.sync(() => {
      expect(formatTimecode(12_345)).toBe("00:12")
      expect(formatTimecode(65_000)).toBe("01:05")
    }))

  it.effect("formats hour offsets into HH:MM:SS", () =>
    Effect.sync(() => {
      expect(formatTimecode(3_661_000)).toBe("01:01:01")
    }))
})

describe("renderTranscriptText", () => {
  it.effect("renders utterances without visual frames in text mode", () =>
    Effect.sync(() => {
      expect(renderTranscriptText(textArtifact)).toBe(
        [
          "Demo meeting",
          "Duration: 01:10",
          "Speakers: SPEAKER_A, SPEAKER_B",
          "",
          "[00:12] SPEAKER_A:",
          "Opening line.",
          "",
          "[01:05] SPEAKER_B:",
          "Reply line."
        ].join("\n")
      )
    }))

  it.effect("renders visual frames and OCR in visual mode", () =>
    Effect.sync(() => {
      expect(renderTranscriptText(visualArtifact)).toContain(
        "[01:10] VISUAL: Dashboard\nRevenue chart is visible.\nOCR: Q1 revenue"
      )
    }))
})

describe("renderTranscriptMarkdown", () => {
  it.effect("renders markdown metadata and utterances", () =>
    Effect.sync(() => {
      expect(renderTranscriptMarkdown(textArtifact)).toBe(
        [
          "# Demo meeting",
          "",
          "- Duration: `01:10`",
          "- Mode: `text`",
          "- Utterances: `2`",
          "- Visual frames: `1`",
          "- Speakers: SPEAKER_A, SPEAKER_B",
          "",
          "## Transcript",
          "",
          "- `00:12` **SPEAKER_A**: Opening line.",
          "- `01:05` **SPEAKER_B**: Reply line."
        ].join("\n")
      )
    }))
})

describe("buildTranscriptMetadata", () => {
  it.effect("builds counts, speakers and visual flags deterministically", () =>
    Effect.sync(() => {
      expect(buildTranscriptMetadata(visualArtifact)).toStrictEqual(visualMetadata)
    }))
})

describe("formatVisualFrameText", () => {
  it.effect("omits OCR text when the visual mode disables OCR", () =>
    Effect.sync(() => {
      expect(
        formatVisualFrameText(
          { kind: "text-with-visuals", includeOcrText: false },
          dashboardFrame
        )
      ).toBe("[01:10] VISUAL: Dashboard\nRevenue chart is visible.")
    }))
})
