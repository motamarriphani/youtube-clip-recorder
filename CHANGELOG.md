# Changelog

All notable changes to this project are documented in this file.

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
