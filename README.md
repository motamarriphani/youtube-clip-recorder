# YouTube Clip Recorder

Chrome extension to capture short clips from the currently open YouTube watch page.

## What It Does

- Adds a `REC Clip` button to the YouTube player controls.
- Records clips with audio by default.
- Automatically stops at a configurable max duration.
- Shows a preview modal after recording.
- Lets you choose download mode in preview: `with audio` or `without audio`.
- Lets you `Save`, `Save As...`, or `Discard` before download.

## Why This Exists

YouTube has no built-in one-click clip export for local files. This extension adds a lightweight workflow for quickly capturing moments while you watch.

## How It Works

### 1. Content script (`content.js`)

- Injects recording UI into YouTube player controls.
- Sends `startRecording` and `stopRecording` messages to the background service worker.
- Displays the clip preview modal.
- Exports a no-audio download variant on demand from the preview modal.

### 2. Background service worker (`background.js`)

- Uses `chrome.tabCapture` to capture the active tab video and audio.
- Uses `MediaRecorder` with best available codec support.
- Stores clip metadata and blob references for preview/save flow.
- Persists pending clips in IndexedDB so save/discard can still work across service worker restarts.
- Downloads clip files through `chrome.downloads`.

### 3. Popup settings (`popup.html`, `popup.js`)

- Lets users choose maximum clip duration (`3s` to `60s`).
- Stores the setting in `chrome.storage.sync`.

## Permissions

- `tabCapture`: capture current tab stream for clip recording.
- `downloads`: save generated clips to disk.
- `storage`: persist user settings and preferences.
- `scripting`: reserved for extension-side script operations.
- `host_permissions` on `*://*.youtube.com/*`: run on YouTube watch pages.

## Installation (Developer Mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `youtube-clip-recorder`.
5. Open any YouTube watch page and verify `REC Clip` appears in player controls.

## Usage

1. Open a YouTube video (`/watch` page).
2. Click `REC Clip` to start.
3. Click `STOP` or wait for auto-stop at max duration.
4. In preview modal, choose `Download with audio` ON/OFF.
5. Then choose:
   - `Save` for direct download
   - `Save As...` to pick location/name
   - `Discard` to remove the clip

## Project Structure

- `manifest.json`: extension configuration (MV3).
- `content.js`: YouTube UI injection and interaction logic.
- `background.js`: capture, encoding, persistence, and download logic.
- `style.css`: injected UI styles.
- `popup.html`: settings UI.
- `popup.js`: settings persistence logic.

## Manual Test Checklist

- Recorder button appears on YouTube watch pages.
- Recorder button does not persist on non-watch pages.
- Start/stop recording works repeatedly in one tab.
- Auto-stop triggers at configured max duration.
- Preview shows playable clip.
- Download works in both modes: with audio and no-audio export.
- `Save`, `Save As...`, and `Discard` all work.
- Recording filename is valid on Windows.
- Save/discard still works after service worker restart.

## Known Limitations

- Capture quality and available codecs depend on Chrome/OS support.
- This records the rendered tab stream, not source media files.
- Browser autoplay policies and protected content may affect outcomes.
- Extension currently targets YouTube watch page UI and may need updates if YouTube changes control DOM structure.

## Privacy

- No backend service is used.
- Clips are processed locally in your browser and saved to your machine.
- Settings are stored in Chrome extension storage.
