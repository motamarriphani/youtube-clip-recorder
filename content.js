console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let audioToggle = null;
let isRecording = false;
let isTransitioning = false;
let stopTimeoutId = null;
let reenableTimeoutId = null;
let domObserver = null;
let urlCheckObserver = null;
let lastUrl = location.href;
let lastIsWatchPage = false;
let reinjectDebounceId = null;

let activePreviewClipId = null;
let previewModalEl = null;

const DEFAULT_MAX_RECORD_DURATION_MS = 10000;
const MIN_RECORD_DURATION_SECONDS = 3;
const MAX_RECORD_DURATION_SECONDS = 60;
const STORAGE_KEY_MAX_DURATION_SECONDS = 'maxRecordDurationSeconds';
const AUDIO_PREF_KEY = 'includeTabAudio';
const REINJECT_DEBOUNCE_MS = 150;

const RECORDING_STARTED_EVENT = "recordingStarted";
const RECORDING_STOPPED_EVENT = "recordingStopped";
const RECORDING_ERROR_EVENT = "recordingError";

function isWatchPageUrl(url = location.href) {
    try {
        const parsed = new URL(url);
        return parsed.pathname === '/watch';
    } catch (_) {
        return url.includes('/watch');
    }
}

function clampDurationSeconds(value) {
    const seconds = Number.parseInt(value, 10);
    if (Number.isNaN(seconds)) {
        return DEFAULT_MAX_RECORD_DURATION_MS / 1000;
    }
    return Math.min(MAX_RECORD_DURATION_SECONDS, Math.max(MIN_RECORD_DURATION_SECONDS, seconds));
}

async function getMaxRecordDurationMs() {
    try {
        const settings = await chrome.storage.sync.get(STORAGE_KEY_MAX_DURATION_SECONDS);
        const boundedSeconds = clampDurationSeconds(settings?.[STORAGE_KEY_MAX_DURATION_SECONDS]);
        return boundedSeconds * 1000;
    } catch (error) {
        console.warn("YouTube Clip Recorder: Failed to load duration from storage, using default.", error);
        return DEFAULT_MAX_RECORD_DURATION_MS;
    }
}

async function getIncludeAudioPreference() {
    try {
        const stored = await chrome.storage.local.get({ [AUDIO_PREF_KEY]: false });
        return Boolean(stored[AUDIO_PREF_KEY]);
    } catch (error) {
        return false;
    }
}

function clearTimers() {
    if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
    }
    if (reenableTimeoutId) {
        clearTimeout(reenableTimeoutId);
        reenableTimeoutId = null;
    }
}

function setButtonState({ text, color = '', disabled = false }) {
    if (!recordButton) return;
    recordButton.textContent = text;
    recordButton.style.color = color;
    recordButton.disabled = disabled;
}

function resetUIState() {
    isRecording = false;
    isTransitioning = false;
    clearTimers();
    setButtonState({ text: 'REC Clip', color: '', disabled: false });
}

async function applyRecordingState() {
    isRecording = true;
    isTransitioning = false;
    setButtonState({ text: 'STOP ■', color: 'red', disabled: false });

    clearTimeout(stopTimeoutId);
    const maxDurationMs = await getMaxRecordDurationMs();
    stopTimeoutId = setTimeout(() => {
        console.log("YouTube Clip Recorder: Max duration reached, stopping automatically.");
        requestStopRecording();
    }, maxDurationMs);
}

async function requestStopRecording() {
    if (!recordButton || isTransitioning) {
        return;
    }

    isTransitioning = true;
    setButtonState({ text: 'Stopping...', color: '', disabled: true });

    try {
        await chrome.runtime.sendMessage({ action: "stopRecording" });
        console.log("YouTube Clip Recorder: Stop recording message sent.");
        reenableTimeoutId = setTimeout(() => {
            if (!isRecording) {
                resetUIState();
            }
        }, 1200);
    } catch (error) {
        console.error("YouTube Clip Recorder: Error stopping recording.", error);
        alert(`Error stopping recording: ${error.message}`);
        resetUIState();
    }
}

function createAudioToggle() {
    if (document.getElementById('yt-clip-recorder-audio-toggle')) {
        return document.getElementById('yt-clip-recorder-audio-toggle');
    }

    const label = document.createElement('label');
    label.id = 'yt-clip-recorder-audio-toggle';
    label.className = 'yt-clip-recorder-audio-toggle ytp-button';
    label.style.marginLeft = '8px';
    label.style.fontSize = '0.9em';
    label.style.padding = '5px 8px';
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '4px';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'yt-clip-recorder-audio-checkbox';
    checkbox.title = 'Include tab audio in recording';

    const text = document.createElement('span');
    text.textContent = 'Audio';

    checkbox.addEventListener('change', async () => {
        await chrome.storage.local.set({ [AUDIO_PREF_KEY]: checkbox.checked });
    });

    label.appendChild(checkbox);
    label.appendChild(text);

    return label;
}

function createRecordButton() {
    const existingButton = document.getElementById('yt-clip-recorder-button');
    if (existingButton) {
        return existingButton;
    }

    const controlsRight = document.querySelector('.ytp-right-controls');
    if (!controlsRight) {
        return null;
    }

    const button = document.createElement('button');
    button.id = 'yt-clip-recorder-button';
    button.textContent = 'REC Clip';
    button.classList.add('ytp-button');
    button.style.marginLeft = '8px';
    button.style.fontSize = '0.9em';
    button.style.padding = '5px 8px';
    button.onclick = handleRecordButtonClick;

    const toggle = createAudioToggle();

    const settingsButton = controlsRight.querySelector('.ytp-settings-button');
    if (settingsButton) {
        controlsRight.insertBefore(toggle, settingsButton);
        controlsRight.insertBefore(button, settingsButton);
    } else {
        controlsRight.appendChild(toggle);
        controlsRight.appendChild(button);
    }
    audioToggle = toggle;

    console.log('YouTube Clip Recorder: Button and audio toggle injected.');
    return button;
}

async function handleRecordButtonClick() {
    if (!recordButton || isTransitioning) return;

    const videoElement = document.querySelector('video.html5-main-video');
    if (!videoElement) {
        console.error("YouTube Clip Recorder: Video element not found.");
        alert("Could not find the YouTube video element.");
        return;
    }

    if (!isRecording) {
        isTransitioning = true;
        setButtonState({ text: 'Starting...', color: '', disabled: true });

        const videoTitle = document.title.replace(/ - YouTube$/, '');
        const currentTimeSeconds = Math.floor(videoElement.currentTime);
        const timestamp = new Date(currentTimeSeconds * 1000).toISOString().substr(14, 5);
        const includeAudio = Boolean(audioToggle?.querySelector('input')?.checked);

        try {
            const response = await chrome.runtime.sendMessage({
                action: "startRecording",
                payload: { title: videoTitle, timestamp: timestamp, includeAudio }
            });

            if (!response?.success) {
                throw new Error(response?.message || "Failed to start recording.");
            }

            console.log("YouTube Clip Recorder: Start recording message sent.");
            await applyRecordingState();
        } catch (error) {
            console.error("YouTube Clip Recorder: Error starting recording.", error);
            alert(`Error starting recording: ${error.message}`);
            resetUIState();
        }
    } else {
        await requestStopRecording();
    }
}

function showPreviewModal({ clipId, url, filename }) {
    discardPreviewLocally();
    activePreviewClipId = clipId;

    const overlay = document.createElement('div');
    overlay.id = 'yt-clip-preview-overlay';
    overlay.innerHTML = `
        <div class="yt-clip-preview-modal" role="dialog" aria-label="Clip preview">
            <button class="yt-clip-preview-close" aria-label="Close preview">✕</button>
            <h3>Preview Clip</h3>
            <video controls src="${url}"></video>
            <p class="yt-clip-preview-filename">${filename}</p>
            <div class="yt-clip-preview-actions">
                <button class="yt-clip-btn yt-clip-save">Save</button>
                <button class="yt-clip-btn yt-clip-save-as">Save As…</button>
                <button class="yt-clip-btn yt-clip-discard">Discard</button>
            </div>
        </div>
    `;

    const onDiscard = async () => {
        if (!activePreviewClipId) return;
        await chrome.runtime.sendMessage({
            action: "discardClip",
            payload: { clipId: activePreviewClipId },
        });
        discardPreviewLocally();
    };

    overlay.querySelector('.yt-clip-save')?.addEventListener('click', async () => {
        if (!activePreviewClipId) return;
        await chrome.runtime.sendMessage({
            action: "saveClip",
            payload: { clipId: activePreviewClipId, saveAs: false },
        });
        discardPreviewLocally();
    });

    overlay.querySelector('.yt-clip-save-as')?.addEventListener('click', async () => {
        if (!activePreviewClipId) return;
        await chrome.runtime.sendMessage({
            action: "saveClip",
            payload: { clipId: activePreviewClipId, saveAs: true },
        });
        discardPreviewLocally();
    });

    overlay.querySelector('.yt-clip-discard')?.addEventListener('click', onDiscard);
    overlay.querySelector('.yt-clip-preview-close')?.addEventListener('click', onDiscard);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            onDiscard();
        }
    });

    document.body.appendChild(overlay);
    previewModalEl = overlay;
}

function discardPreviewLocally() {
    if (previewModalEl) {
        previewModalEl.remove();
        previewModalEl = null;
    }
    activePreviewClipId = null;
}

async function cleanupPreviewOnUnload() {
    if (!activePreviewClipId) return;
    try {
        await chrome.runtime.sendMessage({
            action: "discardClip",
            payload: { clipId: activePreviewClipId },
        });
    } catch (error) {
        console.warn("YouTube Clip Recorder: Failed to cleanup preview clip.", error);
    }
}

chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;

    if (message.action === 'clipReadyForPreview') {
        showPreviewModal(message.payload);
        return;
    }

    if (message.type === RECORDING_STARTED_EVENT) {
        applyRecordingState();
    } else if (message.type === RECORDING_STOPPED_EVENT) {
        resetUIState();
    } else if (message.type === RECORDING_ERROR_EVENT) {
        console.error('YouTube Clip Recorder: Background recording error.', message.payload?.message || message.payload);
        resetUIState();
    }
});

window.addEventListener('beforeunload', cleanupPreviewOnUnload);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        cleanupPreviewOnUnload();
    }
});

async function initialize() {
    if (!isWatchPageUrl()) {
        return;
    }

    const button = createRecordButton();
    if (button) {
        recordButton = button;
        resetUIState();
    }

    if (!audioToggle) {
        audioToggle = document.getElementById('yt-clip-recorder-audio-toggle');
    }

    const includeAudio = await getIncludeAudioPreference();
    const checkbox = audioToggle?.querySelector('input');
    if (checkbox) {
        checkbox.checked = includeAudio;
    }
}

function debouncedInitialize() {
    if (reinjectDebounceId) {
        clearTimeout(reinjectDebounceId);
    }

    reinjectDebounceId = setTimeout(() => {
        reinjectDebounceId = null;
        initialize();
    }, REINJECT_DEBOUNCE_MS);
}

function handleRouteOrStateChange() {
    const currentUrl = location.href;
    const currentIsWatchPage = isWatchPageUrl(currentUrl);
    const watchStateChanged = currentIsWatchPage !== lastIsWatchPage;
    const urlChanged = currentUrl !== lastUrl;

    if (!urlChanged && !watchStateChanged) {
        return;
    }

    lastUrl = currentUrl;
    lastIsWatchPage = currentIsWatchPage;

    if (currentIsWatchPage) {
        debouncedInitialize();
        return;
    }

    if (isRecording) {
        console.log("YouTube Clip Recorder: Navigated away, stopping recording.");
        chrome.runtime.sendMessage({ action: "stopRecording" }).catch(e => console.log("Error sending stop on navigate away:", e));
        resetUIState();
    }

    const existingButton = document.getElementById('yt-clip-recorder-button');
    const existingToggle = document.getElementById('yt-clip-recorder-audio-toggle');
    if (existingButton) {
        existingButton.remove();
        recordButton = null;
    }
    if (existingToggle) {
        existingToggle.remove();
        audioToggle = null;
    }

    discardPreviewLocally();
}

function startDomObservation() {
    if (domObserver) {
        domObserver.disconnect();
    }

    const target = document.querySelector('#movie_player, ytd-player, ytd-watch-flexy') || document.body;
    domObserver = new MutationObserver(() => {
        if (!isWatchPageUrl()) return;

        if (!document.getElementById('yt-clip-recorder-button') || document.querySelector('.ytp-right-controls')) {
            debouncedInitialize();
        }
    });

    domObserver.observe(target, {
        childList: true,
        subtree: true
    });
}

function startUrlObservation() {
    if (urlCheckObserver) {
        urlCheckObserver.disconnect();
    }

    urlCheckObserver = new MutationObserver(handleRouteOrStateChange);
    urlCheckObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    window.addEventListener('popstate', handleRouteOrStateChange);
    window.addEventListener('yt-navigate-finish', handleRouteOrStateChange);

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        const result = originalPushState.apply(this, args);
        handleRouteOrStateChange();
        return result;
    };

    history.replaceState = function (...args) {
        const result = originalReplaceState.apply(this, args);
        handleRouteOrStateChange();
        return result;
    };
}

function bootstrap() {
    lastUrl = location.href;
    lastIsWatchPage = isWatchPageUrl(lastUrl);

    startDomObservation();
    startUrlObservation();
    handleRouteOrStateChange();
    debouncedInitialize();
}

bootstrap();
