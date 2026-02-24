console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let isRecording = false;
let stopTimeoutId = null;
let activePreviewClipId = null;
let previewModalEl = null;
const MAX_RECORD_DURATION_MS = 10000;

function createRecordButton() {
    if (document.getElementById('yt-clip-recorder-button')) {
        return document.getElementById('yt-clip-recorder-button');
    }

    const button = document.createElement('button');
    button.id = 'yt-clip-recorder-button';
    button.textContent = 'REC Clip';
    button.classList.add('ytp-button');
    button.style.marginLeft = '8px';
    button.style.fontSize = '0.9em';
    button.style.padding = '5px 8px';

    button.onclick = handleRecordButtonClick;

    const controlsRight = document.querySelector('.ytp-right-controls');
    if (controlsRight) {
        const settingsButton = controlsRight.querySelector('.ytp-settings-button');
        if (settingsButton) {
            controlsRight.insertBefore(button, settingsButton);
        } else {
            controlsRight.appendChild(button);
        }
        console.log("YouTube Clip Recorder: Button injected.");
        return button;
    }

    console.warn("YouTube Clip Recorder: Could not find YouTube controls container.");
    return null;
}

async function handleRecordButtonClick() {
    if (!recordButton) return;

    const videoElement = document.querySelector('video.html5-main-video');
    if (!videoElement) {
        console.error("YouTube Clip Recorder: Video element not found.");
        alert("Could not find the YouTube video element.");
        return;
    }

    if (!isRecording) {
        isRecording = true;
        recordButton.textContent = 'STOP ■';
        recordButton.style.color = 'red';

        const videoTitle = document.title.replace(/ - YouTube$/, '');
        const currentTimeSeconds = Math.floor(videoElement.currentTime);
        const timestamp = new Date(currentTimeSeconds * 1000).toISOString().substr(14, 5);

        try {
            await chrome.runtime.sendMessage({
                action: "startRecording",
                payload: { title: videoTitle, timestamp },
            });
            console.log("YouTube Clip Recorder: Start recording message sent.");

            stopTimeoutId = setTimeout(() => {
                console.log("YouTube Clip Recorder: Max duration reached, stopping automatically.");
                handleRecordButtonClick();
            }, MAX_RECORD_DURATION_MS);
        } catch (error) {
            console.error("YouTube Clip Recorder: Error starting recording.", error);
            alert(`Error starting recording: ${error.message}`);
            isRecording = false;
            recordButton.textContent = 'REC Clip';
            recordButton.style.color = '';
            clearTimeout(stopTimeoutId);
            stopTimeoutId = null;
        }
    } else {
        isRecording = false;
        recordButton.textContent = 'REC Clip';
        recordButton.style.color = '';

        if (stopTimeoutId) {
            clearTimeout(stopTimeoutId);
            stopTimeoutId = null;
        }

        try {
            await chrome.runtime.sendMessage({ action: "stopRecording" });
            console.log("YouTube Clip Recorder: Stop recording message sent.");
            recordButton.disabled = true;
            setTimeout(() => { recordButton.disabled = false; }, 1000);
        } catch (error) {
            console.error("YouTube Clip Recorder: Error stopping recording.", error);
            alert(`Error stopping recording: ${error.message}`);
        }
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
    if (message.action === 'clipReadyForPreview') {
        showPreviewModal(message.payload);
    }
});

window.addEventListener('beforeunload', cleanupPreviewOnUnload);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        cleanupPreviewOnUnload();
    }
});

function initialize() {
    if (!document.getElementById('yt-clip-recorder-button')) {
        recordButton = createRecordButton();
        isRecording = false;
    } else {
        recordButton = document.getElementById('yt-clip-recorder-button');
        if (recordButton.textContent !== 'REC Clip') {
            recordButton.textContent = 'REC Clip';
            recordButton.style.color = '';
            isRecording = false;
        }
    }
}

const checkInterval = setInterval(() => {
    if (window.location.href.includes("/watch") && document.querySelector('.ytp-right-controls')) {
        initialize();
    } else {
        if (isRecording) {
            console.log("YouTube Clip Recorder: Navigated away, attempting to stop recording if active.");
            chrome.runtime.sendMessage({ action: "stopRecording" }).catch((e) => console.log("Error sending stop on navigate away:", e));
            isRecording = false;
            if (recordButton) {
                recordButton.textContent = 'REC Clip';
                recordButton.style.color = '';
            }
            if (stopTimeoutId) clearTimeout(stopTimeoutId);
        }
        const existingButton = document.getElementById('yt-clip-recorder-button');
        if (existingButton) {
            existingButton.remove();
            recordButton = null;
        }
    }
}, 1000);

initialize();
