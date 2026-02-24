let mediaStream = null;
let mediaRecorder = null;
let recordedBlobs = [];
let captureInfo = { title: "youtube_clip", timestamp: "00:00", includeAudio: false };
let currentMimeType = "video/webm";
let currentFileExtension = "webm";

const VIDEO_MIME_CANDIDATES = [
    { type: 'video/webm;codecs=vp9,opus', extension: 'webm' },
    { type: 'video/webm;codecs=vp8,opus', extension: 'webm' },
    { type: 'video/webm;codecs=vp9', extension: 'webm' },
    { type: 'video/webm;codecs=vp8', extension: 'webm' },
    { type: 'video/webm', extension: 'webm' },
    { type: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', extension: 'mp4' },
    { type: 'video/mp4', extension: 'mp4' },
];

const RECORDING_STARTED_EVENT = "recordingStarted";
const RECORDING_STOPPED_EVENT = "recordingStopped";
const RECORDING_ERROR_EVENT = "recordingError";

function selectSupportedMimeType(includeAudio) {
    const compatibleType = VIDEO_MIME_CANDIDATES.find((candidate) => {
        if (includeAudio && !candidate.type.includes('opus') && !candidate.type.includes('mp4a') && candidate.type.includes('codecs=')) {
            return false;
        }
        return MediaRecorder.isTypeSupported(candidate.type);
    });

    if (compatibleType) {
        return compatibleType;
    }

    return { type: '', extension: 'webm' };
}

function emitRecordingState(type, payload = {}) {
    chrome.runtime.sendMessage({ type, payload }).catch((error) => {
        console.debug(`Background: Unable to emit ${type}.`, error?.message || error);
    });
}

function isRecordingActive() {
    return Boolean(mediaRecorder && mediaRecorder.state === "recording");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        if (message.action === "startRecording") {
            if (isRecordingActive()) {
                console.warn("Background: Recording already in progress.");
                sendResponse({ success: false, message: "Already recording." });
                return;
            }

            console.log("Background: Received startRecording", message.payload);
            captureInfo = message.payload || captureInfo;
            const includeAudio = Boolean(message.payload?.includeAudio);

            try {
                const targetTabId = sender.tab?.id;
                if (!targetTabId) {
                    throw new Error("Could not get sender tab ID.");
                }

                mediaStream = await chrome.tabCapture.capture({
                    audio: includeAudio,
                    video: true,
                    videoConstraints: {
                        mandatory: {
                            minWidth: 1280,
                            minHeight: 720,
                            maxWidth: 1920,
                            maxHeight: 1080,
                            maxFrameRate: 30,
                        },
                    },
                });
                console.log("Background: Tab capture started.");

                if (!mediaStream || mediaStream.getVideoTracks().length === 0) {
                    throw new Error("Failed to get video stream from tabCapture.");
                }

                mediaStream.getVideoTracks().forEach((track) => {
                    track.onended = () => {
                        console.warn("Background: Video track ended unexpectedly.");
                        if (isRecordingActive()) {
                            mediaRecorder.stop();
                        } else {
                            stopCaptureResources();
                            emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "streamEnded" });
                        }
                    };
                });

                recordedBlobs = [];

                const selectedMime = selectSupportedMimeType(includeAudio);
                currentMimeType = selectedMime.type || 'video/webm';
                currentFileExtension = selectedMime.extension;

                if (!selectedMime.type && !MediaRecorder.isTypeSupported('video/webm')) {
                    stopCaptureResources();
                    sendResponse({
                        success: false,
                        message: "This browser/system does not support any compatible recording format. Please update your browser or try another device.",
                    });
                    return;
                }

                const recorderOptions = selectedMime.type ? { mimeType: selectedMime.type } : undefined;
                mediaRecorder = recorderOptions ? new MediaRecorder(mediaStream, recorderOptions) : new MediaRecorder(mediaStream);

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        recordedBlobs.push(event.data);
                        console.log(`Background: Received data chunk, size: ${event.data.size}`);
                    }
                };

                mediaRecorder.onstop = handleRecordingStop;

                mediaRecorder.onerror = (event) => {
                    const errorMessage = event.error?.message || "MediaRecorder error";
                    console.error("Background: MediaRecorder error:", event.error);
                    stopCaptureResources();
                    emitRecordingState(RECORDING_ERROR_EVENT, { message: errorMessage });
                    emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "recorderError" });
                };

                mediaRecorder.start(100);
                console.log("Background: MediaRecorder started.");
                emitRecordingState(RECORDING_STARTED_EVENT, { title: captureInfo.title, timestamp: captureInfo.timestamp });
                sendResponse({ success: true });

            } catch (error) {
                console.error("Background: Error starting tab capture or MediaRecorder:", error);
                stopCaptureResources();
                emitRecordingState(RECORDING_ERROR_EVENT, { message: error.message });
                emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "startFailed" });
                sendResponse({ success: false, message: error.message });
            }

        } else if (message.action === "stopRecording") {
            console.log("Background: Received stopRecording message.");
            if (isRecordingActive()) {
                mediaRecorder.stop();
                sendResponse({ success: true });
            } else {
                console.warn("Background: Stop requested but recorder not active/found.");
                stopCaptureResources();
                emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "alreadyInactive" });
                sendResponse({ success: false, message: "Recorder not active." });
            }
        }
    })();

    return true;
});

function handleRecordingStop() {
    console.log("Background: MediaRecorder stopped.");
    if (recordedBlobs && recordedBlobs.length > 0) {
        const blob = new Blob(recordedBlobs, { type: currentMimeType });

        const safeTitle = captureInfo.title.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 100);
        const timestamp = captureInfo.timestamp || "00:00";
        const audioSuffix = captureInfo.includeAudio ? '_with-audio' : '';
        const filename = `${safeTitle}_clip_${timestamp}${audioSuffix}.${currentFileExtension}`;

        const url = URL.createObjectURL(blob);

        console.log(`Background: Triggering download for ${filename}`);
        chrome.downloads.download({
            url: url,
            filename: filename,
        }).then(downloadId => {
            console.log(`Background: Download started with ID: ${downloadId}`);
        }).catch(error => {
            console.error("Background: Download failed:", error);
            URL.revokeObjectURL(url);
            emitRecordingState(RECORDING_ERROR_EVENT, { message: error.message || "Download failed" });
        });

        recordedBlobs = [];
    } else {
        console.warn("Background: Recording stopped but no data blobs found.");
    }

    stopCaptureResources();
    emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "stopped" });
}

function stopCaptureResources() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
            mediaRecorder.stop();
        } catch (e) {
            console.warn("Error trying to stop recorder during cleanup:", e);
        }
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        console.log("Background: MediaStream tracks stopped.");
    }
    mediaRecorder = null;
    mediaStream = null;
    currentMimeType = "video/webm";
    currentFileExtension = "webm";
    console.log("Background: Capture resources released.");
}

console.log("Background Service Worker started.");
