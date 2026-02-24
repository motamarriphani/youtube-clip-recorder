console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let isRecording = false;
let isTransitioning = false;
let stopTimeoutId = null; // Timer to auto-stop recording
let reenableTimeoutId = null;
let domObserver = null;
let urlCheckObserver = null;
let lastUrl = location.href;
let lastIsWatchPage = false;
let reinjectDebounceId = null;

const DEFAULT_MAX_RECORD_DURATION_MS = 10000; // 10 seconds fallback
const MIN_RECORD_DURATION_SECONDS = 3;
const MAX_RECORD_DURATION_SECONDS = 60;
const STORAGE_KEY_MAX_DURATION_SECONDS = 'maxRecordDurationSeconds';
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
        // If background doesn't answer with state event for any reason, recover UI quickly.
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

    // Insert it before the settings button for visibility
    const settingsButton = controlsRight.querySelector('.ytp-settings-button');
    if (settingsButton) {
        controlsRight.insertBefore(button, settingsButton);
    } else {
        // Fallback: append to the end of right controls
        controlsRight.appendChild(button);
    }

    console.log('YouTube Clip Recorder: Button injected.');
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
        // --- Start Recording ---
        isTransitioning = true;
        setButtonState({ text: 'Starting...', color: '', disabled: true });

        const videoTitle = document.title.replace(/ - YouTube$/, '');
        const currentTimeSeconds = Math.floor(videoElement.currentTime);
        const timestamp = new Date(currentTimeSeconds * 1000).toISOString().substr(14, 5);

        try {
            const response = await chrome.runtime.sendMessage({
                action: "startRecording",
                payload: { title: videoTitle, timestamp: timestamp }
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
        // --- Stop Recording ---
        await requestStopRecording();
    }
}

chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) return;

    if (message.type === RECORDING_STARTED_EVENT) {
        await applyRecordingState();
    }

    if (message.type === RECORDING_STOPPED_EVENT) {
        resetUIState();
    }

    if (message.type === RECORDING_ERROR_EVENT) {
        console.error('YouTube Clip Recorder: Background recording error.', message.payload?.message || message.payload);
        resetUIState();
    }
});

function initialize() {
    if (!isWatchPageUrl()) {
        return;
    }

    const button = createRecordButton();
    if (button) {
        recordButton = button;
        resetUIState();
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

    // Navigated away from watch page
    if (isRecording) {
        console.log("YouTube Clip Recorder: Navigated away, stopping recording.");
        chrome.runtime.sendMessage({ action: "stopRecording" }).catch(e => console.log("Error sending stop on navigate away:", e));
        resetUIState();
    }

    // Remove button if it exists
    const existingButton = document.getElementById('yt-clip-recorder-button');
    if (existingButton) {
        existingButton.remove();
        if (recordButton === existingButton) {
            recordButton = null;
        }
    }
}

function startDomObservation() {
    if (domObserver) {
        domObserver.disconnect();
    }

    const target = document.querySelector('#movie_player, ytd-player, ytd-watch-flexy') || document.body;
    domObserver = new MutationObserver(() => {
        if (!isWatchPageUrl()) return;

        // Only attempt re-injection when control container changes/appears
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

    // Observe title/document mutations as lightweight triggers for SPA route changes
    urlCheckObserver = new MutationObserver(handleRouteOrStateChange);
    urlCheckObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // Catch history-based and back/forward navigations
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
