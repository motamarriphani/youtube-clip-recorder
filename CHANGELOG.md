# Changelog

All notable changes to this project are documented in this file.

## [1.5.0] - 2026-03-28 (Stable)

### Added
- Export-time quality and frame-rate options in the clip preview modal.
- Multi-export workflow so the same clip can be downloaded multiple times before discard.
- Minimized-preview workflow during export so the clip tray can stay out of the way while watching.
- Stronger YouTube quality detection and normalized source labels for export presets.
- Preview now remains open after save/export so users can continue downloading variants.

### Changed
- Moved clip quality and FPS selection from popup settings into the preview/export flow.
- Updated duration settings persistence to use both local and sync storage for more reliable recorder timing.
- Kept completed previews alive after successful downloads instead of auto-discarding them.
- Paused the underlying YouTube player when the preview modal opens.

### Fixed
- Fixed repeated preview-load failures across follow-up recordings.
- Fixed service-worker finalize failures caused by unavailable object URL APIs.
- Fixed export/download regressions for generated blobs.
- Fixed popup duration selection behavior and improved reliability of saved duration reads.
- Fixed background audio playback during export by muting hidden transcode playback.

## [1.2.0] - 2026-03-02

### Added
- Recording timer feedback on the recorder button while capturing (`STOP mm:ss`).
- Dedicated regression test coverage for recent recording/download fixes.
- Native system `Save As...` picker flow from the preview action for user-selected filename/location.
- Confirm dialog when discarding from an already minimized preview window.

### Changed
- Unified watch URL checks to include YouTube embed pages (`/embed/*`) across content, popup, and readiness checks.
- Improved status chip rendering robustness in YouTube controls.
- Improved user-facing download error/cancel messages.

### Fixed
- Prevented pending clips from being auto-discarded when a download fails.
- Preserved inline recorder error visibility for stop reasons tied to failures.
- Fixed save picker MIME type handling by stripping codec parameters.
- Improved Save As handling for filename edge cases.
