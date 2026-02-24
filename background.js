let recordingTabId = null;
let isRecording = false;
let captureInfo = { title: "youtube_clip", timestamp: "00:00", includeAudio: false };
let currentMimeType = "video/webm";
let currentFileExtension = "webm";

const RECORDING_STARTED_EVENT = "recordingStarted";
const RECORDING_STOPPED_EVENT = "recordingStopped";
const RECORDING_ERROR_EVENT = "recordingError";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_RECORDING_TARGET = "offscreen";
const OFFSCREEN_START_RECORDING = "start-recording";
const OFFSCREEN_STOP_RECORDING = "stop-recording";
const CLIP_URL_REVOKE_DELAY_MS = 30000;
const PERSISTED_CLIP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PENDING_CLIPS_DB_NAME = "ytClipRecorder";
const PENDING_CLIPS_DB_VERSION = 1;
const PENDING_CLIPS_STORE_NAME = "pendingClips";

const pendingClips = new Map();

function openPendingClipsDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(PENDING_CLIPS_DB_NAME, PENDING_CLIPS_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PENDING_CLIPS_STORE_NAME)) {
                db.createObjectStore(PENDING_CLIPS_STORE_NAME, { keyPath: "clipId" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open pending clip store."));
    });
}

async function persistPendingClip({ clipId, blob, filename, createdAt }) {
    const db = await openPendingClipsDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(PENDING_CLIPS_STORE_NAME, "readwrite");
        transaction.objectStore(PENDING_CLIPS_STORE_NAME).put({
            clipId,
            blob,
            filename,
            createdAt,
        });
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error || new Error("Failed to persist pending clip."));
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error || new Error("Pending clip persistence aborted."));
        };
    });
}

async function loadPersistedPendingClip(clipId) {
    const db = await openPendingClipsDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(PENDING_CLIPS_STORE_NAME, "readonly");
        const request = transaction.objectStore(PENDING_CLIPS_STORE_NAME).get(clipId);
        let result = null;

        request.onsuccess = () => {
            result = request.result || null;
        };
        request.onerror = () => {
            db.close();
            reject(request.error || new Error("Failed to read pending clip."));
        };
        transaction.oncomplete = () => {
            db.close();
            resolve(result);
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error || new Error("Failed to complete pending clip read."));
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error || new Error("Pending clip read aborted."));
        };
    });
}

async function deletePersistedPendingClip(clipId) {
    const db = await openPendingClipsDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(PENDING_CLIPS_STORE_NAME, "readwrite");
        transaction.objectStore(PENDING_CLIPS_STORE_NAME).delete(clipId);
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error || new Error("Failed to delete pending clip."));
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error || new Error("Pending clip deletion aborted."));
        };
    });
}

async function prunePersistedPendingClips(maxAgeMs = PERSISTED_CLIP_MAX_AGE_MS) {
    const cutoff = Date.now() - maxAgeMs;
    const db = await openPendingClipsDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(PENDING_CLIPS_STORE_NAME, "readwrite");
        const store = transaction.objectStore(PENDING_CLIPS_STORE_NAME);
        const cursorRequest = store.openCursor();

        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
                return;
            }

            const record = cursor.value;
            if (!record?.createdAt || record.createdAt < cutoff) {
                cursor.delete();
            }
            cursor.continue();
        };
        cursorRequest.onerror = () => {
            db.close();
            reject(cursorRequest.error || new Error("Failed to prune pending clips."));
        };
        transaction.oncomplete = () => {
            db.close();
            resolve();
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error || new Error("Pending clip prune failed."));
        };
        transaction.onabort = () => {
            db.close();
            reject(transaction.error || new Error("Pending clip prune aborted."));
        };
    });
}

function sanitizeFilenamePart(value, fallback) {
    const sanitized = String(value || "")
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
        .replace(/\s+/g, " ")
        .trim();

    return sanitized || fallback;
}

async function getPendingClip(clipId) {
    const inMemoryClip = pendingClips.get(clipId);
    if (inMemoryClip) {
        return inMemoryClip;
    }

    const persistedClip = await loadPersistedPendingClip(clipId);
    if (!persistedClip) {
        return null;
    }

    const restoredClip = {
        filename: persistedClip.filename,
        blob: persistedClip.blob,
        previewUrl: null,
        createdAt: persistedClip.createdAt || Date.now(),
    };
    pendingClips.set(clipId, restoredClip);
    return restoredClip;
}

function scheduleClipCleanup(clipId, delayMs = CLIP_URL_REVOKE_DELAY_MS) {
    setTimeout(() => {
        discardClip(clipId).catch((error) => {
            console.warn(`Background: Failed to cleanup clip ${clipId}.`, error);
        });
    }, delayMs);
}

function emitRecordingState(type, payload = {}) {
    chrome.runtime.sendMessage({ type, payload }).catch((error) => {
        console.debug(`Background: Unable to emit ${type}.`, error?.message || error);
    });
}

function normalizeStartRecordingError(error) {
    const rawMessage = String(error?.message || error || "Unknown recording error.");
    const lower = rawMessage.toLowerCase();

    if (lower.includes("not been invoked for the current page")) {
        return "Capture permission is not active for this tab yet. Click the extension icon once on this YouTube tab, close the popup, then try REC Clip again.";
    }

    if (lower.includes("chrome pages cannot be captured")) {
        return "This page cannot be captured. Open a normal YouTube watch page (not chrome:// or extension pages) and try again.";
    }

    return rawMessage;
}

function isRecordingActive() {
    return isRecording;
}

function resetRecordingRuntimeState() {
    isRecording = false;
    recordingTabId = null;
    currentMimeType = "video/webm";
    currentFileExtension = "webm";
}

async function ensureOffscreenDocument() {
    if (!chrome.offscreen) {
        throw new Error("Offscreen API is unavailable. Please update Chrome to 116+.");
    }

    const createParams = {
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["USER_MEDIA"],
        justification: "Record YouTube clips using tab capture stream IDs.",
    };

    if (!chrome.runtime.getContexts) {
        await chrome.offscreen.createDocument(createParams);
        return;
    }

    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
    });

    if (contexts.length === 0) {
        await chrome.offscreen.createDocument(createParams);
    }
}

async function closeOffscreenDocumentIfPresent() {
    if (!chrome.offscreen || !chrome.runtime.getContexts) {
        return;
    }

    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
    });

    if (contexts.length > 0) {
        await chrome.offscreen.closeDocument();
    }
}

async function sendOffscreenMessage(type, payload = {}) {
    await ensureOffscreenDocument();
    return chrome.runtime.sendMessage({
        target: OFFSCREEN_RECORDING_TARGET,
        type,
        payload,
    });
}

async function startOffscreenRecording(targetTabId, includeAudio) {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });

    const response = await sendOffscreenMessage(OFFSCREEN_START_RECORDING, {
        streamId,
        includeAudio,
    });

    if (!response?.success) {
        throw new Error(response?.message || "Failed to start offscreen recorder.");
    }

    currentMimeType = response.mimeType || "video/webm";
    currentFileExtension = response.fileExtension || "webm";
}

async function stopOffscreenRecording() {
    const response = await sendOffscreenMessage(OFFSCREEN_STOP_RECORDING);
    if (!response?.success) {
        throw new Error(response?.message || "Failed to stop offscreen recorder.");
    }
}

async function handleRecordingStop(targetTabId, recordingResult = {}) {
    const blob = recordingResult.blob;
    const mimeType = recordingResult.mimeType || currentMimeType || "video/webm";
    const fileExtension = recordingResult.fileExtension || currentFileExtension || "webm";

    if (!blob || blob.size === 0) {
        console.warn("Background: No recorded data available.");
        emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "noData" });
        return;
    }

    const safeTitle = sanitizeFilenamePart(captureInfo.title, "youtube_clip").substring(0, 100);
    const timestamp = captureInfo.timestamp || "00:00";
    const safeTimestamp = sanitizeFilenamePart(timestamp, "00_00");
    const audioSuffix = captureInfo.includeAudio ? "_with-audio" : "";
    const filename = `${safeTitle}_clip_${safeTimestamp}${audioSuffix}.${fileExtension}`;
    const previewUrl = URL.createObjectURL(blob);
    const clipId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();

    pendingClips.set(clipId, {
        filename,
        blob,
        previewUrl,
        createdAt,
        mimeType,
    });

    try {
        await persistPendingClip({ clipId, blob, filename, createdAt });
    } catch (error) {
        console.warn("Background: Failed to persist clip for service worker restore.", error);
    }

    try {
        if (typeof targetTabId === "number") {
            await chrome.tabs.sendMessage(targetTabId, {
                action: "clipReadyForPreview",
                payload: {
                    clipId,
                    url: previewUrl,
                    filename,
                    title: captureInfo.title,
                    timestamp,
                },
            });
            console.log(`Background: Clip preview sent for ${filename}`);
        } else {
            await saveClip({ clipId, saveAs: false });
        }
    } catch (error) {
        console.error("Background: Failed to show preview, falling back to auto-download.", error);
        await saveClip({ clipId, saveAs: false });
    }
}

async function handleOffscreenRecordingComplete(payload = {}) {
    const targetTabId = recordingTabId;

    try {
        await handleRecordingStop(targetTabId, payload);
        emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "stopped" });
    } catch (error) {
        console.error("Background: Failed while finalizing recording.", error);
        emitRecordingState(RECORDING_ERROR_EVENT, { message: error.message || "Failed to finalize recording." });
        emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "finalizeFailed" });
    } finally {
        resetRecordingRuntimeState();
        closeOffscreenDocumentIfPresent().catch((error) => {
            console.debug("Background: Failed to close offscreen document.", error?.message || error);
        });
    }
}

function handleOffscreenRecordingError(payload = {}) {
    const message = payload.message || "MediaRecorder error";
    console.error("Background: Offscreen recording error:", message);

    resetRecordingRuntimeState();
    emitRecordingState(RECORDING_ERROR_EVENT, { message });
    emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "recorderError" });

    closeOffscreenDocumentIfPresent().catch((error) => {
        console.debug("Background: Failed to close offscreen document.", error?.message || error);
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) {
        return false;
    }

    if (message.target === OFFSCREEN_RECORDING_TARGET) {
        // Messages sent to the offscreen document should not be handled here.
        return false;
    }

    if (message.action === "offscreenRecordingComplete") {
        handleOffscreenRecordingComplete(message.payload)
            .then(() => sendResponse({ success: true }))
            .catch((error) => sendResponse({ success: false, message: error.message }));
        return true;
    }

    if (message.action === "offscreenRecordingError") {
        handleOffscreenRecordingError(message.payload);
        sendResponse({ success: true });
        return false;
    }

    if (message.action === "startRecording") {
        (async () => {
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

                recordingTabId = targetTabId;
                await startOffscreenRecording(targetTabId, includeAudio);
                isRecording = true;

                emitRecordingState(RECORDING_STARTED_EVENT, {
                    title: captureInfo.title,
                    timestamp: captureInfo.timestamp,
                });
                sendResponse({ success: true });
            } catch (error) {
                console.error("Background: Error starting recording:", error);
                const friendlyMessage = normalizeStartRecordingError(error);
                resetRecordingRuntimeState();
                emitRecordingState(RECORDING_ERROR_EVENT, { message: friendlyMessage });
                emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "startFailed" });
                sendResponse({ success: false, message: friendlyMessage });
            }
        })();

        return true;
    }

    if (message.action === "stopRecording") {
        (async () => {
            console.log("Background: Received stopRecording message.");

            if (!isRecordingActive()) {
                console.warn("Background: Stop requested but recorder not active.");
                emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "alreadyInactive" });
                sendResponse({ success: false, message: "Recorder not active." });
                return;
            }

            try {
                await stopOffscreenRecording();
                sendResponse({ success: true });
            } catch (error) {
                console.error("Background: Error stopping recording:", error);
                handleOffscreenRecordingError({ message: error.message });
                sendResponse({ success: false, message: error.message });
            }
        })();

        return true;
    }

    if (message.action === "saveClip") {
        (async () => {
            await saveClip(message.payload);
            sendResponse({ success: true });
        })().catch((error) => {
            sendResponse({ success: false, message: error.message });
        });
        return true;
    }

    if (message.action === "discardClip") {
        (async () => {
            await discardClip(message.payload?.clipId);
            sendResponse({ success: true });
        })().catch((error) => {
            sendResponse({ success: false, message: error.message });
        });
        return true;
    }

    return false;
});

async function saveClip(payload = {}) {
    const { clipId, saveAs = false } = payload;
    const clip = await getPendingClip(clipId);
    if (!clip || !clip.blob) {
        console.warn("Background: saveClip requested for missing clip", clipId);
        return;
    }

    const downloadUrl = URL.createObjectURL(clip.blob);

    try {
        const downloadId = await chrome.downloads.download({
            url: downloadUrl,
            filename: clip.filename,
            saveAs,
        });
        console.log(`Background: Download started with ID: ${downloadId}`);
    } catch (error) {
        console.error("Background: Failed to download clip", error);
        throw error;
    } finally {
        setTimeout(() => URL.revokeObjectURL(downloadUrl), CLIP_URL_REVOKE_DELAY_MS);
        scheduleClipCleanup(clipId);
    }
}

async function discardClip(clipId) {
    if (!clipId) return;

    const clip = pendingClips.get(clipId);
    if (clip?.previewUrl) {
        URL.revokeObjectURL(clip.previewUrl);
    }
    pendingClips.delete(clipId);

    try {
        await deletePersistedPendingClip(clipId);
    } catch (error) {
        console.warn(`Background: Failed to remove persisted clip ${clipId}.`, error);
    }

    console.log(`Background: Revoked clip URL for ${clipId}`);
}

prunePersistedPendingClips().catch((error) => {
    console.warn("Background: Failed to prune stale clips.", error);
});

console.log("Background Service Worker started.");
