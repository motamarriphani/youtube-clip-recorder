console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let audioToggle = null;
let isRecording = false;
let stopTimeoutId = null; // Timer to auto-stop recording
const MAX_RECORD_DURATION_MS = 10000; // 10 seconds
const AUDIO_PREF_KEY = 'includeTabAudio';

async function getIncludeAudioPreference() {
    const stored = await chrome.storage.local.get({ [AUDIO_PREF_KEY]: false });
    return Boolean(stored[AUDIO_PREF_KEY]);
}

function createAudioToggle() {
    if (document.getElementById('yt-clip-recorder-audio-toggle')) {
        return document.getElementById('yt-clip-recorder-audio-toggle');
    }

    const label = document.createElement('label');
    label.id = 'yt-clip-recorder-audio-toggle';
    label.className = 'yt-clip-recorder-audio-toggle ytp-button';

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
        const toggle = createAudioToggle();

        // Insert it before the settings button for visibility
        const settingsButton = controlsRight.querySelector('.ytp-settings-button');
        if (settingsButton) {
            controlsRight.insertBefore(toggle, settingsButton);
            controlsRight.insertBefore(button, settingsButton);
        } else {
             // Fallback: append to the end of right controls
             controlsRight.appendChild(toggle);
             controlsRight.appendChild(button);
        }
        audioToggle = toggle;
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
        const includeAudio = Boolean(audioToggle?.querySelector('input')?.checked);

        try {
            // Send message to background script to start
            await chrome.runtime.sendMessage({
                action: "startRecording",
                payload: { title: videoTitle, timestamp: timestamp, includeAudio }
            });
            console.log("YouTube Clip Recorder: Start recording message sent.");

            // Set timeout for automatic stop
            stopTimeoutId = setTimeout(() => {
                console.log("YouTube Clip Recorder: Max duration reached, stopping automatically.");
                handleRecordButtonClick(); // Call this function again to trigger the stop logic
            }, MAX_RECORD_DURATION_MS);

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

async function initialize() {
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

    if (!audioToggle) {
        audioToggle = document.getElementById('yt-clip-recorder-audio-toggle');
    }

    const includeAudio = await getIncludeAudioPreference();
    const checkbox = audioToggle?.querySelector('input');
    if (checkbox) {
        checkbox.checked = includeAudio;
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
        const existingToggle = document.getElementById('yt-clip-recorder-audio-toggle');
        if (existingButton) {
            existingButton.remove();
            recordButton = null;
        }
        if (existingToggle) {
            existingToggle.remove();
            audioToggle = null;
        }
    }
}, 1000); // Check every second

// Initial attempt to add the button
initialize();
