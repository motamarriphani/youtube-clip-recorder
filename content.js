console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let isRecording = false;
let stopTimeoutId = null; // Timer to auto-stop recording
let domObserver = null;
let urlCheckObserver = null;
let lastUrl = location.href;
let lastIsWatchPage = false;
let reinjectDebounceId = null;

const MAX_RECORD_DURATION_MS = 10000; // 10 seconds
const REINJECT_DEBOUNCE_MS = 150;

function isWatchPageUrl(url = location.href) {
    try {
        const parsed = new URL(url);
        return parsed.pathname === '/watch';
    } catch (_) {
        return url.includes('/watch');
    }
}

function resetRecordingUiState() {
    isRecording = false;

    if (recordButton) {
        recordButton.textContent = 'REC Clip';
        recordButton.style.color = '';
    }

    if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
    }
}

function stopRecordingIfActive(reason = '') {
    if (!isRecording) return;

    console.log(`YouTube Clip Recorder: ${reason || 'Stopping active recording.'}`);
    chrome.runtime.sendMessage({ action: 'stopRecording' }).catch((e) => {
        console.log('YouTube Clip Recorder: Error sending stop message:', e);
    });

    resetRecordingUiState();
}

function cleanupButton() {
    const existingButton = document.getElementById('yt-clip-recorder-button');
    if (existingButton) {
        existingButton.remove();
    }

    if (recordButton === existingButton) {
        recordButton = null;
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
    button.textContent = 'REC Clip'; // Keep it short
    button.classList.add('ytp-button'); // Try to mimic YouTube button style
    button.style.marginLeft = '8px'; // Add some space
    button.style.fontSize = '0.9em'; // Adjust size if needed
    button.style.padding = '5px 8px'; // Adjust padding

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
    if (!recordButton) return; // Safety check

    const videoElement = document.querySelector('video.html5-main-video');
    if (!videoElement) {
        console.error('YouTube Clip Recorder: Video element not found.');
        alert('Could not find the YouTube video element.');
        return;
    }

    if (!isRecording) {
        // --- Start Recording ---
        isRecording = true;
        recordButton.textContent = 'STOP ■'; // Indicate recording
        recordButton.style.color = 'red'; // Visual feedback

        const videoTitle = document.title.replace(/ - YouTube$/, ''); // Get clean title
        const currentTimeSeconds = Math.floor(videoElement.currentTime);
        const timestamp = new Date(currentTimeSeconds * 1000).toISOString().substr(14, 5); // Format as MM:SS

        try {
            // Send message to background script to start
            await chrome.runtime.sendMessage({
                action: 'startRecording',
                payload: { title: videoTitle, timestamp: timestamp }
            });
            console.log('YouTube Clip Recorder: Start recording message sent.');

            // Set timeout for automatic stop
            stopTimeoutId = setTimeout(() => {
                console.log('YouTube Clip Recorder: Max duration reached, stopping automatically.');
                handleRecordButtonClick(); // Call this function again to trigger the stop logic
            }, MAX_RECORD_DURATION_MS);
        } catch (error) {
            console.error('YouTube Clip Recorder: Error starting recording.', error);
            alert(`Error starting recording: ${error.message}`);
            resetRecordingUiState();
        }
    } else {
        // --- Stop Recording ---
        resetRecordingUiState();

        try {
            // Send message to background script to stop
            await chrome.runtime.sendMessage({ action: 'stopRecording' });
            console.log('YouTube Clip Recorder: Stop recording message sent.');
            // Optional: Maybe disable button briefly while saving?
            recordButton.disabled = true;
            setTimeout(() => {
                recordButton.disabled = false;
            }, 1000); // Re-enable after a short delay
        } catch (error) {
            console.error('YouTube Clip Recorder: Error stopping recording.', error);
            alert(`Error stopping recording: ${error.message}`);
        }
    }
}

function initialize() {
    if (!isWatchPageUrl()) {
        return;
    }

    const button = createRecordButton();
    if (button) {
        recordButton = button;

        // Ensure state is reset on init
        if (recordButton.textContent !== 'REC Clip') {
            resetRecordingUiState();
        }
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

    stopRecordingIfActive('Navigated away from watch page, stopping recording if active.');
    cleanupButton();
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

    // Observe title/document mutations as lightweight triggers for SPA route changes.
    urlCheckObserver = new MutationObserver(handleRouteOrStateChange);
    urlCheckObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // Catch history-based and back/forward navigations.
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
