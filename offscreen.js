let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentMimeType = "video/webm";
let currentFileExtension = "webm";
let completionSent = false;
let monitorIntervalId = null;

const OFFSCREEN_RECORDING_TARGET = "offscreen";
const OFFSCREEN_START_RECORDING = "start-recording";
const OFFSCREEN_STOP_RECORDING = "stop-recording";
const TRACK_MONITOR_INTERVAL_MS = 500;

const VIDEO_MIME_CANDIDATES = [
    { type: "video/webm;codecs=vp9,opus", extension: "webm" },
    { type: "video/webm;codecs=vp8,opus", extension: "webm" },
    { type: "video/webm;codecs=vp9", extension: "webm" },
    { type: "video/webm;codecs=vp8", extension: "webm" },
    { type: "video/webm", extension: "webm" },
    { type: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
    { type: "video/mp4", extension: "mp4" },
];

function selectSupportedMimeType(includeAudio) {
    const compatibleType = VIDEO_MIME_CANDIDATES.find((candidate) => {
        if (
            includeAudio
            && candidate.type.includes("codecs=")
            && !candidate.type.includes("opus")
            && !candidate.type.includes("mp4a")
        ) {
            return false;
        }

        return MediaRecorder.isTypeSupported(candidate.type);
    });

    if (compatibleType) {
        return compatibleType;
    }

    return { type: "", extension: "webm" };
}

function stopTrackMonitor() {
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        monitorIntervalId = null;
    }
}

function startTrackMonitor() {
    stopTrackMonitor();
    monitorIntervalId = setInterval(() => {
        if (!mediaStream) {
            return;
        }

        const videoTrack = mediaStream.getVideoTracks()[0];
        if (!videoTrack) {
            stopTrackMonitor();
            emitRecordingError("Video track ended unexpectedly.").catch((error) => {
                console.warn("Offscreen: Failed to emit missing track error.", error);
            });
            return;
        }

        if (videoTrack.readyState !== "live") {
            stopTrackMonitor();
            if (mediaRecorder?.state === "recording") {
                mediaRecorder.stop();
            } else {
                emitRecordingError("Video track ended unexpectedly.").catch((error) => {
                    console.warn("Offscreen: Failed to emit ended track error.", error);
                });
            }
        }
    }, TRACK_MONITOR_INTERVAL_MS);
}

function cleanupCaptureResources() {
    stopTrackMonitor();

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
            }
        });
        mediaStream = null;
    }

    recordedChunks = [];
    currentMimeType = "video/webm";
    currentFileExtension = "webm";
}

async function notifyBackground(action, payload = {}) {
    try {
        await chrome.runtime.sendMessage({ action, payload });
    } catch (error) {
        console.warn(`Offscreen: Failed to notify background for ${action}.`, error);
    }
}

function buildStreamConstraints(streamId, includeAudio) {
    return {
        audio: includeAudio
            ? {
                mandatory: {
                    chromeMediaSource: "tab",
                    chromeMediaSourceId: streamId,
                },
            }
            : false,
        video: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId,
                minWidth: 1280,
                minHeight: 720,
                maxWidth: 1920,
                maxHeight: 1080,
                maxFrameRate: 30,
            },
        },
    };
}

async function emitRecordingComplete() {
    if (completionSent) {
        return;
    }

    completionSent = true;

    const blob = recordedChunks.length > 0
        ? new Blob(recordedChunks, { type: currentMimeType || "video/webm" })
        : null;

    await notifyBackground("offscreenRecordingComplete", {
        blob,
        mimeType: currentMimeType,
        fileExtension: currentFileExtension,
    });

    cleanupCaptureResources();
}

async function emitRecordingError(message) {
    if (completionSent) {
        return;
    }

    completionSent = true;
    await notifyBackground("offscreenRecordingError", { message });
    cleanupCaptureResources();
}

async function startRecording(payload = {}) {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        return { success: false, message: "Already recording." };
    }

    const streamId = payload.streamId;
    if (!streamId) {
        return { success: false, message: "Missing tab capture stream ID." };
    }

    const includeAudio = Boolean(payload.includeAudio);
    const selectedMime = selectSupportedMimeType(includeAudio);
    if (!selectedMime.type && !MediaRecorder.isTypeSupported("video/webm")) {
        return {
            success: false,
            message: "This browser/system does not support any compatible recording format. Please update your browser or try another device.",
        };
    }

    const recorderOptions = selectedMime.type ? { mimeType: selectedMime.type } : undefined;

    recordedChunks = [];
    currentMimeType = selectedMime.type || "video/webm";
    currentFileExtension = selectedMime.extension;
    completionSent = false;

    try {
        mediaStream = await navigator.mediaDevices.getUserMedia(buildStreamConstraints(streamId, includeAudio));
    } catch (error) {
        cleanupCaptureResources();
        return { success: false, message: error?.message || "Failed to get media stream." };
    }

    if (!mediaStream || mediaStream.getVideoTracks().length === 0) {
        cleanupCaptureResources();
        return { success: false, message: "Failed to get video stream from tab capture." };
    }

    mediaRecorder = recorderOptions
        ? new MediaRecorder(mediaStream, recorderOptions)
        : new MediaRecorder(mediaStream);

    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    mediaRecorder.onerror = (event) => {
        const errorMessage = event.error?.message || "MediaRecorder error";
        emitRecordingError(errorMessage).catch((error) => {
            console.warn("Offscreen: Failed to handle recorder error.", error);
        });
    };

    mediaRecorder.onstop = () => {
        emitRecordingComplete().catch((error) => {
            console.warn("Offscreen: Failed to emit recording completion.", error);
        });
    };

    mediaStream.getVideoTracks().forEach((track) => {
        track.onended = () => {
            if (mediaRecorder?.state === "recording") {
                mediaRecorder.stop();
                return;
            }

            emitRecordingError("Video track ended unexpectedly.").catch((error) => {
                console.warn("Offscreen: Failed to emit track ended error.", error);
            });
        };
    });

    mediaRecorder.start(100);
    startTrackMonitor();

    return {
        success: true,
        mimeType: currentMimeType,
        fileExtension: currentFileExtension,
    };
}

async function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
        return { success: false, message: "Recorder not active." };
    }

    mediaRecorder.stop();
    return { success: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== OFFSCREEN_RECORDING_TARGET) {
        return false;
    }

    (async () => {
        if (message.type === OFFSCREEN_START_RECORDING) {
            sendResponse(await startRecording(message.payload));
            return;
        }

        if (message.type === OFFSCREEN_STOP_RECORDING) {
            sendResponse(await stopRecording());
            return;
        }

        sendResponse({ success: false, message: `Unsupported offscreen message type: ${message.type}` });
    })().catch((error) => {
        sendResponse({ success: false, message: error.message || "Unhandled offscreen error." });
    });

    return true;
});

console.log("Offscreen recorder document initialized.");
