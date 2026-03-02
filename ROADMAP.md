# Roadmap

This roadmap tracks planned features for the YouTube Clip Recorder.

Tracking model:
- Primary planning in this file.
- Execution and discussion in GitHub Issues.
- Priority managed by issue ordering (top to bottom).

## Planned Features

1. Instant "Record Last X Seconds" hotkey
- Goal: capture the previous N seconds (e.g. 10/15/30) without needing a manual start first.
- User value: easier clipping for moments that just happened.
- Acceptance notes: configurable lookback durations, reliable buffer behavior, no regression to normal recording.
- Issue: https://github.com/motamarriphani/youtube-clip-recorder/issues/13

2. Trim start/end in preview before save
- Goal: allow setting precise in/out points in preview before download.
- User value: cleaner clips without needing external editors.
- Acceptance notes: frame-safe trimming UI, preview seek updates, works with audio/no-audio export paths.
- Issue: https://github.com/motamarriphani/youtube-clip-recorder/issues/14

3. Recording quality and FPS presets
- Goal: offer quality presets (e.g. 720p/1080p and frame-rate presets).
- User value: control over size vs quality/performance.
- Acceptance notes: preset selection persisted, capability fallback handling, visible active preset.
- Issue: https://github.com/motamarriphani/youtube-clip-recorder/issues/15

4. Optional burned-in timestamp/watermark
- Goal: optionally overlay timestamp/title watermark in exported clips.
- User value: better context for sharing and reference clips.
- Acceptance notes: toggle in settings/preview, readable placement, disabled by default.
- Issue: https://github.com/motamarriphani/youtube-clip-recorder/issues/16

5. Batch queue for pending clips
- Goal: keep multiple clips in a pending queue and process save/discard per item.
- User value: record several moments first, decide exports later.
- Acceptance notes: queue list UI, per-item actions, memory cleanup guarantees.
- Issue: https://github.com/motamarriphani/youtube-clip-recorder/issues/17

6. Keyboard shortcuts for recorder and preview actions
- Goal: add keyboard-first controls for start/stop/save/discard/minimize/replay.
- User value: faster workflow for power users.
- Acceptance notes: shortcuts documented, conflict-safe defaults, enable/disable option.
- Issue: https://github.com/motamarriphani/youtube-clip-recorder/issues/18

7. Capture diagnostics panel with actionable errors
- Goal: show detailed readiness and failure diagnostics with next-step guidance.
- User value: faster self-recovery when recording fails.
- Acceptance notes: clear error codes/messages, suggested actions, copy diagnostics button.
- Issue: https://github.com/motamarriphani/youtube-clip-recorder/issues/19

## Execution Order

1. Instant "Record Last X Seconds" hotkey
2. Trim start/end in preview before save
3. Recording quality and FPS presets
4. Optional burned-in timestamp/watermark
5. Batch queue for pending clips
6. Keyboard shortcuts for recorder and preview actions
7. Capture diagnostics panel with actionable errors
