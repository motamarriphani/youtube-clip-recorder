console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let isRecording = false;
let isTransitioning = false;
let stopTimeoutId = null;
let reenableTimeoutId = null;
let domObserver = null;
let urlCheckObserver = null;
let lastUrl = location.href;
let lastIsWatchPage = false;
let reinjectDebounceId = null;
let injectionHeartbeatId = null;

let activePreviewClipId = null;
let previewModalEl = null;
let localMediaStream = null;
let localCaptureSourceStream = null;
let localMediaRecorder = null;
let localRecordedChunks = [];
let activeRecordingMode = null;
let localRecordingMeta = null;
const localPendingClips = new Map();
const backgroundPreviewUrls = new Map();
const backgroundPreviewBlobs = new Map();

const DEFAULT_MAX_RECORD_DURATION_MS = 10000;
const MIN_RECORD_DURATION_SECONDS = 3;
const MAX_RECORD_DURATION_SECONDS = 60;
const STORAGE_KEY_MAX_DURATION_SECONDS = 'maxRecordDurationSeconds';
const DEFAULT_INCLUDE_AUDIO = true;
const REINJECT_DEBOUNCE_MS = 150;
const INJECTION_HEARTBEAT_MS = 1000;
const LOCAL_RECORDING_MODE = 'local';
const BACKGROUND_RECORDING_MODE = 'background';
const LOCAL_RECORDING_TIMESLICE_MS = 100;

const RECORDING_STARTED_EVENT = "recordingStarted";
const RECORDING_STOPPED_EVENT = "recordingStopped";
const RECORDING_ERROR_EVENT = "recordingError";

const VIDEO_MIME_CANDIDATES = [
    { type: 'video/webm;codecs=vp9,opus', extension: 'webm' },
    { type: 'video/webm;codecs=vp8,opus', extension: 'webm' },
    { type: 'video/webm;codecs=vp9', extension: 'webm' },
    { type: 'video/webm;codecs=vp8', extension: 'webm' },
    { type: 'video/webm', extension: 'webm' },
    { type: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', extension: 'mp4' },
    { type: 'video/mp4', extension: 'mp4' },
];

function isWatchPageUrl(url = location.href) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname || '';
        if (pathname === '/watch') {
            return true;
        }
        if (pathname.startsWith('/embed/')) {
            return true;
        }
        if (pathname.startsWith('/live/')) {
            return true;
        }
        if (pathname.startsWith('/shorts/')) {
            return true;
        }
    } catch (_) {
        if (url.includes('/watch') || url.includes('/embed/') || url.includes('/live/') || url.includes('/shorts/')) {
            return true;
        }
    }

    // Fallback for YouTube SPA states where URL and player state are briefly out of sync.
    return Boolean(document.querySelector('video.html5-main-video'));
}

function clampDurationSeconds(value) {
    const seconds = Number.parseInt(value, 10);
    if (Number.isNaN(seconds)) {
        return DEFAULT_MAX_RECORD_DURATION_MS / 1000;
    }
    return Math.min(MAX_RECORD_DURATION_SECONDS, Math.max(MIN_RECORD_DURATION_SECONDS, seconds));
}

function formatClipTimestamp(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function isExtensionContextInvalidatedError(error) {
    const message = String(error?.message || error || "");
    return message.includes("Extension context invalidated");
}

async function sendRuntimeMessage(message, options = {}) {
    const { recoverOnInvalidation = true } = options;

    try {
        return await chrome.runtime.sendMessage(message);
    } catch (error) {
        if (recoverOnInvalidation && isExtensionContextInvalidatedError(error)) {
            return null;
        }
        throw error;
    }
}

function selectSupportedMimeType(includeAudio) {
    const compatibleType = VIDEO_MIME_CANDIDATES.find((candidate) => {
        if (includeAudio && candidate.type.includes('codecs=') && !candidate.type.includes('opus') && !candidate.type.includes('mp4a')) {
            return false;
        }
        return MediaRecorder.isTypeSupported(candidate.type);
    });

    if (compatibleType) {
        return compatibleType;
    }

    return { type: '', extension: 'webm' };
}

function sanitizeFilenamePart(value, fallback) {
    const sanitized = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim();

    return sanitized || fallback;
}

function shouldUseLocalCaptureFallback(message) {
    const value = String(message || '').toLowerCase();
    return value.includes('not been invoked for the current page')
        || value.includes('capture permission is not active for this tab')
        || value.includes('activetab permission');
}

function isCapturePermissionDeniedMessage(message) {
    const value = String(message || '').toLowerCase();
    return value.includes('permission denied')
        || value.includes('denied by user')
        || value.includes('permission dismissed')
        || value.includes('cancelled')
        || value.includes('canceled');
}

function createPlayerCaptureStream(includeAudio) {
    const playerVideo = document.querySelector('video.html5-main-video');
    if (!playerVideo) {
        throw new Error('YouTube player video element was not found for player-only capture.');
    }

    const captureFn = playerVideo.captureStream || playerVideo.mozCaptureStream;
    if (typeof captureFn !== 'function') {
        throw new Error('Player-only capture is not supported in this browser.');
    }

    const sourceStream = captureFn.call(playerVideo);
    const sourceVideoTrack = sourceStream.getVideoTracks()[0];
    if (!sourceVideoTrack) {
        sourceStream.getTracks().forEach((track) => {
            if (track.readyState === 'live') {
                track.stop();
            }
        });
        throw new Error('Player-only capture did not provide a video track.');
    }

    const recordingStream = new MediaStream([sourceVideoTrack]);
    if (includeAudio) {
        const sourceAudioTrack = sourceStream.getAudioTracks()[0];
        if (sourceAudioTrack) {
            recordingStream.addTrack(sourceAudioTrack);
        }
    }

    return { sourceStream, recordingStream };
}

function isLocalClipId(clipId) {
    return typeof clipId === 'string' && clipId.startsWith('local_');
}

function revokeBackgroundPreviewUrl(clipId) {
    const previewUrl = backgroundPreviewUrls.get(clipId);
    if (!previewUrl) {
        return;
    }
    URL.revokeObjectURL(previewUrl);
    backgroundPreviewUrls.delete(clipId);
}

function setBackgroundPreviewBlob(clipId, blob) {
    if (!clipId || isLocalClipId(clipId)) {
        return;
    }
    if (blob && typeof blob.size === 'number') {
        backgroundPreviewBlobs.set(clipId, blob);
    } else {
        backgroundPreviewBlobs.delete(clipId);
    }
}

function clearBackgroundPreviewCache(clipId) {
    revokeBackgroundPreviewUrl(clipId);
    backgroundPreviewBlobs.delete(clipId);
}

function resolvePreviewUrl({ clipId, url, blob }) {
    if (!isLocalClipId(clipId) && blob && typeof blob.size === 'number') {
        clearBackgroundPreviewCache(clipId);
        const localPreviewUrl = URL.createObjectURL(blob);
        backgroundPreviewUrls.set(clipId, localPreviewUrl);
        setBackgroundPreviewBlob(clipId, blob);
        return localPreviewUrl;
    }
    return url;
}

async function hydrateBackgroundPreviewSource(clipId, videoEl) {
    if (!clipId || !videoEl || isLocalClipId(clipId)) {
        return false;
    }

    try {
        const response = await sendRuntimeMessage({
            action: "getClipPreviewData",
            payload: { clipId },
        }, { recoverOnInvalidation: false });

        if (!response?.success || !response.blob || typeof response.blob.size !== 'number') {
            return false;
        }

        clearBackgroundPreviewCache(clipId);
        const refreshedPreviewUrl = URL.createObjectURL(response.blob);
        backgroundPreviewUrls.set(clipId, refreshedPreviewUrl);
        setBackgroundPreviewBlob(clipId, response.blob);
        videoEl.src = refreshedPreviewUrl;
        videoEl.load();
        return true;
    } catch (error) {
        console.warn('YouTube Clip Recorder: Failed to recover preview source.', error);
        return false;
    }
}

function inferFileExtension(filename = '', fallback = 'webm') {
    const match = String(filename).match(/\.([a-z0-9]+)$/i);
    if (!match) {
        return fallback;
    }
    return match[1].toLowerCase();
}

function buildNoAudioFilename(filename, preferredExtension = 'webm') {
    const safeName = String(filename || 'youtube_clip.webm');
    const extension = (preferredExtension || inferFileExtension(safeName, 'webm')).toLowerCase();
    const basename = safeName.replace(/\.[^/.]+$/, '');
    const normalizedBase = basename.replace(/_with-audio$/i, '');
    return `${normalizedBase}_no-audio.${extension}`;
}

function getLocalClipEntry(clipId) {
    return localPendingClips.get(clipId) || null;
}

async function getBackgroundClipBlob(clipId) {
    const cached = backgroundPreviewBlobs.get(clipId);
    if (cached) {
        return cached;
    }

    const response = await sendRuntimeMessage({
        action: "getClipPreviewData",
        payload: { clipId },
    }, { recoverOnInvalidation: false });

    if (!response?.success || !response.blob || typeof response.blob.size !== 'number') {
        throw new Error(response?.message || 'Clip data is no longer available.');
    }

    setBackgroundPreviewBlob(clipId, response.blob);
    return response.blob;
}

async function getClipBlobForExport(clipId) {
    if (isLocalClipId(clipId)) {
        const clip = getLocalClipEntry(clipId);
        if (!clip?.blob) {
            throw new Error('Local clip data is no longer available.');
        }
        return clip.blob;
    }
    return getBackgroundClipBlob(clipId);
}

function waitForMediaEvent(target, eventName, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        const cleanup = () => {
            target.removeEventListener(eventName, onEvent);
            target.removeEventListener('error', onError);
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const onEvent = () => {
            cleanup();
            resolve();
        };

        const onError = () => {
            cleanup();
            reject(new Error(`Media element error while waiting for ${eventName}.`));
        };

        target.addEventListener(eventName, onEvent, { once: true });
        target.addEventListener('error', onError, { once: true });
        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${eventName}.`));
        }, timeoutMs);
    });
}

function stopStreamTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
        if (track.readyState === 'live') {
            track.stop();
        }
    });
}

async function createNoAudioBlobFromSource(sourceBlob) {
    if (!sourceBlob || typeof sourceBlob.size !== 'number') {
        throw new Error('Source clip is not available for no-audio export.');
    }

    const sourceUrl = URL.createObjectURL(sourceBlob);
    const hiddenVideo = document.createElement('video');
    hiddenVideo.muted = true;
    hiddenVideo.defaultMuted = true;
    hiddenVideo.preload = 'auto';
    hiddenVideo.playsInline = true;
    hiddenVideo.src = sourceUrl;
    hiddenVideo.style.position = 'fixed';
    hiddenVideo.style.left = '-9999px';
    hiddenVideo.style.top = '-9999px';
    hiddenVideo.style.width = '1px';
    hiddenVideo.style.height = '1px';
    hiddenVideo.style.opacity = '0';
    document.body.appendChild(hiddenVideo);

    let sourcePlaybackStream = null;
    let videoOnlyStream = null;
    let recorder = null;
    let stopPromise = null;

    try {
        await waitForMediaEvent(hiddenVideo, 'loadedmetadata', 15000);
        const sourceWidth = Math.max(1, Number(hiddenVideo.videoWidth) || 1280);
        const sourceHeight = Math.max(1, Number(hiddenVideo.videoHeight) || 720);
        hiddenVideo.width = sourceWidth;
        hiddenVideo.height = sourceHeight;
        hiddenVideo.style.width = `${sourceWidth}px`;
        hiddenVideo.style.height = `${sourceHeight}px`;
        if (hiddenVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            await waitForMediaEvent(hiddenVideo, 'canplay', 15000);
        }

        const captureFn = hiddenVideo.captureStream || hiddenVideo.mozCaptureStream;
        if (typeof captureFn !== 'function') {
            throw new Error('This browser does not support no-audio export for recorded clips.');
        }

        sourcePlaybackStream = captureFn.call(hiddenVideo);
        const videoTrack = sourcePlaybackStream.getVideoTracks()[0];
        if (!videoTrack) {
            throw new Error('Clip conversion failed because no video track was available.');
        }

        videoOnlyStream = new MediaStream([videoTrack]);
        const selectedMime = selectSupportedMimeType(false);
        const recorderOptions = selectedMime.type ? { mimeType: selectedMime.type } : undefined;
        const chunks = [];

        stopPromise = new Promise((resolve, reject) => {
            recorder = recorderOptions
                ? new MediaRecorder(videoOnlyStream, recorderOptions)
                : new MediaRecorder(videoOnlyStream);

            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    chunks.push(event.data);
                }
            };

            recorder.onerror = (event) => {
                reject(new Error(event.error?.message || 'Failed during no-audio export.'));
            };

            recorder.onstop = () => {
                const mimeType = selectedMime.type || sourceBlob.type || 'video/webm';
                const blob = new Blob(chunks, { type: mimeType });
                if (!blob.size) {
                    reject(new Error('No-audio export produced an empty clip.'));
                    return;
                }
                resolve({
                    blob,
                    extension: selectedMime.extension || inferFileExtension('', 'webm'),
                });
            };
        });

        hiddenVideo.currentTime = 0;
        const playAttempt = hiddenVideo.play();
        if (playAttempt?.catch) {
            await playAttempt.catch(() => {
                throw new Error('Could not start clip playback for no-audio export.');
            });
        }

        recorder.start(LOCAL_RECORDING_TIMESLICE_MS);
        const durationMs = Number.isFinite(hiddenVideo.duration) && hiddenVideo.duration > 0
            ? Math.ceil(hiddenVideo.duration * 1000)
            : 10000;
        await waitForMediaEvent(hiddenVideo, 'ended', durationMs + 15000);
        if (recorder.state === 'recording') {
            recorder.stop();
        }

        return await stopPromise;
    } finally {
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
            if (stopPromise) {
                try {
                    await stopPromise;
                } catch (_) {
                    // cleanup path; best effort only
                }
            }
        }
        hiddenVideo.pause();
        hiddenVideo.removeAttribute('src');
        hiddenVideo.load();
        if (hiddenVideo.parentElement) {
            hiddenVideo.remove();
        }
        stopStreamTracks(videoOnlyStream);
        stopStreamTracks(sourcePlaybackStream);
        URL.revokeObjectURL(sourceUrl);
    }
}

async function requestBlobDownload({ blob, filename, saveAs = false }) {
    const response = await sendRuntimeMessage({
        action: "downloadBlob",
        payload: { blob, filename, saveAs },
    }, { recoverOnInvalidation: false });

    if (!response?.success) {
        throw new Error(response?.message || 'Failed to start blob download.');
    }
}

function cleanupLocalRecorderResources() {
    const streamToStop = localMediaStream;
    const sourceStreamToStop = localCaptureSourceStream;

    if (localMediaRecorder) {
        localMediaRecorder.onstop = null;
        localMediaRecorder.ondataavailable = null;
        localMediaRecorder.onerror = null;
        localMediaRecorder = null;
    }

    if (streamToStop) {
        streamToStop.getTracks().forEach((track) => {
            if (track.readyState === 'live') {
                track.stop();
            }
        });
    }

    if (sourceStreamToStop && sourceStreamToStop !== streamToStop) {
        sourceStreamToStop.getTracks().forEach((track) => {
            if (track.readyState === 'live') {
                track.stop();
            }
        });
    }

    localMediaStream = null;
    localCaptureSourceStream = null;

    localRecordedChunks = [];
    localRecordingMeta = null;
}

function discardLocalClip(clipId) {
    const clip = localPendingClips.get(clipId);
    if (!clip) {
        return;
    }
    URL.revokeObjectURL(clip.url);
    localPendingClips.delete(clipId);
}

function triggerLocalDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

async function saveLocalClip(clipId, saveAs = false) {
    const clip = localPendingClips.get(clipId);
    if (!clip) {
        throw new Error('Local clip is no longer available.');
    }

    if (saveAs && clip.blob) {
        await requestBlobDownload({
            blob: clip.blob,
            filename: clip.filename,
            saveAs: true,
        });
    } else {
        triggerLocalDownload(clip.url, clip.filename);
    }
    discardLocalClip(clipId);
}

function finalizeLocalRecordingStop() {
    const chunks = [...localRecordedChunks];
    const metadata = localRecordingMeta;
    cleanupLocalRecorderResources();
    activeRecordingMode = null;
    resetUIState();

    if (!chunks.length || !metadata) {
        return;
    }

    const mimeType = metadata.mimeType || 'video/webm';
    const fileExtension = metadata.fileExtension || 'webm';
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
        return;
    }

    const safeTitle = sanitizeFilenamePart(metadata.title, 'youtube_clip').substring(0, 100);
    const safeTimestamp = sanitizeFilenamePart(metadata.timestamp, '00_00');
    const audioSuffix = metadata.includeAudio ? '_with-audio' : '';
    const filename = `${safeTitle}_clip_${safeTimestamp}${audioSuffix}.${fileExtension}`;
    const clipId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const url = URL.createObjectURL(blob);

    localPendingClips.set(clipId, { url, filename, blob });
    showPreviewModal({ clipId, url, filename });
}

async function startLocalRecording({ title, timestamp, includeAudio }) {
    const selectedMime = selectSupportedMimeType(includeAudio);
    const recorderOptions = selectedMime.type ? { mimeType: selectedMime.type } : undefined;
    let preparedCapture = null;

    try {
        preparedCapture = createPlayerCaptureStream(includeAudio);
        console.info('YouTube Clip Recorder: Using player-only capture mode.');
    } catch (playerCaptureError) {
        console.info('YouTube Clip Recorder: Player-only capture unavailable, falling back to display picker.', playerCaptureError?.message || playerCaptureError);

        if (!navigator.mediaDevices?.getDisplayMedia) {
            throw new Error('This browser does not support display capture fallback.');
        }

        try {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: { ideal: 30 },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: includeAudio,
            });

            preparedCapture = { sourceStream: displayStream, recordingStream: displayStream };
        } catch (displayCaptureError) {
            throw new Error(displayCaptureError?.message || 'Display capture request was cancelled or denied.');
        }
    }

    localCaptureSourceStream = preparedCapture.sourceStream;
    localMediaStream = preparedCapture.recordingStream;

    const videoTracks = localMediaStream.getVideoTracks();
    if (!videoTracks.length) {
        cleanupLocalRecorderResources();
        throw new Error('Capture source did not provide a video track.');
    }

    localRecordedChunks = [];
    localRecordingMeta = {
        title,
        timestamp,
        includeAudio,
        mimeType: selectedMime.type || 'video/webm',
        fileExtension: selectedMime.extension || 'webm',
    };

    localMediaRecorder = recorderOptions
        ? new MediaRecorder(localMediaStream, recorderOptions)
        : new MediaRecorder(localMediaStream);

    localMediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            localRecordedChunks.push(event.data);
        }
    };

    localMediaRecorder.onerror = (event) => {
        const message = event.error?.message || 'Local recording failed.';
        console.error('YouTube Clip Recorder: Local fallback recorder error.', event.error);
        cleanupLocalRecorderResources();
        activeRecordingMode = null;
        resetUIState();
        alert(`Error during local recording: ${message}`);
    };

    localMediaRecorder.onstop = () => {
        finalizeLocalRecordingStop();
    };

    videoTracks.forEach((track) => {
        track.onended = () => {
            if (localMediaRecorder?.state === 'recording') {
                localMediaRecorder.stop();
            }
        };
    });

    localMediaRecorder.start(LOCAL_RECORDING_TIMESLICE_MS);
    activeRecordingMode = LOCAL_RECORDING_MODE;
    await applyRecordingState();
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

function clearTimers() {
    if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
    }
    if (reenableTimeoutId) {
        clearTimeout(reenableTimeoutId);
        reenableTimeoutId = null;
    }
}

function setButtonState({ text, color = '', disabled = false }) {
    if (!recordButton) return;
    recordButton.textContent = text;
    recordButton.style.color = color;
    recordButton.disabled = disabled;
}

function resetUIState() {
    isRecording = false;
    isTransitioning = false;
    activeRecordingMode = null;
    clearTimers();
    setButtonState({ text: 'REC Clip', color: '', disabled: false });
}

async function applyRecordingState() {
    isRecording = true;
    isTransitioning = false;
    setButtonState({ text: 'STOP', color: 'red', disabled: false });

    clearTimeout(stopTimeoutId);
    const maxDurationMs = await getMaxRecordDurationMs();
    stopTimeoutId = setTimeout(() => {
        console.log("YouTube Clip Recorder: Max duration reached, stopping automatically.");
        requestStopRecording();
    }, maxDurationMs);
}

async function requestStopRecording() {
    if (!recordButton || isTransitioning) {
        return;
    }

    isTransitioning = true;
    setButtonState({ text: 'Stopping...', color: '', disabled: true });

    try {
        if (activeRecordingMode === LOCAL_RECORDING_MODE) {
            if (localMediaRecorder && localMediaRecorder.state === 'recording') {
                localMediaRecorder.stop();
            } else {
                resetUIState();
            }
            return;
        }

        await sendRuntimeMessage({ action: "stopRecording" });
        console.log("YouTube Clip Recorder: Stop recording message sent.");
        reenableTimeoutId = setTimeout(() => {
            if (!isRecording) {
                resetUIState();
            }
        }, 1200);
    } catch (error) {
        console.error("YouTube Clip Recorder: Error stopping recording.", error);
        alert(`Error stopping recording: ${error.message}`);
        resetUIState();
    }
}

function getControlsInsertAnchor(controlsContainer) {
    const settingsButton = controlsContainer.querySelector('.ytp-settings-button');
    if (!settingsButton) {
        return null;
    }

    let anchor = settingsButton;
    while (anchor && anchor.parentElement !== controlsContainer) {
        anchor = anchor.parentElement;
    }

    if (anchor && anchor.parentElement === controlsContainer) {
        return anchor;
    }

    return null;
}

function safeInsertIntoControls(controlsContainer, element, anchor) {
    if (!controlsContainer || !element) {
        return;
    }

    if (anchor && anchor.parentElement === controlsContainer) {
        controlsContainer.insertBefore(element, anchor);
        return;
    }

    controlsContainer.appendChild(element);
}

function createRecordButton() {
    const existingButton = document.getElementById('yt-clip-recorder-button');
    if (existingButton) {
        return existingButton;
    }

    const controlsRight = document.querySelector('.ytp-right-controls');
    if (!controlsRight) {
        return null;
    }

    const button = document.createElement('button');
    button.id = 'yt-clip-recorder-button';
    button.textContent = 'REC Clip';
    button.classList.add('ytp-button');
    button.style.marginLeft = '8px';
    button.style.fontSize = '0.9em';
    button.style.padding = '5px 8px';
    button.onclick = handleRecordButtonClick;

    const anchor = getControlsInsertAnchor(controlsRight);
    safeInsertIntoControls(controlsRight, button, anchor);

    console.log('YouTube Clip Recorder: Record button injected.');
    return button;
}

async function handleRecordButtonClick() {
    if (!recordButton || isTransitioning) return;

    const videoElement = document.querySelector('video.html5-main-video');
    if (!videoElement) {
        console.error("YouTube Clip Recorder: Video element not found.");
        alert("Could not find the YouTube video element.");
        return;
    }

    if (!isRecording) {
        isTransitioning = true;
        setButtonState({ text: 'Starting...', color: '', disabled: true });

        const videoTitle = document.title.replace(/ - YouTube$/, '');
        const currentTimeSeconds = Math.floor(videoElement.currentTime);
        const timestamp = formatClipTimestamp(currentTimeSeconds);
        const includeAudio = DEFAULT_INCLUDE_AUDIO;

        try {
            const response = await sendRuntimeMessage({
                action: "startRecording",
                payload: { title: videoTitle, timestamp: timestamp, includeAudio }
            }, { recoverOnInvalidation: false });

            if (!response?.success) {
                if (response?.fallbackSuggested || shouldUseLocalCaptureFallback(response?.message)) {
                    console.info('YouTube Clip Recorder: Falling back to local capture mode.');
                    await startLocalRecording({ title: videoTitle, timestamp, includeAudio });
                    return;
                }
                throw new Error(response?.message || "Failed to start recording.");
            }

            console.log("YouTube Clip Recorder: Start recording message sent.");
            activeRecordingMode = BACKGROUND_RECORDING_MODE;
            await applyRecordingState();
        } catch (error) {
            const message = String(error?.message || error || "Unknown error.");
            if (isExtensionContextInvalidatedError(error) || shouldUseLocalCaptureFallback(message)) {
                try {
                    console.info('YouTube Clip Recorder: Runtime unavailable, using local capture fallback.');
                    await startLocalRecording({ title: videoTitle, timestamp, includeAudio });
                    return;
                } catch (fallbackError) {
                    const fallbackMessage = String(fallbackError?.message || fallbackError || "Unknown error.");
                    if (isCapturePermissionDeniedMessage(fallbackMessage)) {
                        console.info('YouTube Clip Recorder: Capture selection was cancelled by user.');
                        resetUIState();
                        return;
                    }
                    console.error("YouTube Clip Recorder: Local fallback start failed.", fallbackError);
                    alert(`Error starting recording: ${fallbackMessage}`);
                    resetUIState();
                    return;
                }
            }

            console.error("YouTube Clip Recorder: Error starting recording.", error);
            alert(`Error starting recording: ${message}`);
            resetUIState();
        }
    } else {
        await requestStopRecording();
    }
}

function showPreviewModal({ clipId, url, filename, blob }) {
    discardPreviewLocally();
    activePreviewClipId = clipId;
    const previewUrl = resolvePreviewUrl({ clipId, url, blob });

    const overlay = document.createElement('div');
    overlay.id = 'yt-clip-preview-overlay';
    overlay.innerHTML = `
        <div class="yt-clip-preview-modal" role="dialog" aria-label="Clip preview">
            <div class="yt-clip-preview-header">
                <h3>Preview Clip</h3>
                <div class="yt-clip-preview-window-actions">
                    <button class="yt-clip-preview-minimize" aria-label="Minimize preview" title="Minimize preview">-</button>
                    <button class="yt-clip-preview-close" aria-label="Close preview" title="Close preview">x</button>
                </div>
            </div>
            <video controls playsinline preload="metadata" src="${escapeHtml(previewUrl)}"></video>
            <p class="yt-clip-preview-filename">${escapeHtml(filename)}</p>
            <label class="yt-clip-download-audio-option">
                <input type="checkbox" class="yt-clip-download-audio-checkbox" checked />
                Download with audio
            </label>
            <p class="yt-clip-preview-status" aria-live="polite"></p>
            <div class="yt-clip-preview-actions">
                <button class="yt-clip-btn yt-clip-save">Save</button>
                <button class="yt-clip-btn yt-clip-save-as">Save As...</button>
                <button class="yt-clip-btn yt-clip-discard">Discard</button>
            </div>
        </div>
    `;

    const modalEl = overlay.querySelector('.yt-clip-preview-modal');
    const statusEl = overlay.querySelector('.yt-clip-preview-status');
    const downloadAudioCheckbox = overlay.querySelector('.yt-clip-download-audio-checkbox');
    const minimizeButton = overlay.querySelector('.yt-clip-preview-minimize');
    const actionButtons = [...overlay.querySelectorAll('.yt-clip-btn, .yt-clip-preview-close')];
    let isBusy = false;

    const setPreviewBusy = (busy, statusText = '') => {
        isBusy = busy;
        actionButtons.forEach((button) => {
            button.disabled = busy;
        });
        if (downloadAudioCheckbox) {
            downloadAudioCheckbox.disabled = busy;
        }
        if (statusEl) {
            statusEl.textContent = statusText;
        }
    };

    const setMinimized = (minimized) => {
        overlay.classList.toggle('yt-clip-preview-overlay-minimized', minimized);
        modalEl?.classList.toggle('yt-clip-preview-modal-minimized', minimized);

        if (minimizeButton) {
            minimizeButton.textContent = minimized ? '+' : '-';
            const label = minimized ? 'Restore preview' : 'Minimize preview';
            minimizeButton.setAttribute('aria-label', label);
            minimizeButton.setAttribute('title', label);
        }
    };

    minimizeButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const currentlyMinimized = overlay.classList.contains('yt-clip-preview-overlay-minimized');
        setMinimized(!currentlyMinimized);
    });

    const onDiscard = async () => {
        if (isBusy || !activePreviewClipId) return;
        const currentClipId = activePreviewClipId;
        setPreviewBusy(true, 'Discarding preview...');

        if (isLocalClipId(currentClipId)) {
            discardLocalClip(currentClipId);
            discardPreviewLocally();
            return;
        }

        try {
            const response = await sendRuntimeMessage({
                action: "discardClip",
                payload: { clipId: currentClipId },
            }, { recoverOnInvalidation: false });
            if (response?.success === false) {
                throw new Error(response.message || 'Failed to discard clip.');
            }
            discardPreviewLocally();
        } catch (error) {
            console.error('YouTube Clip Recorder: Failed to discard clip.', error);
            alert(`Error discarding clip: ${error.message || error}`);
            setPreviewBusy(false, '');
        }
    };

    const handleSave = async (saveAs) => {
        if (isBusy || !activePreviewClipId) return;
        const currentClipId = activePreviewClipId;
        const withAudio = downloadAudioCheckbox ? downloadAudioCheckbox.checked : true;

        if (withAudio) {
            setPreviewBusy(true, saveAs ? 'Preparing Save As download...' : 'Preparing download...');
            try {
                if (isLocalClipId(currentClipId)) {
                    await saveLocalClip(currentClipId, saveAs);
                    discardPreviewLocally();
                    return;
                }

                const response = await sendRuntimeMessage({
                    action: "saveClip",
                    payload: { clipId: currentClipId, saveAs },
                }, { recoverOnInvalidation: false });
                if (!response?.success) {
                    throw new Error(response?.message || 'Failed to start download.');
                }
                discardPreviewLocally();
            } catch (error) {
                console.error('YouTube Clip Recorder: Failed to save clip.', error);
                alert(`Error saving clip: ${error.message || error}`);
                setPreviewBusy(false, '');
            }
            return;
        }

        setPreviewBusy(true, 'Removing audio and preparing download...');
        try {
            const sourceBlob = await getClipBlobForExport(currentClipId);
            const noAudioResult = await createNoAudioBlobFromSource(sourceBlob);
            const noAudioFilename = buildNoAudioFilename(filename, noAudioResult.extension);

            await requestBlobDownload({
                blob: noAudioResult.blob,
                filename: noAudioFilename,
                saveAs,
            });

            if (isLocalClipId(currentClipId)) {
                discardLocalClip(currentClipId);
            } else {
                const response = await sendRuntimeMessage({
                    action: "discardClip",
                    payload: { clipId: currentClipId },
                }, { recoverOnInvalidation: false });
                if (response?.success === false) {
                    console.warn('YouTube Clip Recorder: Failed to discard original background clip after no-audio export.');
                }
            }

            discardPreviewLocally();
        } catch (error) {
            console.error('YouTube Clip Recorder: Failed to export no-audio clip.', error);
            alert(`Error exporting no-audio clip: ${error.message || error}`);
            setPreviewBusy(false, '');
        }
    };

    overlay.querySelector('.yt-clip-save')?.addEventListener('click', async () => {
        await handleSave(false);
    });

    overlay.querySelector('.yt-clip-save-as')?.addEventListener('click', async () => {
        await handleSave(true);
    });

    overlay.querySelector('.yt-clip-discard')?.addEventListener('click', onDiscard);
    overlay.querySelector('.yt-clip-preview-close')?.addEventListener('click', onDiscard);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay && !overlay.classList.contains('yt-clip-preview-overlay-minimized')) {
            onDiscard();
        }
    });

    const previewVideo = overlay.querySelector('video');
    if (previewVideo) {
        let initialPositionApplied = false;
        const applyInitialPreviewPosition = () => {
            if (initialPositionApplied) {
                return;
            }
            initialPositionApplied = true;

            try {
                previewVideo.pause();
            } catch (_) {
                // no-op
            }

            let targetTime = 0;
            if (previewVideo.seekable && previewVideo.seekable.length > 0) {
                try {
                    targetTime = previewVideo.seekable.start(0);
                } catch (_) {
                    targetTime = 0;
                }
            }

            if (!Number.isFinite(targetTime) || targetTime < 0) {
                targetTime = 0;
            }

            try {
                previewVideo.currentTime = targetTime;
            } catch (_) {
                try {
                    previewVideo.currentTime = 0;
                } catch (__){
                    // no-op
                }
            }

            if (statusEl) {
                statusEl.textContent = '';
            }
        };

        previewVideo.addEventListener('loadedmetadata', applyInitialPreviewPosition);
        previewVideo.addEventListener('loadeddata', applyInitialPreviewPosition);

        let recoveryAttempted = false;
        previewVideo.addEventListener('error', async () => {
            if (recoveryAttempted || isLocalClipId(clipId)) {
                return;
            }
            recoveryAttempted = true;
            initialPositionApplied = false;
            const recovered = await hydrateBackgroundPreviewSource(clipId, previewVideo);
            if (!recovered) {
                console.warn('YouTube Clip Recorder: Preview player failed to load clip source.');
            }
        });

        if (!isLocalClipId(clipId) && (!blob || typeof blob.size !== 'number')) {
            setPreviewBusy(true, 'Loading preview...');
            hydrateBackgroundPreviewSource(clipId, previewVideo)
                .finally(() => {
                    setPreviewBusy(false, '');
                });
        }
    }

    document.body.appendChild(overlay);
    previewModalEl = overlay;
}

function discardPreviewLocally() {
    if (activePreviewClipId && !isLocalClipId(activePreviewClipId)) {
        clearBackgroundPreviewCache(activePreviewClipId);
    }
    if (previewModalEl) {
        previewModalEl.remove();
        previewModalEl = null;
    }
    activePreviewClipId = null;
}

async function cleanupPreviewOnUnload() {
    if (!activePreviewClipId) return;

    if (isLocalClipId(activePreviewClipId)) {
        discardLocalClip(activePreviewClipId);
        return;
    }

    try {
        await sendRuntimeMessage({
            action: "discardClip",
            payload: { clipId: activePreviewClipId },
        }, { recoverOnInvalidation: false });
    } catch (error) {
        console.warn("YouTube Clip Recorder: Failed to cleanup preview clip.", error);
    }
}

chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;

    if (message.action === 'clipReadyForPreview') {
        showPreviewModal(message.payload);
        return;
    }

    if (message.type === RECORDING_STARTED_EVENT) {
        activeRecordingMode = BACKGROUND_RECORDING_MODE;
        applyRecordingState();
    } else if (message.type === RECORDING_STOPPED_EVENT) {
        resetUIState();
    } else if (message.type === RECORDING_ERROR_EVENT) {
        console.error('YouTube Clip Recorder: Background recording error.', message.payload?.message || message.payload);
        resetUIState();
    }
});

window.addEventListener('beforeunload', cleanupPreviewOnUnload);
window.addEventListener('pagehide', cleanupPreviewOnUnload);

async function initialize() {
    if (!isWatchPageUrl()) {
        return;
    }

    const button = createRecordButton();
    if (button) {
        recordButton = button;
        resetUIState();
    }
}

function debouncedInitialize() {
    if (reinjectDebounceId) {
        clearTimeout(reinjectDebounceId);
    }

    reinjectDebounceId = setTimeout(() => {
        reinjectDebounceId = null;
        initialize();
    }, REINJECT_DEBOUNCE_MS);
}

function ensureRecorderControlsInjected() {
    if (!isWatchPageUrl()) return;

    const hasButton = Boolean(document.getElementById('yt-clip-recorder-button'));
    const hasControls = Boolean(document.querySelector('.ytp-right-controls'));
    if (!hasButton && hasControls) {
        debouncedInitialize();
    }
}

function handleRouteOrStateChange() {
    const currentUrl = location.href;
    const currentIsWatchPage = isWatchPageUrl(currentUrl);
    const watchStateChanged = currentIsWatchPage !== lastIsWatchPage;
    const urlChanged = currentUrl !== lastUrl;

    if (!urlChanged && !watchStateChanged) {
        return;
    }

    lastUrl = currentUrl;
    lastIsWatchPage = currentIsWatchPage;

    if (currentIsWatchPage) {
        debouncedInitialize();
        return;
    }

    if (isRecording) {
        console.log("YouTube Clip Recorder: Navigated away, stopping recording.");
        requestStopRecording().catch((e) => console.log("Error stopping recording on navigate away:", e));
    }

    const existingButton = document.getElementById('yt-clip-recorder-button');
    if (existingButton) {
        existingButton.remove();
        recordButton = null;
    }

    cleanupPreviewOnUnload();
    discardPreviewLocally();
}

function startDomObservation() {
    if (domObserver) {
        domObserver.disconnect();
    }

    const target = document.querySelector('#movie_player, ytd-player, ytd-watch-flexy') || document.body;
    domObserver = new MutationObserver(() => {
        ensureRecorderControlsInjected();
    });

    domObserver.observe(target, {
        childList: true,
        subtree: true
    });
}

function startInjectionHeartbeat() {
    if (injectionHeartbeatId) {
        clearInterval(injectionHeartbeatId);
    }

    injectionHeartbeatId = setInterval(() => {
        ensureRecorderControlsInjected();
    }, INJECTION_HEARTBEAT_MS);
}

function startUrlObservation() {
    if (urlCheckObserver) {
        urlCheckObserver.disconnect();
    }

    urlCheckObserver = new MutationObserver(handleRouteOrStateChange);
    urlCheckObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    window.addEventListener('popstate', handleRouteOrStateChange);
    window.addEventListener('yt-navigate-finish', handleRouteOrStateChange);

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        const result = originalPushState.apply(this, args);
        handleRouteOrStateChange();
        return result;
    };

    history.replaceState = function (...args) {
        const result = originalReplaceState.apply(this, args);
        handleRouteOrStateChange();
        return result;
    };
}

function bootstrap() {
    lastUrl = location.href;
    lastIsWatchPage = isWatchPageUrl(lastUrl);

    startDomObservation();
    startUrlObservation();
    startInjectionHeartbeat();
    handleRouteOrStateChange();
    ensureRecorderControlsInjected();
    debouncedInitialize();
}

bootstrap();
