let mediaStream = null;
let mediaRecorder = null;
let recordedBlobs = [];
let captureInfo = { title: "youtube_clip", timestamp: "00:00" }; // Store title/time
let selectedVideoMimeType = null;

const VIDEO_MIME_CANDIDATES = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
];
const RECORDING_STARTED_EVENT = "recordingStarted";
const RECORDING_STOPPED_EVENT = "recordingStopped";
const RECORDING_ERROR_EVENT = "recordingError";

function selectSupportedMimeType() {
    const supportedType = VIDEO_MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
    if (supportedType) {
        console.log(`Background: Using recording MIME type: ${supportedType}`);
        return supportedType;
    }

    console.error(`Background: No supported MIME types found. Candidates: ${VIDEO_MIME_CANDIDATES.join(', ')}`);
    return null;
}

function getExtensionFromMimeType(mimeType) {
    if (mimeType && mimeType.includes('webm')) {
        return 'webm';
    }

    return 'webm';
}

function emitRecordingState(type, payload = {}) {
    chrome.runtime.sendMessage({ type, payload }).catch((error) => {
        // Ignore if there are no listeners in some extension contexts.
        console.debug(`Background: Unable to emit ${type}.`, error?.message || error);
    });
}

function isRecordingActive() {
    return Boolean(mediaRecorder && mediaRecorder.state === "recording");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Use an async function here to allow 'await' and properly handle promises/sendResponse
    (async () => {
        if (message.action === "startRecording") {
            if (isRecordingActive()) {
                console.warn("Background: Recording already in progress.");
                sendResponse({ success: false, message: "Already recording." });
                return; // Indicate message handled (implicitly)
            }

            console.log("Background: Received startRecording", message.payload);
            captureInfo = message.payload || captureInfo; // Store title/time

            try {
                // Important: Get the tab where the message came from
                const targetTabId = sender.tab?.id;
                if (!targetTabId) {
                    throw new Error("Could not get sender tab ID.");
                }

                // Start tab capture
                mediaStream = await chrome.tabCapture.capture({
                    audio: false, // No audio as requested
                    video: true,
                    videoConstraints: {
                        mandatory: {
                            // Request desired quality, browser will do its best
                            minWidth: 1280,
                            minHeight: 720,
                            maxWidth: 1920,
                            maxHeight: 1080,
                            maxFrameRate: 30, // Capture at 30fps
                        },
                    },
                });
                console.log("Background: Tab capture started.");

                // Check if stream is valid
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

                // Clear previous blobs
                recordedBlobs = [];

                selectedVideoMimeType = selectSupportedMimeType();
                if (!selectedVideoMimeType) {
                    stopCaptureResources();
                    sendResponse({
                        success: false,
                        message: "This browser/system does not support any compatible recording format (VP9/VP8/WebM). Please update your browser or try another device.",
                    });
                    return;
                }

                // Create MediaRecorder
                mediaRecorder = new MediaRecorder(mediaStream, { mimeType: selectedVideoMimeType });

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        recordedBlobs.push(event.data);
                        console.log(`Background: Received data chunk, size: ${event.data.size}`);
                    }
                };

                mediaRecorder.onstop = handleRecordingStop; // Assign the stop handler

                mediaRecorder.onerror = (event) => {
                    const errorMessage = event.error?.message || "MediaRecorder error";
                    console.error("Background: MediaRecorder error:", event.error);
                    // Clean up resources on error too
                    stopCaptureResources();
                    emitRecordingState(RECORDING_ERROR_EVENT, { message: errorMessage });
                    emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "recorderError" });
                };

                // Start recording
                mediaRecorder.start(100); // Collect data in chunks (e.g., every 100ms)
                console.log("Background: MediaRecorder started.");
                emitRecordingState(RECORDING_STARTED_EVENT, { title: captureInfo.title, timestamp: captureInfo.timestamp });
                sendResponse({ success: true }); // Signal success back to content script

            } catch (error) {
                console.error("Background: Error starting tab capture or MediaRecorder:", error);
                stopCaptureResources(); // Clean up if error occurs during setup
                emitRecordingState(RECORDING_ERROR_EVENT, { message: error.message });
                emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "startFailed" });
                sendResponse({ success: false, message: error.message });
            }

        } else if (message.action === "stopRecording") {
            console.log("Background: Received stopRecording message.");
            if (isRecordingActive()) {
                mediaRecorder.stop(); // This will trigger the 'onstop' event handler
                // stopCaptureResources() is called within handleRecordingStop after blobs are processed
                sendResponse({ success: true });
            } else {
                console.warn("Background: Stop requested but recorder not active/found.");
                // Still try to clean up just in case stream exists without recorder
                stopCaptureResources();
                emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "alreadyInactive" });
                sendResponse({ success: false, message: "Recorder not active." });
            }
        }
    })(); // Immediately invoke the async function

    // Return true to indicate you wish to send a response asynchronously
    return true;
});

function handleRecordingStop() {
    console.log("Background: MediaRecorder stopped.");
    if (recordedBlobs && recordedBlobs.length > 0) {
        const blobMimeType = selectedVideoMimeType || 'video/webm';
        const blob = new Blob(recordedBlobs, { type: blobMimeType });
        const extension = getExtensionFromMimeType(blobMimeType);
        console.log(`Background: Finalizing blob with MIME type: ${blobMimeType}`);

        // Sanitize filename
        const safeTitle = captureInfo.title.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 100); // Limit length too
        const timestamp = captureInfo.timestamp || "00:00";
        const filename = `${safeTitle}_clip_${timestamp}.${extension}`;

        const url = URL.createObjectURL(blob);

        console.log(`Background: Triggering download for ${filename}`);
        chrome.downloads.download({
            url: url,
            filename: filename,
            // saveAs: true // Uncomment to prompt user for save location each time
        }).then(downloadId => {
            console.log(`Background: Download started with ID: ${downloadId}`);
            // Note: Can't easily revokeObjectURL here directly as download is async.
            // Browser usually handles cleanup, but for long-running extensions, management might be needed.
            // setTimeout(() => URL.revokeObjectURL(url), 60000); // Revoke after 1 min as fallback
        }).catch(error => {
            console.error("Background: Download failed:", error);
            URL.revokeObjectURL(url); // Clean up if download initiation failed
            emitRecordingState(RECORDING_ERROR_EVENT, { message: error.message || "Download failed" });
        });

        // Clear blobs after processing
        recordedBlobs = [];
    } else {
        console.warn("Background: Recording stopped but no data blobs found.");
    }

    // Clean up stream/recorder resources AFTER processing blobs
    stopCaptureResources();
    emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "stopped" });
}

function stopCaptureResources() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        // If somehow stop wasn't called cleanly, try again.
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
    selectedVideoMimeType = null;
    console.log("Background: Capture resources released.");
}

console.log("Background Service Worker started.");
