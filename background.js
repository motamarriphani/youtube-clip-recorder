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
const INLINE_PREVIEW_BLOB_MAX_BYTES = 24 * 1024 * 1024;
const PENDING_CLIPS_DB_NAME = "ytClipRecorder";
const PENDING_CLIPS_DB_VERSION = 1;
const PENDING_CLIPS_STORE_NAME = "pendingClips";
const ERROR_CODE_CAPTURE_PERMISSION_INACTIVE = "capture_permission_inactive";
const ERROR_CODE_CAPTURE_DISALLOWED_PAGE = "capture_disallowed_page";
const ERROR_CODE_CAPTURE_START_FAILED = "capture_start_failed";
const ERROR_CODE_CAPTURE_STOP_FAILED = "capture_stop_failed";
const ERROR_CODE_ALREADY_RECORDING = "already_recording";
const ERROR_CODE_RECORDER_INACTIVE = "recorder_not_active";
const ERROR_CODE_CLIP_NOT_FOUND = "clip_not_found";
const ERROR_CODE_MISSING_CLIP_ID = "missing_clip_id";
const ERROR_CODE_DOWNLOAD_FAILED = "download_failed";
const ERROR_CODE_DOWNLOAD_CANCELLED = "download_cancelled";
const ERROR_CODE_BLOB_MISSING = "blob_missing";
const ERROR_CODE_READINESS_CHECK_FAILED = "readiness_check_failed";
const ERROR_CODE_TAB_ID_MISSING = "tab_id_missing";

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

function inferFileExtension(filename = "", fallback = "webm") {
    const match = String(filename).match(/\.([a-z0-9]+)$/i);
    if (!match) {
        return fallback;
    }
    return match[1].toLowerCase();
}

function buildFallbackDownloadFilename(filename = "") {
    const extension = inferFileExtension(filename, "webm");
    return `youtube_clip_${Date.now()}.${extension}`;
}

function isUserCancelledDownloadError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("canceled")
        || message.includes("cancelled")
        || message.includes("interrupted");
}

function isRetryableSaveAsFilenameError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("invalid filename")
        || message.includes("invalid file name")
        || message.includes("illegal characters")
        || message.includes("could not create")
        || message.includes("file name too long")
        || message.includes("filename too long");
}

async function triggerDownload({ url, filename, saveAs }) {
    const downloadOptions = { url, saveAs: Boolean(saveAs) };
    if (filename) {
        downloadOptions.filename = filename;
    }
    return chrome.downloads.download(downloadOptions);
}

function successResponse(payload = {}) {
    return { success: true, ...payload };
}

function failureResponse(code, message, payload = {}) {
    return { success: false, code, message, ...payload };
}

function normalizeStartRecordingError(error) {
    const rawMessage = String(error?.message || error || "Unknown recording error.");
    const lower = rawMessage.toLowerCase();

    if (lower.includes("not been invoked for the current page")
        || lower.includes("has not been invoked for the current page")) {
        return {
            code: ERROR_CODE_CAPTURE_PERMISSION_INACTIVE,
            message: "Capture permission is not active for this tab yet. Click the extension icon once on this YouTube tab, close the popup, then try REC Clip again.",
        };
    }

    if (lower.includes("chrome pages cannot be captured")) {
        return {
            code: ERROR_CODE_CAPTURE_DISALLOWED_PAGE,
            message: "This page cannot be captured. Open a normal YouTube watch page (not chrome:// or extension pages) and try again.",
        };
    }

    return {
        code: ERROR_CODE_CAPTURE_START_FAILED,
        message: rawMessage,
    };
}

function isTabCaptureInvocationErrorMessage(message) {
    const lower = String(message || "").toLowerCase();
    return lower.includes("not been invoked for the current page")
        || lower.includes("has not been invoked for the current page")
        || lower.includes("capture permission is not active for this tab")
        || lower.includes("permission is not active for this tab")
        || lower.includes("activetab permission")
        || lower.includes("chrome pages cannot be captured")
        || lower.includes("cannot be captured");
}

function isYouTubeWatchUrl(url = "") {
    try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes("youtube.com")) {
            return false;
        }
        const pathname = parsed.pathname || "";
        return pathname === "/watch"
            || pathname.startsWith("/embed/")
            || pathname.startsWith("/shorts/")
            || pathname.startsWith("/live/");
    } catch (_) {
        return false;
    }
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
            const previewPayload = {
                clipId,
                url: previewUrl,
                filename,
                title: captureInfo.title,
                timestamp,
            };
            if (blob.size <= INLINE_PREVIEW_BLOB_MAX_BYTES) {
                previewPayload.blob = blob;
            }

            await chrome.tabs.sendMessage(targetTabId, {
                action: "clipReadyForPreview",
                payload: previewPayload,
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
        emitRecordingState(RECORDING_ERROR_EVENT, {
            code: ERROR_CODE_CAPTURE_STOP_FAILED,
            message: error.message || "Failed to finalize recording.",
        });
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
    const code = payload.code || ERROR_CODE_CAPTURE_STOP_FAILED;
    console.error("Background: Offscreen recording error:", message);

    resetRecordingRuntimeState();
    emitRecordingState(RECORDING_ERROR_EVENT, { code, message });
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
            .then(() => sendResponse(successResponse()))
            .catch((error) => sendResponse(failureResponse(ERROR_CODE_CAPTURE_STOP_FAILED, error.message || "Failed to finalize recording.")));
        return true;
    }

    if (message.action === "offscreenRecordingError") {
        handleOffscreenRecordingError(message.payload);
        sendResponse(successResponse());
        return false;
    }

    if (message.action === "startRecording") {
        (async () => {
            if (isRecordingActive()) {
                console.warn("Background: Recording already in progress.");
                sendResponse(failureResponse(ERROR_CODE_ALREADY_RECORDING, "Already recording."));
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
                sendResponse(successResponse());
            } catch (error) {
                const rawMessage = String(error?.message || error || "");
                const normalized = normalizeStartRecordingError(error);
                const friendlyMessage = normalized.message;
                const errorCode = normalized.code;

                if (isTabCaptureInvocationErrorMessage(rawMessage) || isTabCaptureInvocationErrorMessage(friendlyMessage)) {
                    console.info("Background: Tab capture invocation not active; content script can use local fallback.");
                    resetRecordingRuntimeState();
                    sendResponse(failureResponse(
                        ERROR_CODE_CAPTURE_PERMISSION_INACTIVE,
                        friendlyMessage,
                        { fallbackSuggested: true }
                    ));
                    return;
                }

                console.error("Background: Error starting recording:", error);
                resetRecordingRuntimeState();
                emitRecordingState(RECORDING_ERROR_EVENT, { code: errorCode, message: friendlyMessage });
                emitRecordingState(RECORDING_STOPPED_EVENT, { reason: "startFailed" });
                sendResponse(failureResponse(errorCode, friendlyMessage));
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
                sendResponse(failureResponse(ERROR_CODE_RECORDER_INACTIVE, "Recorder not active."));
                return;
            }

            try {
                await stopOffscreenRecording();
                sendResponse(successResponse());
            } catch (error) {
                console.error("Background: Error stopping recording:", error);
                handleOffscreenRecordingError({ message: error.message });
                sendResponse(failureResponse(ERROR_CODE_CAPTURE_STOP_FAILED, error.message || "Failed to stop recording."));
            }
        })();

        return true;
    }

    if (message.action === "saveClip") {
        (async () => {
            await saveClip(message.payload);
            sendResponse(successResponse());
        })().catch((error) => {
            sendResponse(failureResponse(
                error?.code || ERROR_CODE_DOWNLOAD_FAILED,
                error?.message || "Failed to download clip."
            ));
        });
        return true;
    }

    if (message.action === "discardClip") {
        (async () => {
            await discardClip(message.payload?.clipId);
            sendResponse(successResponse());
        })().catch((error) => {
            sendResponse(failureResponse(ERROR_CODE_CLIP_NOT_FOUND, error.message || "Failed to discard clip."));
        });
        return true;
    }

    if (message.action === "getClipPreviewData") {
        (async () => {
            const clipId = message.payload?.clipId;
            if (!clipId) {
                sendResponse(failureResponse(ERROR_CODE_MISSING_CLIP_ID, "Missing clip ID."));
                return;
            }

            const clip = await getPendingClip(clipId);
            if (!clip?.blob) {
                sendResponse(failureResponse(ERROR_CODE_CLIP_NOT_FOUND, "Clip not found."));
                return;
            }

            sendResponse(successResponse({ blob: clip.blob, filename: clip.filename }));
        })().catch((error) => {
            sendResponse(failureResponse(ERROR_CODE_CLIP_NOT_FOUND, error.message || "Failed to load clip preview data."));
        });
        return true;
    }

    if (message.action === "downloadBlob") {
        (async () => {
            await downloadBlob(message.payload);
            sendResponse(successResponse());
        })().catch((error) => {
            sendResponse(failureResponse(
                error?.code || ERROR_CODE_DOWNLOAD_FAILED,
                error?.message || "Failed to download generated clip."
            ));
        });
        return true;
    }

    if (message.action === "getCaptureReadiness") {
        (async () => {
            const tabId = message.payload?.tabId;
            const pageUrl = message.payload?.pageUrl || "";

            if (!tabId || typeof tabId !== "number") {
                sendResponse(failureResponse(ERROR_CODE_TAB_ID_MISSING, "Open a YouTube tab and click Check again."));
                return;
            }

            if (!isYouTubeWatchUrl(pageUrl)) {
                sendResponse(successResponse({
                    ready: false,
                    code: ERROR_CODE_CAPTURE_DISALLOWED_PAGE,
                    message: "Open a YouTube watch page first, then check readiness again.",
                }));
                return;
            }

            try {
                await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
                sendResponse(successResponse({
                    ready: true,
                    message: "Ready for recording on this tab.",
                }));
            } catch (error) {
                const normalized = normalizeStartRecordingError(error);
                sendResponse(successResponse({
                    ready: false,
                    code: normalized.code || ERROR_CODE_READINESS_CHECK_FAILED,
                    message: normalized.message || "Capture is not ready yet.",
                }));
            }
        })().catch((error) => {
            sendResponse(failureResponse(ERROR_CODE_READINESS_CHECK_FAILED, error.message || "Could not check capture readiness."));
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
        const error = new Error("Clip not found.");
        error.code = ERROR_CODE_CLIP_NOT_FOUND;
        throw error;
    }

    const downloadUrl = URL.createObjectURL(clip.blob);

    let downloadStarted = false;
    try {
        let downloadId = await triggerDownload({
            url: downloadUrl,
            filename: clip.filename,
            saveAs,
        });
        if (!downloadId && saveAs) {
            throw new Error("Download dialog was cancelled.");
        }
        if (!downloadId) {
            throw new Error("Chrome did not start the download.");
        }
        downloadStarted = true;
        console.log(`Background: Download started with ID: ${downloadId}`);
    } catch (error) {
        if (isUserCancelledDownloadError(error)) {
            const cancelError = new Error("Save was cancelled.");
            cancelError.code = ERROR_CODE_DOWNLOAD_CANCELLED;
            throw cancelError;
        }

        if (saveAs && isRetryableSaveAsFilenameError(error)) {
            try {
                const fallbackFilename = buildFallbackDownloadFilename(clip.filename);
                const retryDownloadId = await triggerDownload({
                    url: downloadUrl,
                    filename: fallbackFilename,
                    saveAs: true,
                });
                if (retryDownloadId) {
                    downloadStarted = true;
                    console.warn(`Background: Save As filename rejected, used fallback name: ${fallbackFilename}`);
                    return;
                }
            } catch (retryError) {
                if (isUserCancelledDownloadError(retryError)) {
                    const cancelError = new Error("Save was cancelled.");
                    cancelError.code = ERROR_CODE_DOWNLOAD_CANCELLED;
                    throw cancelError;
                }
                console.warn("Background: Save As retry with fallback filename failed.", retryError);
            }
        }

        console.error("Background: Failed to download clip", error);
        const downloadError = new Error(error?.message || "Failed to download clip.");
        downloadError.code = ERROR_CODE_DOWNLOAD_FAILED;
        throw downloadError;
    } finally {
        setTimeout(() => URL.revokeObjectURL(downloadUrl), CLIP_URL_REVOKE_DELAY_MS);
        if (downloadStarted) {
            scheduleClipCleanup(clipId);
        }
    }
}

async function downloadBlob(payload = {}) {
    const { blob, filename = "youtube_clip.webm", saveAs = false } = payload;
    if (!blob || typeof blob.size !== "number") {
        const error = new Error("Missing blob payload for download.");
        error.code = ERROR_CODE_BLOB_MISSING;
        throw error;
    }

    const downloadUrl = URL.createObjectURL(blob);
    try {
        let downloadId = await triggerDownload({
            url: downloadUrl,
            filename,
            saveAs,
        });
        if (!downloadId && saveAs) {
            throw new Error("Download dialog was cancelled.");
        }
        if (!downloadId) {
            throw new Error("Chrome did not start the download.");
        }
        console.log(`Background: Generated clip download started with ID: ${downloadId}`);
    } catch (error) {
        if (isUserCancelledDownloadError(error)) {
            const cancelError = new Error("Save was cancelled.");
            cancelError.code = ERROR_CODE_DOWNLOAD_CANCELLED;
            throw cancelError;
        }

        if (saveAs && isRetryableSaveAsFilenameError(error)) {
            try {
                const fallbackFilename = buildFallbackDownloadFilename(filename);
                const retryDownloadId = await triggerDownload({
                    url: downloadUrl,
                    filename: fallbackFilename,
                    saveAs: true,
                });
                if (retryDownloadId) {
                    console.warn(`Background: Blob Save As filename rejected, used fallback name: ${fallbackFilename}`);
                    return;
                }
            } catch (retryError) {
                console.warn("Background: Blob Save As retry with fallback filename failed.", retryError);
            }
        }

        const downloadError = new Error(error?.message || "Failed to download generated clip.");
        downloadError.code = ERROR_CODE_DOWNLOAD_FAILED;
        throw downloadError;
    } finally {
        setTimeout(() => URL.revokeObjectURL(downloadUrl), CLIP_URL_REVOKE_DELAY_MS);
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
