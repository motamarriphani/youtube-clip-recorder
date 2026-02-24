console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let isRecording = false;
let isTransitioning = false;
let stopTimeoutId = null; // Timer to auto-stop recording
let reenableTimeoutId = null;
const MAX_RECORD_DURATION_MS = 10000; // 10 seconds

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

function applyRecordingState() {
    isRecording = true;
    isTransitioning = false;
    setButtonState({ text: 'STOP ■', color: 'red', disabled: false });

    clearTimeout(stopTimeoutId);
    stopTimeoutId = setTimeout(() => {
        console.log("YouTube Clip Recorder: Max duration reached, stopping automatically.");
        requestStopRecording();
    }, MAX_RECORD_DURATION_MS);
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
    if (document.getElementById('yt-clip-recorder-button')) {
        // Button already exists, potentially from a previous SPA navigation
        return document.getElementById('yt-clip-recorder-button');
    }

    const button = document.createElement('button');
    button.id = 'yt-clip-recorder-button';
    button.textContent = 'REC Clip'; // Keep it short
    button.classList.add('ytp-button'); // Try to mimic YouTube button style
    button.style.marginLeft = '8px'; // Add some space
    button.style.fontSize = '0.9em'; // Adjust size if needed
    button.style.padding = '5px 8px'; // Adjust padding

    button.onclick = handleRecordButtonClick;

    // Try to inject the button into YouTube's control bar
    // This selector might change with YouTube updates!
    const controlsRight = document.querySelector('.ytp-right-controls');
    if (controlsRight) {
        // Insert it before the settings button for visibility
        const settingsButton = controlsRight.querySelector('.ytp-settings-button');
        if (settingsButton) {
            controlsRight.insertBefore(button, settingsButton);
        } else {
            // Fallback: append to the end of right controls
            controlsRight.appendChild(button);
        }
        console.log("YouTube Clip Recorder: Button injected.");
        return button;
    }

    console.warn("YouTube Clip Recorder: Could not find YouTube controls container.");
    return null; // Indicate failure to inject properly
}

async function handleRecordButtonClick() {
    if (!recordButton || isTransitioning) return; // Safety check

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

        const videoTitle = document.title.replace(/ - YouTube$/, ''); // Get clean title
        const currentTimeSeconds = Math.floor(videoElement.currentTime);
        const timestamp = new Date(currentTimeSeconds * 1000).toISOString().substr(14, 5); // Format as MM:SS

        try {
            const response = await chrome.runtime.sendMessage({
                action: "startRecording",
                payload: { title: videoTitle, timestamp: timestamp }
            });

            if (!response?.success) {
                throw new Error(response?.message || "Failed to start recording.");
            }

            console.log("YouTube Clip Recorder: Start recording message sent.");
            // Guard: only show STOP UI when the background confirms active recording.
            // If the event message is dropped, fallback to a local state update.
            applyRecordingState();

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

    if (message.type === 'recordingStarted') {
        applyRecordingState();
    }

    if (message.type === 'recordingStopped') {
        resetUIState();
    }

    if (message.type === 'recordingError') {
        console.error('YouTube Clip Recorder: Background recording error.', message.payload?.message || message.payload);
        resetUIState();
    }
});

// --- Initialization and Handling YouTube's Dynamic Loading ---

function initialize() {
    // Check if button already exists (maybe from navigating back/forth)
    if (!document.getElementById('yt-clip-recorder-button')) {
        recordButton = createRecordButton();
        resetUIState();
    } else {
        recordButton = document.getElementById('yt-clip-recorder-button');
        resetUIState();
    }
}

// Observe for changes in the DOM, specifically targeting the player area or URL changes
// YouTube navigation often updates the DOM without a full page load.

// Simple approach: Use setInterval to check if the button needs to be added
// This isn't the most efficient, but easier than complex MutationObservers for now
const checkInterval = setInterval(() => {
    // Check if we are on a watch page and if the button's parent exists
    if (window.location.href.includes("/watch") && document.querySelector('.ytp-right-controls')) {
        initialize();
    } else {
        // If we navigated away from a watch page, ensure recording stops if it was active
        if (isRecording || isTransitioning) {
            console.log("YouTube Clip Recorder: Navigated away, attempting to stop recording if active.");
            chrome.runtime.sendMessage({ action: "stopRecording" }).catch(e => console.log("Error sending stop on navigate away:", e));
            resetUIState();
        }

        // Remove button if it exists but we are not on a watch page anymore
        const existingButton = document.getElementById('yt-clip-recorder-button');
        if (existingButton) {
            existingButton.remove();
            recordButton = null;
        }
    }
}, 1000); // Check every second

// Initial attempt to add the button
initialize();
