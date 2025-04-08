let mediaStream = null;
let mediaRecorder = null;
let recordedBlobs = [];
let captureInfo = { title: "youtube_clip", timestamp: "00:00" }; // Store title/time

const VIDEO_MIME_TYPE = 'video/webm;codecs=vp9'; // VP9 is generally good for web
// const VIDEO_MIME_TYPE = 'video/mp4;codecs=h264'; // Alternative, might have less browser support for recording

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Use an async function here to allow 'await' and properly handle promises/sendResponse
    (async () => {
        if (message.action === "startRecording") {
            if (mediaRecorder && mediaRecorder.state !== "inactive") {
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

                // Clear previous blobs
                recordedBlobs = [];

                // Create MediaRecorder
                 mediaRecorder = new MediaRecorder(mediaStream, { mimeType: VIDEO_MIME_TYPE });

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        recordedBlobs.push(event.data);
                        console.log(`Background: Received data chunk, size: ${event.data.size}`);
                    }
                };

                mediaRecorder.onstop = handleRecordingStop; // Assign the stop handler

                mediaRecorder.onerror = (event) => {
                    console.error("Background: MediaRecorder error:", event.error);
                    // Clean up resources on error too
                    stopCaptureResources();
                };

                // Start recording
                mediaRecorder.start(100); // Collect data in chunks (e.g., every 100ms)
                console.log("Background: MediaRecorder started.");
                sendResponse({ success: true }); // Signal success back to content script

            } catch (error) {
                console.error("Background: Error starting tab capture or MediaRecorder:", error);
                stopCaptureResources(); // Clean up if error occurs during setup
                 sendResponse({ success: false, message: error.message });
            }

        } else if (message.action === "stopRecording") {
             console.log("Background: Received stopRecording message.");
             if (mediaRecorder && mediaRecorder.state === "recording") {
                 mediaRecorder.stop(); // This will trigger the 'onstop' event handler
                 // stopCaptureResources() is called within handleRecordingStop after blobs are processed
                 sendResponse({ success: true });
             } else {
                 console.warn("Background: Stop requested but recorder not active/found.");
                 // Still try to clean up just in case stream exists without recorder
                 stopCaptureResources();
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
        const blob = new Blob(recordedBlobs, { type: VIDEO_MIME_TYPE });

        // Sanitize filename
        const safeTitle = captureInfo.title.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 100); // Limit length too
        const timestamp = captureInfo.timestamp || "00:00";
        const filename = `${safeTitle}_clip_${timestamp}.webm`; // Use .webm extension

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
        });

        // Clear blobs after processing
         recordedBlobs = [];
    } else {
        console.warn("Background: Recording stopped but no data blobs found.");
    }

    // Clean up stream/recorder resources AFTER processing blobs
    stopCaptureResources();
}

function stopCaptureResources() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        // If somehow stop wasn't called cleanly, try again.
        try { mediaRecorder.stop(); } catch (e) { console.warn("Error trying to stop recorder during cleanup:", e); }
    }
     if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        console.log("Background: MediaStream tracks stopped.");
    }
    mediaRecorder = null;
    mediaStream = null;
    console.log("Background: Capture resources released.");
}

// Add listeners for tab updates/removal to stop recording if the target tab changes/closes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check if the tab being updated is the one we are capturing
    // And if the URL significantly changed (navigated away) or it's loading
    if (mediaRecorder && mediaRecorder.state === "recording") {
         const capturingTabId = mediaRecorder?.stream?.getVideoTracks()[0]?.getSettings()?.displaySurface?.tabId;
         // Note: reliably getting tab ID from stream isn't straightforward, might need to store it separately when starting
         // Let's rely on stopping via content script's interval checker for now, or handle tab removal.
    }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    // Check if the closed tab is the one being recorded
    // Requires storing targetTabId when starting capture
    // if (tabId === storedTargetTabId && mediaRecorder && mediaRecorder.state === "recording") {
    //    console.log(`Background: Target tab ${tabId} closed, stopping recording.`);
    //    mediaRecorder.stop(); // Trigger stop and cleanup
    // }
    // Simplified: For now, assume content script handles navigation away,
    // and if the whole browser closes, things stop anyway.
});

console.log("Background Service Worker started.");
