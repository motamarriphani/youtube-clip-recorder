const DEFAULT_MAX_RECORD_DURATION_SECONDS = 10;
const MIN_RECORD_DURATION_SECONDS = 3;
const MAX_RECORD_DURATION_SECONDS = 60;
const STORAGE_KEY_MAX_DURATION_SECONDS = 'maxRecordDurationSeconds';
const DURATION_OPTIONS = [3, 5, 10, 15, 20, 30, 45, 60];

const durationOptionsContainer = document.getElementById('durationOptions');
const durationOptionButtons = Array.from(document.querySelectorAll('.duration-option'));
const saveButton = document.getElementById('save');
const statusElement = document.getElementById('status');
const readinessElement = document.getElementById('readiness');
const checkReadinessButton = document.getElementById('checkReadiness');
let selectedDurationSeconds = DEFAULT_MAX_RECORD_DURATION_SECONDS;

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

function setReadiness(message, tone = 'warning') {
  readinessElement.textContent = message;
  readinessElement.classList.remove('ready', 'warning', 'error');
  readinessElement.classList.add(tone);
}

function setSelectedDuration(seconds) {
  selectedDurationSeconds = clampDurationSeconds(seconds);
  durationOptionButtons.forEach((button) => {
    const buttonSeconds = Number.parseInt(button.dataset.seconds || '', 10);
    button.classList.toggle('is-active', buttonSeconds === selectedDurationSeconds);
  });
}

async function loadSettings() {
  try {
    const localSettings = await chrome.storage.local.get(STORAGE_KEY_MAX_DURATION_SECONDS);
    const syncSettings = await chrome.storage.sync.get(STORAGE_KEY_MAX_DURATION_SECONDS);
    const settings = {
      [STORAGE_KEY_MAX_DURATION_SECONDS]:
        localSettings?.[STORAGE_KEY_MAX_DURATION_SECONDS] ?? syncSettings?.[STORAGE_KEY_MAX_DURATION_SECONDS],
    };
    const seconds = clampDurationSeconds(settings?.[STORAGE_KEY_MAX_DURATION_SECONDS]);
    setSelectedDuration(seconds);
    setStatus('');
  } catch (error) {
    console.error('Failed to load saved settings.', error);
    setSelectedDuration(DEFAULT_MAX_RECORD_DURATION_SECONDS);
    setStatus('Could not load saved settings.', true);
  }
}

async function saveSettings() {
  const seconds = clampDurationSeconds(selectedDurationSeconds);

  try {
    await chrome.storage.local.set({ [STORAGE_KEY_MAX_DURATION_SECONDS]: seconds });
    await chrome.storage.sync.set({ [STORAGE_KEY_MAX_DURATION_SECONDS]: seconds });
    setStatus('Saved.');
  } catch (error) {
    console.error('Failed to save recording settings.', error);
    setStatus('Could not save settings.', true);
  }
}

function isLikelyYouTubeWatchUrl(url = '') {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('youtube.com')) {
      return false;
    }
    const pathname = parsed.pathname || '';
    return pathname === '/watch'
      || pathname.startsWith('/embed/')
      || pathname.startsWith('/shorts/')
      || pathname.startsWith('/live/');
  } catch (_) {
    return false;
  }
}

async function getActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function checkReadiness() {
  setReadiness('Checking...', 'warning');
  try {
    const activeTab = await getActiveTabInfo();
    if (!activeTab?.id) {
      setReadiness('Open a YouTube tab first.', 'error');
      return;
    }

    if (!isLikelyYouTubeWatchUrl(activeTab.url || '')) {
      setReadiness('Open a YouTube watch page first.', 'warning');
      return;
    }

    const response = await chrome.runtime.sendMessage({
      action: 'getCaptureReadiness',
      payload: {
        tabId: activeTab.id,
        pageUrl: activeTab.url || '',
      },
    });

    if (!response?.success) {
      setReadiness(response?.message || 'Not ready yet.', 'error');
      return;
    }

    if (response.ready) {
      setReadiness('Ready for recording on this tab.', 'ready');
      return;
    }

    setReadiness(response.message || 'Not ready yet.', 'warning');
  } catch (error) {
    console.error('Failed to check readiness.', error);
    setReadiness('Could not check readiness.', 'error');
  }
}

saveButton.addEventListener('click', saveSettings);
durationOptionsContainer.addEventListener('click', (event) => {
  const button = event.target.closest('.duration-option');
  if (!button) {
    return;
  }
  const seconds = Number.parseInt(button.dataset.seconds || '', 10);
  if (!DURATION_OPTIONS.includes(seconds)) {
    return;
  }
  setSelectedDuration(seconds);
});
checkReadinessButton.addEventListener('click', checkReadiness);
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await checkReadiness();
});
