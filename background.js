let mediaStream = null;
let mediaRecorder = null;
let recordedBlobs = [];
let recordingTabId = null;
let captureInfo = { title: "youtube_clip", timestamp: "00:00" }; // Store title/time

const VIDEO_MIME_TYPE = 'video/webm;codecs=vp9'; // VP9 is generally good for web
const pendingClips = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        if (message.action === "startRecording") {
            if (mediaRecorder && mediaRecorder.state !== "inactive") {
                console.warn("Background: Recording already in progress.");
                sendResponse({ success: false, message: "Already recording." });
                return;
            }

            console.log("Background: Received startRecording", message.payload);
            captureInfo = message.payload || captureInfo;

            try {
                const targetTabId = sender.tab?.id;
                if (!targetTabId) {
                    throw new Error("Could not get sender tab ID.");
                }
                recordingTabId = targetTabId;

                mediaStream = await chrome.tabCapture.capture({
                    audio: false,
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

                recordedBlobs = [];

                mediaRecorder = new MediaRecorder(mediaStream, { mimeType: VIDEO_MIME_TYPE });

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        recordedBlobs.push(event.data);
                        console.log(`Background: Received data chunk, size: ${event.data.size}`);
                    }
                };

                mediaRecorder.onstop = () => handleRecordingStop(recordingTabId);

                mediaRecorder.onerror = (event) => {
                    console.error("Background: MediaRecorder error:", event.error);
                    stopCaptureResources();
                };

                mediaRecorder.start(100);
                console.log("Background: MediaRecorder started.");
                sendResponse({ success: true });
            } catch (error) {
                console.error("Background: Error starting tab capture or MediaRecorder:", error);
                stopCaptureResources();
                sendResponse({ success: false, message: error.message });
            }
        } else if (message.action === "stopRecording") {
            console.log("Background: Received stopRecording message.");
            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop();
                sendResponse({ success: true });
            } else {
                console.warn("Background: Stop requested but recorder not active/found.");
                stopCaptureResources();
                sendResponse({ success: false, message: "Recorder not active." });
            }
        } else if (message.action === "saveClip") {
            await saveClip(message.payload);
            sendResponse({ success: true });
        } else if (message.action === "discardClip") {
            discardClip(message.payload?.clipId);
            sendResponse({ success: true });
        }
    })();

    return true;
});

async function handleRecordingStop(targetTabId) {
    console.log("Background: MediaRecorder stopped.");

    if (!recordedBlobs || recordedBlobs.length === 0) {
        console.warn("Background: No recorded data available.");
        stopCaptureResources();
        return;
    }

    const blob = new Blob(recordedBlobs, { type: VIDEO_MIME_TYPE });
    const safeTitle = captureInfo.title.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 100);
    const timestamp = captureInfo.timestamp || "00:00";
    const filename = `${safeTitle}_clip_${timestamp}.webm`;
    const url = URL.createObjectURL(blob);
    const clipId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    pendingClips.set(clipId, { url, filename });

    try {
        if (typeof targetTabId === "number") {
            await chrome.tabs.sendMessage(targetTabId, {
                action: "clipReadyForPreview",
                payload: {
                    clipId,
                    url,
                    filename,
                    title: captureInfo.title,
                    timestamp,
                },
            });
            console.log(`Background: Clip preview sent for ${filename}`);
        }
    } catch (error) {
        console.error("Background: Failed to show preview, revoking clip.", error);
        discardClip(clipId);
    } finally {
        stopCaptureResources();
        recordingTabId = null;
    }
}

async function saveClip(payload = {}) {
    const { clipId, saveAs = false } = payload;
    const clip = pendingClips.get(clipId);
    if (!clip) {
        console.warn("Background: saveClip requested for missing clip", clipId);
        return;
    }

    try {
        const downloadId = await chrome.downloads.download({
            url: clip.url,
            filename: clip.filename,
            saveAs,
        });
        console.log(`Background: Download started with ID: ${downloadId}`);
    } catch (error) {
        console.error("Background: Failed to download clip", error);
        throw error;
    } finally {
        setTimeout(() => discardClip(clipId), 30000);
    }
}

function discardClip(clipId) {
    if (!clipId) return;
    const clip = pendingClips.get(clipId);
    if (!clip) return;

    URL.revokeObjectURL(clip.url);
    pendingClips.delete(clipId);
    console.log(`Background: Revoked clip URL for ${clipId}`);
}

function stopCaptureResources() {
    if (mediaRecorder) {
        mediaRecorder.onstop = null;
        mediaRecorder.ondataavailable = null;
        mediaRecorder.onerror = null;
        mediaRecorder = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach((track) => {
            if (track.readyState === "live") {
                track.stop();
                console.log(`Background: Stopped track: ${track.kind}`);
            }
        });
        mediaStream = null;
    }

    recordedBlobs = [];
}
