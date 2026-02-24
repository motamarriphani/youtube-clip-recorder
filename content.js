console.log("YouTube Clip Recorder: Content script loaded.");

let recordButton = null;
let audioToggle = null;
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
let localMediaRecorder = null;
let localRecordedChunks = [];
let activeRecordingMode = null;
let localRecordingMeta = null;
const localPendingClips = new Map();

const DEFAULT_MAX_RECORD_DURATION_MS = 10000;
const MIN_RECORD_DURATION_SECONDS = 3;
const MAX_RECORD_DURATION_SECONDS = 60;
const STORAGE_KEY_MAX_DURATION_SECONDS = 'maxRecordDurationSeconds';
const AUDIO_PREF_KEY = 'includeTabAudio';
const REINJECT_DEBOUNCE_MS = 150;
const INJECTION_HEARTBEAT_MS = 1000;
const INVALID_CONTEXT_RELOAD_GUARD_KEY = 'ytClipRecorderInvalidContextReloaded';
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

function recoverFromInvalidatedContext() {
    try {
        if (sessionStorage.getItem(INVALID_CONTEXT_RELOAD_GUARD_KEY) === '1') {
            alert("Extension was updated. Please refresh this tab.");
            return;
        }
        sessionStorage.setItem(INVALID_CONTEXT_RELOAD_GUARD_KEY, '1');
    } catch (_) {
        // no-op
    }

    location.reload();
}

async function sendRuntimeMessage(message, options = {}) {
    const { recoverOnInvalidation = true } = options;

    try {
        const response = await chrome.runtime.sendMessage(message);
        try {
            sessionStorage.removeItem(INVALID_CONTEXT_RELOAD_GUARD_KEY);
        } catch (_) {
            // no-op
        }
        return response;
    } catch (error) {
        if (recoverOnInvalidation && isExtensionContextInvalidatedError(error)) {
            console.warn("YouTube Clip Recorder: Extension context invalidated. Reloading page to recover.");
            recoverFromInvalidatedContext();
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

function isLocalClipId(clipId) {
    return typeof clipId === 'string' && clipId.startsWith('local_');
}

function cleanupLocalRecorderResources() {
    if (localMediaRecorder) {
        localMediaRecorder.onstop = null;
        localMediaRecorder.ondataavailable = null;
        localMediaRecorder.onerror = null;
        localMediaRecorder = null;
    }

    if (localMediaStream) {
        localMediaStream.getTracks().forEach((track) => {
            if (track.readyState === 'live') {
                track.stop();
            }
        });
        localMediaStream = null;
    }

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

function saveLocalClip(clipId, saveAs = false) {
    const clip = localPendingClips.get(clipId);
    if (!clip) {
        return;
    }

    triggerLocalDownload(clip.url, clip.filename);
    if (saveAs) {
        console.info('YouTube Clip Recorder: Save As requested for local fallback; browser download settings control destination prompt.');
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

    localPendingClips.set(clipId, { url, filename });
    showPreviewModal({ clipId, url, filename });
}

async function startLocalRecording({ title, timestamp, includeAudio }) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('This browser does not support local display capture fallback.');
    }

    const selectedMime = selectSupportedMimeType(includeAudio);
    const recorderOptions = selectedMime.type ? { mimeType: selectedMime.type } : undefined;

    try {
        localMediaStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                frameRate: { ideal: 30 },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
            },
            audio: includeAudio,
        });
    } catch (error) {
        throw new Error(error?.message || 'Display capture request was cancelled or denied.');
    }

    const videoTracks = localMediaStream.getVideoTracks();
    if (!videoTracks.length) {
        cleanupLocalRecorderResources();
        throw new Error('Display capture did not provide a video track.');
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

async function getIncludeAudioPreference() {
    try {
        const stored = await chrome.storage.local.get({ [AUDIO_PREF_KEY]: false });
        return Boolean(stored[AUDIO_PREF_KEY]);
    } catch (error) {
        return false;
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

function createAudioToggle() {
    if (document.getElementById('yt-clip-recorder-audio-toggle')) {
        return document.getElementById('yt-clip-recorder-audio-toggle');
    }

    const label = document.createElement('label');
    label.id = 'yt-clip-recorder-audio-toggle';
    label.className = 'yt-clip-recorder-audio-toggle ytp-button';
    label.style.marginLeft = '8px';
    label.style.fontSize = '0.9em';
    label.style.padding = '5px 8px';
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '4px';

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

    const toggle = createAudioToggle();
    const anchor = getControlsInsertAnchor(controlsRight);
    safeInsertIntoControls(controlsRight, toggle, anchor);
    safeInsertIntoControls(controlsRight, button, anchor);

    audioToggle = toggle;

    console.log('YouTube Clip Recorder: Button and audio toggle injected.');
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
        const includeAudio = Boolean(audioToggle?.querySelector('input')?.checked);

        try {
            const response = await sendRuntimeMessage({
                action: "startRecording",
                payload: { title: videoTitle, timestamp: timestamp, includeAudio }
            });

            if (response === null) {
                return;
            }

            if (!response?.success) {
                if (shouldUseLocalCaptureFallback(response?.message)) {
                    console.warn('YouTube Clip Recorder: Falling back to local display capture mode.');
                    await startLocalRecording({ title: videoTitle, timestamp, includeAudio });
                    return;
                }
                throw new Error(response?.message || "Failed to start recording.");
            }

            console.log("YouTube Clip Recorder: Start recording message sent.");
            activeRecordingMode = BACKGROUND_RECORDING_MODE;
            await applyRecordingState();
        } catch (error) {
            console.error("YouTube Clip Recorder: Error starting recording.", error);
            alert(`Error starting recording: ${error.message}`);
            resetUIState();
        }
    } else {
        await requestStopRecording();
    }
}

function showPreviewModal({ clipId, url, filename }) {
    discardPreviewLocally();
    activePreviewClipId = clipId;

    const overlay = document.createElement('div');
    overlay.id = 'yt-clip-preview-overlay';
    overlay.innerHTML = `
        <div class="yt-clip-preview-modal" role="dialog" aria-label="Clip preview">
            <button class="yt-clip-preview-close" aria-label="Close preview">x</button>
            <h3>Preview Clip</h3>
            <video controls src="${escapeHtml(url)}"></video>
            <p class="yt-clip-preview-filename">${escapeHtml(filename)}</p>
            <div class="yt-clip-preview-actions">
                <button class="yt-clip-btn yt-clip-save">Save</button>
                <button class="yt-clip-btn yt-clip-save-as">Save As...</button>
                <button class="yt-clip-btn yt-clip-discard">Discard</button>
            </div>
        </div>
    `;

    const onDiscard = async () => {
        if (!activePreviewClipId) return;
        if (isLocalClipId(activePreviewClipId)) {
            discardLocalClip(activePreviewClipId);
            discardPreviewLocally();
            return;
        }

        const response = await sendRuntimeMessage({
            action: "discardClip",
            payload: { clipId: activePreviewClipId },
        });
        if (response === null) return;
        discardPreviewLocally();
    };

    overlay.querySelector('.yt-clip-save')?.addEventListener('click', async () => {
        if (!activePreviewClipId) return;

        if (isLocalClipId(activePreviewClipId)) {
            saveLocalClip(activePreviewClipId, false);
            discardPreviewLocally();
            return;
        }

        const response = await sendRuntimeMessage({
            action: "saveClip",
            payload: { clipId: activePreviewClipId, saveAs: false },
        });
        if (response === null) return;
        discardPreviewLocally();
    });

    overlay.querySelector('.yt-clip-save-as')?.addEventListener('click', async () => {
        if (!activePreviewClipId) return;

        if (isLocalClipId(activePreviewClipId)) {
            saveLocalClip(activePreviewClipId, true);
            discardPreviewLocally();
            return;
        }

        const response = await sendRuntimeMessage({
            action: "saveClip",
            payload: { clipId: activePreviewClipId, saveAs: true },
        });
        if (response === null) return;
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

    if (!audioToggle) {
        audioToggle = document.getElementById('yt-clip-recorder-audio-toggle');
    }

    const includeAudio = await getIncludeAudioPreference();
    const checkbox = audioToggle?.querySelector('input');
    if (checkbox) {
        checkbox.checked = includeAudio;
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
    const existingToggle = document.getElementById('yt-clip-recorder-audio-toggle');
    if (existingButton) {
        existingButton.remove();
        recordButton = null;
    }
    if (existingToggle) {
        existingToggle.remove();
        audioToggle = null;
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
    try {
        sessionStorage.removeItem(INVALID_CONTEXT_RELOAD_GUARD_KEY);
    } catch (_) {
        // no-op
    }

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
