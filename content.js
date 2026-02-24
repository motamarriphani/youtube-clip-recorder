console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let isRecording = false;
let stopTimeoutId = null; // Timer to auto-stop recording

const DEFAULT_MAX_RECORD_DURATION_MS = 10000; // 10 seconds fallback
const MIN_RECORD_DURATION_SECONDS = 3;
const MAX_RECORD_DURATION_SECONDS = 60;
const STORAGE_KEY_MAX_DURATION_SECONDS = 'maxRecordDurationSeconds';

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
    } else {
        console.warn("YouTube Clip Recorder: Could not find YouTube controls container.");
        // Fallback: Append to body (less ideal)
        // button.style.position = 'fixed';
        // button.style.bottom = '20px';
        // button.style.right = '20px';
        // button.style.zIndex = '9999';
        // document.body.appendChild(button);
        return null; // Indicate failure to inject properly
    }
}

async function handleRecordButtonClick() {
    if (!recordButton) return; // Safety check

    const videoElement = document.querySelector('video.html5-main-video');
    if (!videoElement) {
        console.error("YouTube Clip Recorder: Video element not found.");
        alert("Could not find the YouTube video element.");
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
                action: "startRecording",
                payload: { title: videoTitle, timestamp: timestamp }
            });
            console.log("YouTube Clip Recorder: Start recording message sent.");

            // Set timeout for automatic stop
            const maxRecordDurationMs = await getMaxRecordDurationMs();
            stopTimeoutId = setTimeout(() => {
                console.log("YouTube Clip Recorder: Max duration reached, stopping automatically.");
                handleRecordButtonClick(); // Call this function again to trigger the stop logic
            }, maxRecordDurationMs);

        } catch (error) {
            console.error("YouTube Clip Recorder: Error starting recording.", error);
            alert(`Error starting recording: ${error.message}`);
            // Reset UI if start failed
            isRecording = false;
            recordButton.textContent = 'REC Clip';
            recordButton.style.color = ''; // Reset color
            clearTimeout(stopTimeoutId);
            stopTimeoutId = null;
        }

    } else {
        // --- Stop Recording ---
        isRecording = false;
        recordButton.textContent = 'REC Clip'; // Reset text immediately
        recordButton.style.color = ''; // Reset color

        // Clear the automatic stop timer
        if (stopTimeoutId) {
            clearTimeout(stopTimeoutId);
            stopTimeoutId = null;
        }

        try {
            // Send message to background script to stop
            await chrome.runtime.sendMessage({ action: "stopRecording" });
            console.log("YouTube Clip Recorder: Stop recording message sent.");
            // Optional: Maybe disable button briefly while saving?
            recordButton.disabled = true;
            setTimeout(() => { recordButton.disabled = false; }, 1000); // Re-enable after a short delay

        } catch (error) {
            console.error("YouTube Clip Recorder: Error stopping recording.", error);
            alert(`Error stopping recording: ${error.message}`);
            // UI is already reset, maybe just log error
        }
    }
}

// --- Initialization and Handling YouTube's Dynamic Loading ---

function initialize() {
    // Check if button already exists (maybe from navigating back/forth)
    if (!document.getElementById('yt-clip-recorder-button')) {
        recordButton = createRecordButton();
        isRecording = false; // Ensure state is reset on init
    } else {
         recordButton = document.getElementById('yt-clip-recorder-button');
         // Make sure state reflects reality if user navigated away while recording was pending
         // (A more robust solution might query background script for state)
         if (recordButton.textContent !== 'REC Clip') {
             recordButton.textContent = 'REC Clip';
             recordButton.style.color = '';
             isRecording = false;
         }
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
        // (This check might be redundant if background handles tab closure/update, but good for safety)
        if (isRecording) {
           console.log("YouTube Clip Recorder: Navigated away, attempting to stop recording if active.");
           chrome.runtime.sendMessage({ action: "stopRecording" }).catch(e => console.log("Error sending stop on navigate away:", e));
           isRecording = false;
           if(recordButton) {
               recordButton.textContent = 'REC Clip';
               recordButton.style.color = '';
           }
           if(stopTimeoutId) clearTimeout(stopTimeoutId);
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
