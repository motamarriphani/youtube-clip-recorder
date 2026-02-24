const DEFAULT_MAX_RECORD_DURATION_SECONDS = 10;
const MIN_RECORD_DURATION_SECONDS = 3;
const MAX_RECORD_DURATION_SECONDS = 60;
const STORAGE_KEY_MAX_DURATION_SECONDS = 'maxRecordDurationSeconds';

const durationSelect = document.getElementById('duration');
const saveButton = document.getElementById('save');
const statusElement = document.getElementById('status');

function clampDurationSeconds(value) {
  const seconds = Number.parseInt(value, 10);

  if (Number.isNaN(seconds)) {
    return DEFAULT_MAX_RECORD_DURATION_SECONDS;
  }

  return Math.min(MAX_RECORD_DURATION_SECONDS, Math.max(MIN_RECORD_DURATION_SECONDS, seconds));
}

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.style.color = isError ? '#b42318' : '#1a7f37';
}

async function loadSettings() {
  try {
    const settings = await chrome.storage.sync.get(STORAGE_KEY_MAX_DURATION_SECONDS);
    const seconds = clampDurationSeconds(settings?.[STORAGE_KEY_MAX_DURATION_SECONDS]);
    durationSelect.value = String(seconds);
    setStatus('');
  } catch (error) {
    console.error('Failed to load max duration setting.', error);
    durationSelect.value = String(DEFAULT_MAX_RECORD_DURATION_SECONDS);
    setStatus('Could not load saved setting.', true);
  }
}

async function saveSettings() {
  const selectedValue = durationSelect.value;
  const seconds = clampDurationSeconds(selectedValue);

  if (Number.parseInt(selectedValue, 10) !== seconds) {
    durationSelect.value = String(seconds);
    setStatus(`Duration must be between ${MIN_RECORD_DURATION_SECONDS}s and ${MAX_RECORD_DURATION_SECONDS}s.`, true);
    return;
  }

  try {
    await chrome.storage.sync.set({ [STORAGE_KEY_MAX_DURATION_SECONDS]: seconds });
    setStatus('Saved.');
  } catch (error) {
    console.error('Failed to save max duration setting.', error);
    setStatus('Could not save setting.', true);
  }
}

saveButton.addEventListener('click', saveSettings);
document.addEventListener('DOMContentLoaded', loadSettings);
