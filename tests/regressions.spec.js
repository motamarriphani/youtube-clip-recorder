const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('saveClip only schedules clip cleanup after download starts', async () => {
  const source = readProjectFile('background.js');
  expect(source).toContain('let downloadStarted = false;');
  expect(source).toContain('downloadStarted = true;');
  expect(source).toContain('if (downloadStarted) {');
  expect(source).toContain('scheduleClipCleanup(clipId);');
});

test('YouTube URL checks include embed pages across background and popup', async () => {
  const backgroundSource = readProjectFile('background.js');
  const popupSource = readProjectFile('popup.js');

  expect(backgroundSource).toContain('pathname.startsWith("/embed/")');
  expect(popupSource).toContain("pathname.startsWith('/embed/')");
});

test('content script preserves inline errors for error-related stop reasons', async () => {
  const source = readProjectFile('content.js');

  expect(source).toContain('const RECORDING_STOP_REASON_RECORDER_ERROR = "recorderError";');
  expect(source).toContain('const RECORDING_STOP_REASON_START_FAILED = "startFailed";');
  expect(source).toContain('const RECORDING_STOP_REASON_FINALIZE_FAILED = "finalizeFailed";');
  expect(source).toContain('if (');
  expect(source).toContain('stopReason === RECORDING_STOP_REASON_RECORDER_ERROR');
  expect(source).toContain('stopReason === RECORDING_STOP_REASON_START_FAILED');
  expect(source).toContain('stopReason === RECORDING_STOP_REASON_FINALIZE_FAILED');
});

test('recording timer is mirrored onto the record button for visible feedback', async () => {
  const source = readProjectFile('content.js');

  expect(source).toContain('recordButton.textContent = `STOP ${elapsedClock}`;');
  expect(source).toContain("setButtonState({ text: 'STOP 00:00'");
});

test('Save As uses system file picker from content script', async () => {
  const source = readProjectFile('content.js');

  expect(source).toContain('async function saveBlobWithSystemPicker');
  expect(source).toContain('window.showSaveFilePicker');
  expect(source).toContain('if (saveAs) {');
  expect(source).toContain('await saveBlobWithSystemPicker({');
});

test('discard in minimized preview uses popup confirm', async () => {
  const source = readProjectFile('content.js');

  expect(source).toContain("const isMinimized = overlay.classList.contains('yt-clip-preview-overlay-minimized');");
  expect(source).toContain("window.confirm('Discard this clip permanently?')");
  expect(source).toContain("console.error('YouTube Clip Recorder: Failed to discard from minimized preview.', error);");
});
