console.log("YouTube Clip Recorder: Content script loaded.");

if (typeof globalThis.chrome === "undefined") {
    globalThis.chrome = {};
}

if (!globalThis.chrome.runtime) {
    globalThis.chrome.runtime = {
        sendMessage: async () => {
            throw new Error("Extension messaging is unavailable. Refresh the page or reload the extension, then try again.");
        },
        onMessage: {
            addListener: () => {},
        },
    };
}

if (globalThis.chrome?.storage?.sync && typeof globalThis.chrome.storage.sync.get === "function") {
    const originalSyncGet = globalThis.chrome.storage.sync.get.bind(globalThis.chrome.storage.sync);
    globalThis.chrome.storage.sync.get = async (...args) => {
        try {
            return await originalSyncGet(...args);
        } catch (error) {
            const message = String(error?.message || error || "");
            if (message.includes("Extension context invalidated")) {
                return {};
            }
            throw error;
        }
    };
}

let recordButton = null;
let recordingStatusChip = null;
let recordingStatusText = null;
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
const RECORDING_TICK_MS = 250;
const INLINE_ERROR_RESET_MS = 6500;
const PREVIEW_UNSAVED_GUARD_MESSAGE = "You have an unsaved clip preview. Leave this page and discard it?";

const RECORDING_STATE_IDLE = 'idle';
const RECORDING_STATE_STARTING = 'starting';
const RECORDING_STATE_RECORDING = 'recording';
const RECORDING_STATE_STOPPING = 'stopping';
const RECORDING_STATE_FINALIZING = 'finalizing';
const RECORDING_STATE_ERROR = 'error';

const RECORDING_STARTED_EVENT = "recordingStarted";
const RECORDING_STOPPED_EVENT = "recordingStopped";
const RECORDING_ERROR_EVENT = "recordingError";
const RECORDING_STOP_REASON_RECORDER_ERROR = "recorderError";
const RECORDING_STOP_REASON_START_FAILED = "startFailed";
const RECORDING_STOP_REASON_FINALIZE_FAILED = "finalizeFailed";
const CAPTURE_PERMISSION_INACTIVE_ERROR_CODE = "capture_permission_inactive";
const CAPTURE_DENIED_ERROR_CODE = "capture_denied_by_user";
const PREVIEW_LOAD_FAILED_ERROR_CODE = "preview_load_failed";
const DOWNLOAD_FAILED_ERROR_CODE = "download_failed";
const DOWNLOAD_CANCELLED_ERROR_CODE = "download_cancelled";
const SAVE_PICKER_UNAVAILABLE_ERROR_CODE = "save_picker_unavailable";
const NO_AUDIO_EXPORT_FAILED_ERROR_CODE = "no_audio_export_failed";
const EXPORT_TRANSCODE_FAILED_ERROR_CODE = "export_transcode_failed";

const EXPORT_FPS_OPTIONS = [
    { value: "source", label: "Source fps" },
    { value: "30", label: "30 fps" },
    { value: "60", label: "60 fps" },
];

const YOUTUBE_QUALITY_DIMENSIONS = {
    hd2160: { width: 3840, height: 2160, label: "2160p" },
    hd1440: { width: 2560, height: 1440, label: "1440p" },
    hd1080: { width: 1920, height: 1080, label: "1080p" },
    hd720: { width: 1280, height: 720, label: "720p" },
    large: { width: 854, height: 480, label: "480p" },
    medium: { width: 640, height: 360, label: "360p" },
    small: { width: 426, height: 240, label: "240p" },
    tiny: { width: 256, height: 144, label: "144p" },
};
const STANDARD_QUALITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

let recordingTickerId = null;
let recordingStartedAtMs = 0;
let recordingMaxDurationMs = DEFAULT_MAX_RECORD_DURATION_MS;
let recorderInlineErrorTimeoutId = null;
let recorderUiState = RECORDING_STATE_IDLE;

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

function formatDurationClock(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function ensureRecordingStatusChip() {
    if (recordingStatusChip && recordingStatusText && document.body.contains(recordingStatusChip)) {
        return recordingStatusChip;
    }

    const existingChip = document.getElementById('yt-clip-recorder-status');
    if (existingChip) {
        recordingStatusChip = existingChip;
        recordingStatusText = existingChip.querySelector('.yt-clip-recorder-status-text');
        return existingChip;
    }

    const controlsRight = document.querySelector('.ytp-right-controls');
    if (!controlsRight) {
        return null;
    }

    const statusChip = document.createElement('span');
    statusChip.id = 'yt-clip-recorder-status';
    statusChip.className = 'yt-clip-recorder-status';
    statusChip.setAttribute('aria-live', 'polite');
    statusChip.innerHTML = `
        <span class="yt-clip-recorder-status-dot" aria-hidden="true"></span>
        <span class="yt-clip-recorder-status-text"></span>
    `;

    const anchor = getControlsInsertAnchor(controlsRight);
    safeInsertIntoControls(controlsRight, statusChip, anchor);
    recordingStatusChip = statusChip;
    recordingStatusText = statusChip.querySelector('.yt-clip-recorder-status-text');
    return statusChip;
}

function clearRecorderInlineErrorTimer() {
    if (recorderInlineErrorTimeoutId) {
        clearTimeout(recorderInlineErrorTimeoutId);
        recorderInlineErrorTimeoutId = null;
    }
}

function stopRecordingTicker() {
    if (recordingTickerId) {
        clearInterval(recordingTickerId);
        recordingTickerId = null;
    }
}

function renderRecordingTimer() {
    if (recorderUiState !== RECORDING_STATE_RECORDING) {
        return;
    }

    ensureRecordingStatusChip();
    if (!recordingStatusText) {
        return;
    }

    const elapsedSeconds = (Date.now() - recordingStartedAtMs) / 1000;
    const maxSeconds = recordingMaxDurationMs / 1000;
    const elapsedClock = formatDurationClock(elapsedSeconds);
    const maxClock = formatDurationClock(maxSeconds);
    recordingStatusText.textContent = `${elapsedClock} / ${maxClock}`;
    if (recordButton && isRecording && !isTransitioning) {
        recordButton.textContent = `STOP ${elapsedClock}`;
        recordButton.title = `Recording ${elapsedClock} / ${maxClock}`;
    }
}

function setRecorderStatus(state, message = '') {
    recorderUiState = state;
    const chip = ensureRecordingStatusChip();
    if (!chip || !recordingStatusText) {
        return;
    }

    chip.classList.remove(
        'yt-clip-recorder-status-visible',
        'yt-clip-recorder-status-recording',
        'yt-clip-recorder-status-starting',
        'yt-clip-recorder-status-stopping',
        'yt-clip-recorder-status-finalizing',
        'yt-clip-recorder-status-error'
    );

    if (state === RECORDING_STATE_IDLE) {
        recordingStatusText.textContent = '';
        if (recordButton && !isRecording && !isTransitioning) {
            recordButton.title = 'Start clip recording';
        }
        return;
    }

    chip.classList.add('yt-clip-recorder-status-visible');

    if (state === RECORDING_STATE_STARTING) {
        chip.classList.add('yt-clip-recorder-status-starting');
        recordingStatusText.textContent = message || 'Starting...';
        return;
    }

    if (state === RECORDING_STATE_RECORDING) {
        chip.classList.add('yt-clip-recorder-status-recording');
        renderRecordingTimer();
        return;
    }

    if (state === RECORDING_STATE_STOPPING) {
        chip.classList.add('yt-clip-recorder-status-stopping');
        recordingStatusText.textContent = message || 'Stopping...';
        return;
    }

    if (state === RECORDING_STATE_FINALIZING) {
        chip.classList.add('yt-clip-recorder-status-finalizing');
        recordingStatusText.textContent = message || 'Finalizing clip...';
        return;
    }

    if (state === RECORDING_STATE_ERROR) {
        chip.classList.add('yt-clip-recorder-status-error');
        recordingStatusText.textContent = message || 'Something went wrong.';
    }
}

function startRecordingTicker(maxDurationMs) {
    stopRecordingTicker();
    clearRecorderInlineErrorTimer();
    recordingStartedAtMs = Date.now();
    recordingMaxDurationMs = Math.max(0, Number(maxDurationMs) || DEFAULT_MAX_RECORD_DURATION_MS);
    setRecorderStatus(RECORDING_STATE_RECORDING);
    recordingTickerId = setInterval(renderRecordingTimer, RECORDING_TICK_MS);
}

function showRecorderInlineError(message, resetDelayMs = INLINE_ERROR_RESET_MS) {
    stopRecordingTicker();
    clearRecorderInlineErrorTimer();
    setRecorderStatus(RECORDING_STATE_ERROR, message || 'Something went wrong.');

    recorderInlineErrorTimeoutId = setTimeout(() => {
        recorderInlineErrorTimeoutId = null;
        if (!isRecording && !isTransitioning) {
            setRecorderStatus(RECORDING_STATE_IDLE);
        }
    }, resetDelayMs);
}

function isExtensionContextInvalidatedError(error) {
    const message = String(error?.message || error || "");
    return message.includes("Extension context invalidated");
}

function hasRuntimeMessaging() {
    return typeof chrome !== "undefined"
        && Boolean(chrome?.runtime)
        && typeof chrome.runtime.sendMessage === "function";
}

async function sendRuntimeMessage(message, options = {}) {
    const { recoverOnInvalidation = true } = options;

    if (!hasRuntimeMessaging()) {
        if (recoverOnInvalidation) {
            return null;
        }

        const error = new Error("Extension messaging is unavailable. Refresh the page or reload the extension, then try again.");
        error.code = "extension_context_unavailable";
        throw error;
    }

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

function shouldUseLocalCaptureFallbackForCode(code) {
    return code === CAPTURE_PERMISSION_INACTIVE_ERROR_CODE;
}

function isCapturePermissionDeniedMessage(message) {
    const value = String(message || '').toLowerCase();
    return value.includes('permission denied')
        || value.includes('denied by user')
        || value.includes('permission dismissed')
        || value.includes('cancelled')
        || value.includes('canceled');
}

function toUserErrorMessage({ code, message }) {
    const fallback = String(message || 'Something went wrong.');
    if (code === CAPTURE_PERMISSION_INACTIVE_ERROR_CODE) {
        return 'Capture permission is inactive. Click the extension icon on this YouTube tab once, close popup, and try REC again.';
    }
    if (code === CAPTURE_DENIED_ERROR_CODE) {
        return 'Capture was denied. Please allow capture and try again.';
    }
    if (code === PREVIEW_LOAD_FAILED_ERROR_CODE) {
        return 'Preview failed to load. Use Retry Preview or save directly.';
    }
    if (code === DOWNLOAD_FAILED_ERROR_CODE) {
        if (fallback && fallback.toLowerCase() !== 'failed to download clip.' && fallback.toLowerCase() !== 'failed to start blob download.') {
            return fallback;
        }
        return 'Save As failed. Please try again to choose location and filename.';
    }
    if (code === DOWNLOAD_CANCELLED_ERROR_CODE) {
        return 'Save was cancelled.';
    }
    if (code === SAVE_PICKER_UNAVAILABLE_ERROR_CODE) {
        return 'Save As is unavailable in this browser context.';
    }
    if (code === NO_AUDIO_EXPORT_FAILED_ERROR_CODE) {
        return 'No-audio export failed. Try again or download with audio.';
    }
    if (code === EXPORT_TRANSCODE_FAILED_ERROR_CODE) {
        return 'Clip export failed for the selected quality or frame rate. Try Source or a lower setting.';
    }
    return fallback;
}

function extractErrorDetails(source) {
    if (!source) {
        return { code: null, message: 'Something went wrong.' };
    }

    if (typeof source === 'object') {
        return {
            code: source.code || null,
            message: String(source.message || source.error || 'Something went wrong.'),
        };
    }

    return { code: null, message: String(source) };
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

function getPlayerVideoElement() {
    return document.querySelector('video.html5-main-video');
}

function pauseUnderlyingPlayerForPreview() {
    const playerVideo = getPlayerVideoElement();
    if (!playerVideo) {
        return;
    }

    try {
        if (!playerVideo.paused && !playerVideo.ended) {
            playerVideo.pause();
        }
    } catch (error) {
        console.debug('YouTube Clip Recorder: Failed to pause underlying player for preview.', error);
    }
}

async function getSavedRecorderSettings() {
    const response = await sendRuntimeMessage({
        action: 'getRecorderSettings',
    });

    if (!response || response.success === false) {
        return null;
    }

    return response;
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

        const previewBlob = normalizePreviewBlob(response?.blob, response?.type)
            || (response?.dataUrl ? await dataUrlToBlob(response.dataUrl) : null);
        if (!response?.success || !previewBlob || typeof previewBlob.size !== 'number') {
            return false;
        }

        clearBackgroundPreviewCache(clipId);
        const refreshedPreviewUrl = URL.createObjectURL(previewBlob);
        backgroundPreviewUrls.set(clipId, refreshedPreviewUrl);
        setBackgroundPreviewBlob(clipId, previewBlob);
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

function getYouTubePlayer() {
    const player = document.getElementById('movie_player');
    if (!player) {
        return null;
    }
    return player;
}

function parseMaybeJson(value) {
    if (!value) {
        return null;
    }
    if (typeof value === 'object') {
        return value;
    }
    if (typeof value !== 'string') {
        return null;
    }
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
}

function getQualityLevelFromLabel(label) {
    const normalizedLabel = String(label || '').trim();
    const matchedEntry = Object.entries(YOUTUBE_QUALITY_DIMENSIONS)
        .find(([, value]) => value.label === normalizedLabel);
    if (matchedEntry) {
        return matchedEntry[0];
    }

    const matchedHeight = normalizedLabel.match(/(2160|1440|1080|720|480|360|240|144)p/i)?.[1];
    if (!matchedHeight) {
        return null;
    }

    return Object.entries(YOUTUBE_QUALITY_DIMENSIONS)
        .find(([, value]) => String(value.height) === matchedHeight)?.[0] || null;
}

function getQualityLevelFromHeight(height) {
    const numericHeight = Number(height);
    if (!Number.isFinite(numericHeight)) {
        return null;
    }
    return Object.entries(YOUTUBE_QUALITY_DIMENSIONS)
        .find(([, value]) => value.height === numericHeight)?.[0] || null;
}

function normalizeHeightToStandardTier(height) {
    const numericHeight = Number(height);
    if (!Number.isFinite(numericHeight) || numericHeight <= 0) {
        return 720;
    }

    let bestHeight = STANDARD_QUALITY_HEIGHTS[0];
    let bestDistance = Math.abs(bestHeight - numericHeight);
    STANDARD_QUALITY_HEIGHTS.forEach((candidate) => {
        const distance = Math.abs(candidate - numericHeight);
        if (distance < bestDistance) {
            bestHeight = candidate;
            bestDistance = distance;
        }
    });
    return bestHeight;
}

function collectQualityLevelsFromStreamingData(targetSet, response) {
    const parsedResponse = parseMaybeJson(response);
    const formats = [
        ...(parsedResponse?.streamingData?.formats || []),
        ...(parsedResponse?.streamingData?.adaptiveFormats || []),
    ];

    formats.forEach((format) => {
        const qualityFromLabel = getQualityLevelFromLabel(format?.qualityLabel || format?.quality);
        const qualityFromHeight = getQualityLevelFromHeight(format?.height);
        const matchedLevel = qualityFromLabel || qualityFromHeight;
        if (matchedLevel) {
            targetSet.add(matchedLevel);
        }
    });
}

function collectQualityLevelsFromDocumentScripts(targetSet) {
    const scriptTexts = Array.from(document.scripts || [])
        .map((script) => script.textContent || '')
        .filter((text) => text.includes('qualityLabel') || text.includes('streamingData'));

    scriptTexts.forEach((text) => {
        const qualityLabelMatches = text.match(/"qualityLabel":"(\d{3,4})p/g) || [];
        qualityLabelMatches.forEach((match) => {
            const height = Number.parseInt(match.match(/(\d{3,4})p/)?.[1] || '', 10);
            const level = getQualityLevelFromHeight(height);
            if (level) {
                targetSet.add(level);
            }
        });

        const heightMatches = text.match(/"height":(\d{3,4})/g) || [];
        heightMatches.forEach((match) => {
            const height = Number.parseInt(match.match(/(\d{3,4})/)?.[1] || '', 10);
            const level = getQualityLevelFromHeight(height);
            if (level) {
                targetSet.add(level);
            }
        });
    });
}

function expandQualityLevelsForExport(targetSet) {
    const availableHeights = Array.from(targetSet)
        .map((level) => YOUTUBE_QUALITY_DIMENSIONS[level]?.height || 0)
        .filter((height) => height > 0);

    if (availableHeights.length === 0) {
        return;
    }

    const maxAvailableHeight = Math.max(...availableHeights);
    Object.entries(YOUTUBE_QUALITY_DIMENSIONS).forEach(([level, value]) => {
        if (value.height <= maxAvailableHeight) {
            targetSet.add(level);
        }
    });
}

function addStandardQualityLevelsUpToHeight(targetSet, maxHeight) {
    const numericMaxHeight = Number(maxHeight);
    if (!Number.isFinite(numericMaxHeight) || numericMaxHeight <= 0) {
        return;
    }

    Object.entries(YOUTUBE_QUALITY_DIMENSIONS).forEach(([level, value]) => {
        if (value.height <= numericMaxHeight) {
            targetSet.add(level);
        }
    });
}

function getPlayerQualityOptions() {
    const player = getYouTubePlayer();
    const qualityLevels = new Set();

    if (typeof player?.getAvailableQualityLevels === 'function') {
        player.getAvailableQualityLevels()
            .filter((level) => YOUTUBE_QUALITY_DIMENSIONS[level])
            .forEach((level) => qualityLevels.add(level));
    }

    if (typeof player?.getPlayerResponse === 'function') {
        collectQualityLevelsFromStreamingData(qualityLevels, player.getPlayerResponse());
    }

    collectQualityLevelsFromStreamingData(qualityLevels, globalThis?.ytInitialPlayerResponse);
    collectQualityLevelsFromStreamingData(qualityLevels, globalThis?.ytplayer?.config?.args?.raw_player_response);
    collectQualityLevelsFromDocumentScripts(qualityLevels);

    const menuLabels = Array.from(document.querySelectorAll('.ytp-quality-menu .ytp-menuitem-label, .ytp-quality-menu .ytp-menuitem'))
        .map((element) => element.textContent || '')
        .map((text) => text.match(/(2160|1440|1080|720|480|360|240|144)p/)?.[0] || '')
        .filter(Boolean);
    menuLabels.forEach((label) => {
        const matchedLevel = getQualityLevelFromLabel(label);
        if (matchedLevel) {
            qualityLevels.add(matchedLevel);
        }
    });

    const detectedHeights = Array.from(qualityLevels)
        .map((level) => YOUTUBE_QUALITY_DIMENSIONS[level]?.height || 0)
        .filter((height) => height > 0);

    const video = document.querySelector('video.html5-main-video');
    const currentVideoHeight = Math.max(144, Number(video?.videoHeight) || 0);
    const normalizedCurrentHeight = normalizeHeightToStandardTier(currentVideoHeight);
    const detectedMaxHeight = Math.max(...(detectedHeights.length ? detectedHeights : [0]));
    const sourceHeight = normalizeHeightToStandardTier(Math.max(detectedMaxHeight, normalizedCurrentHeight, 720));

    const exportLevels = new Set();
    addStandardQualityLevelsUpToHeight(exportLevels, sourceHeight);

    const options = Array.from(exportLevels)
        .sort((left, right) => (YOUTUBE_QUALITY_DIMENSIONS[right]?.height || 0) - (YOUTUBE_QUALITY_DIMENSIONS[left]?.height || 0))
        .map((level) => ({
            value: level,
            label: YOUTUBE_QUALITY_DIMENSIONS[level].label,
        }));

    options.unshift({ value: 'source', label: `Source (${sourceHeight}p)` });
    return options;
}

function getTargetExportDimensions(sourceWidth, sourceHeight, qualityValue) {
    if (!qualityValue || qualityValue === 'source' || !YOUTUBE_QUALITY_DIMENSIONS[qualityValue]) {
        return {
            width: sourceWidth,
            height: sourceHeight,
        };
    }

    const maxSize = YOUTUBE_QUALITY_DIMENSIONS[qualityValue];
    const scale = Math.min(maxSize.width / sourceWidth, maxSize.height / sourceHeight, 1);
    const scaledWidth = Math.max(2, Math.round(sourceWidth * scale));
    const scaledHeight = Math.max(2, Math.round(sourceHeight * scale));

    return {
        width: scaledWidth % 2 === 0 ? scaledWidth : scaledWidth - 1,
        height: scaledHeight % 2 === 0 ? scaledHeight : scaledHeight - 1,
    };
}

function getTargetExportFrameRate(sourceFpsEstimate, fpsValue) {
    if (!fpsValue || fpsValue === 'source') {
        return sourceFpsEstimate;
    }

    const parsedValue = Number.parseInt(fpsValue, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        return sourceFpsEstimate;
    }

    if (!Number.isFinite(sourceFpsEstimate) || sourceFpsEstimate <= 0) {
        return parsedValue;
    }

    return Math.min(parsedValue, sourceFpsEstimate);
}

function buildExportFilename(filename, qualityValue, fpsValue, includeAudio, extension) {
    const safeName = String(filename || 'youtube_clip.webm');
    const baseName = safeName.replace(/\.[^/.]+$/, '').replace(/_with-audio$/i, '');
    const qualitySuffix = qualityValue && qualityValue !== 'source'
        ? `_${YOUTUBE_QUALITY_DIMENSIONS[qualityValue]?.label || qualityValue}`
        : '';
    const fpsSuffix = fpsValue && fpsValue !== 'source'
        ? `_${fpsValue}fps`
        : '';
    const audioSuffix = includeAudio ? '' : '_no-audio';
    return `${baseName}${qualitySuffix}${fpsSuffix}${audioSuffix}.${extension}`;
}

function triggerLocalBlobDownload({ blob, filename }) {
    if (!blob || typeof blob.size !== 'number') {
        const error = new Error('Missing blob payload for download.');
        error.code = DOWNLOAD_FAILED_ERROR_CODE;
        throw error;
    }

    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename || 'youtube_clip.webm';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000);
}

function getLocalClipEntry(clipId) {
    return localPendingClips.get(clipId) || null;
}

function normalizePreviewBlob(blobLike, type = 'video/webm') {
    if (blobLike instanceof Blob) {
        return blobLike;
    }

    if (blobLike instanceof ArrayBuffer) {
        return new Blob([blobLike], { type });
    }

    if (ArrayBuffer.isView(blobLike)) {
        return new Blob([blobLike.buffer], { type });
    }

    return null;
}

async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
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

        const fetchedBlob = response?.dataUrl ? await dataUrlToBlob(response.dataUrl) : null;
        const normalizedBlob = normalizePreviewBlob(response?.blob, response?.type)
            || normalizePreviewBlob(response?.buffer, response?.type)
            || fetchedBlob;

    if (!response?.success || !normalizedBlob || typeof normalizedBlob.size !== 'number') {
        const error = new Error(response?.message || 'Clip data is no longer available.');
        error.code = response?.code || null;
        throw error;
    }

    setBackgroundPreviewBlob(clipId, normalizedBlob);
    return normalizedBlob;
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

async function createExportBlobFromSource(sourceBlob, exportOptions = {}) {
    if (!sourceBlob || typeof sourceBlob.size !== 'number') {
        throw new Error('Source clip is not available for export.');
    }

    const {
        includeAudio = true,
        quality = 'source',
        fps = 'source',
    } = exportOptions;

    const sourceUrl = URL.createObjectURL(sourceBlob);
    const hiddenVideo = document.createElement('video');
    hiddenVideo.muted = true;
    hiddenVideo.defaultMuted = true;
    hiddenVideo.volume = 0;
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

    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '-9999px';
    canvas.style.top = '-9999px';
    canvas.style.opacity = '0';
    document.body.appendChild(canvas);

    let canvasStream = null;
    let sourcePlaybackStream = null;
    let composedStream = null;
    let recorder = null;
    let animationFrameId = null;
    let stopPromise = null;

    const cleanup = () => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        hiddenVideo.pause();
        stopStreamTracks(canvasStream);
        stopStreamTracks(sourcePlaybackStream);
        stopStreamTracks(composedStream);
        if (hiddenVideo.parentNode) {
            hiddenVideo.remove();
        }
        if (canvas.parentNode) {
            canvas.remove();
        }
        URL.revokeObjectURL(sourceUrl);
    };

    try {
        await waitForMediaEvent(hiddenVideo, 'loadedmetadata', 15000);
        if (hiddenVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            await waitForMediaEvent(hiddenVideo, 'canplay', 15000);
        }

        const sourceWidth = Math.max(2, Number(hiddenVideo.videoWidth) || 1280);
        const sourceHeight = Math.max(2, Number(hiddenVideo.videoHeight) || 720);
        const targetSize = getTargetExportDimensions(sourceWidth, sourceHeight, quality);
        const sourceFpsEstimate = Number(getYouTubePlayer()?.getVideoData?.().fps) || 60;
        const targetFps = getTargetExportFrameRate(sourceFpsEstimate, fps);

        canvas.width = targetSize.width;
        canvas.height = targetSize.height;

        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
            throw new Error('Canvas export context is unavailable.');
        }

        const drawFrame = () => {
            if (hiddenVideo.ended || hiddenVideo.paused) {
                return;
            }
            context.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
            animationFrameId = requestAnimationFrame(drawFrame);
        };

        canvasStream = canvas.captureStream(targetFps || 30);
        sourcePlaybackStream = typeof hiddenVideo.captureStream === 'function'
            ? hiddenVideo.captureStream()
            : (typeof hiddenVideo.mozCaptureStream === 'function' ? hiddenVideo.mozCaptureStream() : null);

        const composedTracks = [...canvasStream.getVideoTracks()];
        if (includeAudio) {
            const audioTrack = sourcePlaybackStream?.getAudioTracks?.()[0];
            if (audioTrack) {
                composedTracks.push(audioTrack);
            }
        }
        composedStream = new MediaStream(composedTracks);

        const selectedMime = selectSupportedMimeType(includeAudio);
        const recorderOptions = selectedMime.type ? { mimeType: selectedMime.type } : undefined;
        const chunks = [];

        stopPromise = new Promise((resolve, reject) => {
            recorder = recorderOptions
                ? new MediaRecorder(composedStream, recorderOptions)
                : new MediaRecorder(composedStream);

            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    chunks.push(event.data);
                }
            };

            recorder.onerror = (event) => {
                reject(event.error || new Error('MediaRecorder export failed.'));
            };

            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: selectedMime.type || 'video/webm' });
                resolve({
                    blob,
                    extension: selectedMime.extension || 'webm',
                });
            };
        });

        recorder.start(100);
        context.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
        animationFrameId = requestAnimationFrame(drawFrame);
        await hiddenVideo.play();
        await waitForMediaEvent(hiddenVideo, 'ended', 60000);
        if (recorder.state !== 'inactive') {
            recorder.stop();
        }

        return await stopPromise;
    } catch (error) {
        if (recorder?.state && recorder.state !== 'inactive') {
            recorder.stop();
        }
        const exportError = new Error(error?.message || 'Failed to export clip.');
        exportError.code = EXPORT_TRANSCODE_FAILED_ERROR_CODE;
        throw exportError;
    } finally {
        cleanup();
    }
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
        const error = new Error(response?.message || 'Failed to start blob download.');
        error.code = response?.code || DOWNLOAD_FAILED_ERROR_CODE;
        throw error;
    }
}

function isSavePickerCancellationError(error) {
    return error?.name === 'AbortError'
        || String(error?.message || '').toLowerCase().includes('aborted');
}

function buildSavePickerTypes(filename = '', mimeType = 'video/webm') {
    const extension = inferFileExtension(filename, 'webm');
    const normalizedMime = normalizeMimeTypeForPicker(mimeType, extension);
    const extensionWithDot = `.${extension}`;
    return [{
        description: 'Video clip',
        accept: {
            [normalizedMime]: [extensionWithDot],
        },
    }];
}

function normalizeMimeTypeForPicker(mimeType, extension = 'webm') {
    const fallbackMime = extension === 'mp4' ? 'video/mp4' : 'video/webm';
    const raw = String(mimeType || '').trim().toLowerCase();
    if (!raw) {
        return fallbackMime;
    }

    // showSaveFilePicker expects an essence MIME type (no codecs/params).
    const essence = raw.split(';')[0].trim();
    if (essence === 'video/webm' || essence === 'video/mp4') {
        return essence;
    }
    return fallbackMime;
}

async function saveBlobWithSystemPicker({ blob, filename }) {
    if (typeof window.showSaveFilePicker !== 'function') {
        const unavailableError = new Error('Save As is unavailable in this browser context.');
        unavailableError.code = SAVE_PICKER_UNAVAILABLE_ERROR_CODE;
        throw unavailableError;
    }

    const fallbackFilename = filename || `youtube_clip_${Date.now()}.${inferFileExtension('', 'webm')}`;
    let fileHandle = null;
    try {
        fileHandle = await window.showSaveFilePicker({
            suggestedName: fallbackFilename,
            types: buildSavePickerTypes(fallbackFilename, blob?.type || 'video/webm'),
            excludeAcceptAllOption: false,
        });
    } catch (error) {
        if (isSavePickerCancellationError(error)) {
            const cancelledError = new Error('Save was cancelled.');
            cancelledError.code = DOWNLOAD_CANCELLED_ERROR_CODE;
            throw cancelledError;
        }
        throw error;
    }

    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
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
        await saveBlobWithSystemPicker({
            blob: clip.blob,
            filename: clip.filename,
        });
    } else {
        triggerLocalDownload(clip.url, clip.filename);
    }
    discardLocalClip(clipId);
}

function finalizeLocalRecordingStop() {
    setRecorderStatus(RECORDING_STATE_FINALIZING, 'Finalizing clip...');
    const chunks = [...localRecordedChunks];
    const metadata = localRecordingMeta;
    cleanupLocalRecorderResources();
    activeRecordingMode = null;
    resetRuntimeUiFlags();

    if (!chunks.length || !metadata) {
        setRecorderStatus(RECORDING_STATE_IDLE);
        return;
    }

    const mimeType = metadata.mimeType || 'video/webm';
    const fileExtension = metadata.fileExtension || 'webm';
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
        setRecorderStatus(RECORDING_STATE_IDLE);
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
    setRecorderStatus(RECORDING_STATE_IDLE);
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
        resetRuntimeUiFlags();
        showRecorderInlineError(`Recording error: ${message}`);
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

function setButtonState({ text, color = '', disabled = false, title }) {
    if (!recordButton) return;
    recordButton.textContent = text;
    recordButton.style.color = color;
    recordButton.disabled = disabled;
    if (typeof title === 'string') {
        recordButton.title = title;
    }
}

function resetRuntimeUiFlags() {
    isRecording = false;
    isTransitioning = false;
    activeRecordingMode = null;
    stopRecordingTicker();
    clearTimers();
    setButtonState({ text: 'REC Clip', color: '', disabled: false, title: 'Start clip recording' });
}

function resetUIState() {
    resetRuntimeUiFlags();
    clearRecorderInlineErrorTimer();
    setRecorderStatus(RECORDING_STATE_IDLE);
}

async function applyRecordingState() {
    isRecording = true;
    isTransitioning = false;
    setButtonState({ text: 'STOP 00:00', color: 'red', disabled: false, title: 'Recording 00:00' });

    clearTimeout(stopTimeoutId);
    const maxDurationMs = await getMaxRecordDurationMs();
    startRecordingTicker(maxDurationMs);
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
    setButtonState({ text: 'Stopping...', color: '', disabled: true, title: 'Stopping recording' });
    setRecorderStatus(RECORDING_STATE_STOPPING, 'Stopping...');

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
        setRecorderStatus(RECORDING_STATE_FINALIZING, 'Finalizing clip...');
        reenableTimeoutId = setTimeout(() => {
            if (!isRecording) {
                resetUIState();
            }
        }, 1200);
    } catch (error) {
        console.error("YouTube Clip Recorder: Error stopping recording.", error);
        resetRuntimeUiFlags();
        showRecorderInlineError(`Stop failed: ${error.message || 'Unknown error.'}`);
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
        recordButton = existingButton;
        recordingStatusChip = document.getElementById('yt-clip-recorder-status');
        recordingStatusText = recordingStatusChip?.querySelector('.yt-clip-recorder-status-text') || null;
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

    ensureRecordingStatusChip();
    const anchor = getControlsInsertAnchor(controlsRight);
    safeInsertIntoControls(controlsRight, button, anchor);

    console.log('YouTube Clip Recorder: Record controls injected.');
    return button;
}

async function handleRecordButtonClick() {
    if (!recordButton || isTransitioning) return;

    const videoElement = document.querySelector('video.html5-main-video');
    if (!videoElement) {
        console.error("YouTube Clip Recorder: Video element not found.");
        resetRuntimeUiFlags();
        showRecorderInlineError("Could not find the YouTube video element.");
        return;
    }

    if (!isRecording) {
        isTransitioning = true;
        setButtonState({ text: 'Starting...', color: '', disabled: true, title: 'Starting recording' });
        setRecorderStatus(RECORDING_STATE_STARTING, 'Starting...');

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
                const responseError = extractErrorDetails(response);
                if (
                    response?.fallbackSuggested
                    || shouldUseLocalCaptureFallback(responseError.message)
                    || shouldUseLocalCaptureFallbackForCode(responseError.code)
                ) {
                    console.info('YouTube Clip Recorder: Falling back to local capture mode.');
                    await startLocalRecording({ title: videoTitle, timestamp, includeAudio });
                    return;
                }
                const runtimeError = new Error(responseError.message || "Failed to start recording.");
                runtimeError.code = responseError.code || null;
                throw runtimeError;
            }

            console.log("YouTube Clip Recorder: Start recording message sent.");
            activeRecordingMode = BACKGROUND_RECORDING_MODE;
            await applyRecordingState();
        } catch (error) {
            const details = extractErrorDetails(error);
            const message = details.message;
            if (
                isExtensionContextInvalidatedError(error)
                || shouldUseLocalCaptureFallback(message)
                || shouldUseLocalCaptureFallbackForCode(details.code)
            ) {
                try {
                    console.info('YouTube Clip Recorder: Runtime unavailable, using local capture fallback.');
                    await startLocalRecording({ title: videoTitle, timestamp, includeAudio });
                    return;
                } catch (fallbackError) {
                    const fallbackDetails = extractErrorDetails(fallbackError);
                    const fallbackMessage = fallbackDetails.message;
                    if (isCapturePermissionDeniedMessage(fallbackMessage)) {
                        console.info('YouTube Clip Recorder: Capture selection was cancelled by user.');
                        resetRuntimeUiFlags();
                        showRecorderInlineError('Capture request was cancelled.');
                        return;
                    }
                    console.error("YouTube Clip Recorder: Local fallback start failed.", fallbackError);
                    resetRuntimeUiFlags();
                    showRecorderInlineError(`Start failed: ${toUserErrorMessage(fallbackDetails)}`);
                    return;
                }
            }

            console.error("YouTube Clip Recorder: Error starting recording.", error);
            resetRuntimeUiFlags();
            showRecorderInlineError(`Start failed: ${toUserErrorMessage(details)}`);
        }
    } else {
        await requestStopRecording();
    }
}

function showPreviewModal({ clipId, url, filename, blob }) {
    discardPreviewLocally();
    pauseUnderlyingPlayerForPreview();
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
            <div class="yt-clip-preview-discard-confirm" hidden>
                <p>Discard this clip permanently?</p>
                <div class="yt-clip-preview-discard-actions">
                    <button class="yt-clip-btn yt-clip-discard-confirm-yes">Discard</button>
                    <button class="yt-clip-btn yt-clip-discard-confirm-cancel">Cancel</button>
                </div>
            </div>
            <div class="yt-clip-preview-actions">
                <button class="yt-clip-btn yt-clip-replay">Replay</button>
                <button class="yt-clip-btn yt-clip-retry-preview" hidden>Retry Preview</button>
                <button class="yt-clip-btn yt-clip-save">Save</button>
                <button class="yt-clip-btn yt-clip-save-as">Save As...</button>
                <button class="yt-clip-btn yt-clip-discard">Discard</button>
            </div>
        </div>
    `;

    const modalEl = overlay.querySelector('.yt-clip-preview-modal');
    const statusEl = overlay.querySelector('.yt-clip-preview-status');
    const downloadAudioCheckbox = overlay.querySelector('.yt-clip-download-audio-checkbox');
    const exportOptionsContainer = document.createElement('div');
    exportOptionsContainer.className = 'yt-clip-export-options';
    exportOptionsContainer.innerHTML = `
        <label class="yt-clip-export-field">
            <span>Quality</span>
            <select class="yt-clip-export-quality"></select>
        </label>
        <label class="yt-clip-export-field">
            <span>Frame rate</span>
            <select class="yt-clip-export-fps"></select>
        </label>
    `;
    const exportQualitySelect = exportOptionsContainer.querySelector('.yt-clip-export-quality');
    const exportFpsSelect = exportOptionsContainer.querySelector('.yt-clip-export-fps');
    const minimizeButton = overlay.querySelector('.yt-clip-preview-minimize');
    const closeButton = overlay.querySelector('.yt-clip-preview-close');
    const saveButton = overlay.querySelector('.yt-clip-save');
    const saveAsButton = overlay.querySelector('.yt-clip-save-as');
    const discardButton = overlay.querySelector('.yt-clip-discard');
    const replayButton = overlay.querySelector('.yt-clip-replay');
    const retryPreviewButton = overlay.querySelector('.yt-clip-retry-preview');
    const discardConfirmContainer = overlay.querySelector('.yt-clip-preview-discard-confirm');
    const discardConfirmYesButton = overlay.querySelector('.yt-clip-discard-confirm-yes');
    const discardConfirmCancelButton = overlay.querySelector('.yt-clip-discard-confirm-cancel');
    const actionButtons = [
        saveButton,
        saveAsButton,
        discardButton,
        replayButton,
        retryPreviewButton,
        discardConfirmYesButton,
        discardConfirmCancelButton,
    ].filter(Boolean);
    let isBusy = false;

    const qualityOptions = getPlayerQualityOptions();
    exportQualitySelect.innerHTML = qualityOptions
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join('');
    exportFpsSelect.innerHTML = EXPORT_FPS_OPTIONS
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join('');

    const filenameElement = overlay.querySelector('.yt-clip-preview-filename');
    filenameElement?.insertAdjacentElement('afterend', exportOptionsContainer);

    const setPreviewStatus = (statusText = '', type = 'info') => {
        if (!statusEl) return;
        statusEl.textContent = statusText;
        statusEl.classList.remove(
            'yt-clip-preview-status-info',
            'yt-clip-preview-status-warning',
            'yt-clip-preview-status-error',
            'yt-clip-preview-status-success'
        );
        if (!statusText) {
            return;
        }
        statusEl.classList.add(`yt-clip-preview-status-${type}`);
    };

    const setPreviewBusy = (busy, statusText = '', statusType = 'info') => {
        isBusy = busy;
        actionButtons.forEach((button) => {
            button.disabled = busy;
        });
        if (downloadAudioCheckbox) {
            downloadAudioCheckbox.disabled = busy;
        }
        if (exportQualitySelect) {
            exportQualitySelect.disabled = busy;
        }
        if (exportFpsSelect) {
            exportFpsSelect.disabled = busy;
        }
        if (typeof statusText === 'string') {
            setPreviewStatus(statusText, statusType);
        } else if (busy) {
            setPreviewStatus('Working...', 'info');
        }
    };

    const setDiscardConfirmationVisible = (visible) => {
        if (!discardConfirmContainer) {
            return;
        }
        discardConfirmContainer.hidden = !visible;
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

    const minimizePreviewUi = () => {
        setDiscardConfirmationVisible(false);
        setMinimized(true);
        setPreviewStatus('Preview minimized. Use + to reopen.', 'info');
    };

    const onDiscard = async () => {
        if (isBusy || !activePreviewClipId) return;
        const currentClipId = activePreviewClipId;
        setPreviewBusy(true, 'Discarding preview...', 'warning');
        setDiscardConfirmationVisible(false);

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
                const error = new Error(response.message || 'Failed to discard clip.');
                error.code = response.code || null;
                throw error;
            }
            discardPreviewLocally();
        } catch (error) {
            console.error('YouTube Clip Recorder: Failed to discard clip.', error);
            setPreviewBusy(false);
            setPreviewStatus(`Discard failed: ${toUserErrorMessage(extractErrorDetails(error))}`, 'error');
        }
    };

    minimizeButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const currentlyMinimized = overlay.classList.contains('yt-clip-preview-overlay-minimized');
        if (currentlyMinimized) {
            setMinimized(false);
            if (!isBusy) {
                setPreviewStatus('', 'info');
            }
            return;
        }
        minimizePreviewUi();
    });

    closeButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        minimizePreviewUi();
    });

    const handleSave = async (saveAs) => {
        if (isBusy || !activePreviewClipId) return;
        const currentClipId = activePreviewClipId;
        const withAudio = downloadAudioCheckbox ? downloadAudioCheckbox.checked : true;
        const selectedQuality = exportQualitySelect ? exportQualitySelect.value : 'source';
        const selectedFps = exportFpsSelect ? exportFpsSelect.value : 'source';
        const needsTranscode = !withAudio || selectedQuality !== 'source' || selectedFps !== 'source';
        setDiscardConfirmationVisible(false);

        if (!needsTranscode && withAudio) {
            setPreviewBusy(true, saveAs ? 'Preparing Save As download...' : 'Preparing download...', 'info');
            try {
                if (saveAs) {
                    const sourceBlob = await getClipBlobForExport(currentClipId);
                    await saveBlobWithSystemPicker({
                        blob: sourceBlob,
                        filename,
                    });

                    if (isLocalClipId(currentClipId)) {
                        setPreviewBusy(false);
                        setPreviewStatus('Export saved. You can save another version or discard when done.', 'success');
                        return;
                    }

                    setPreviewBusy(false);
                    setPreviewStatus('Export saved. You can save another version or discard when done.', 'success');
                    return;
                }

                if (isLocalClipId(currentClipId)) {
                    await saveLocalClip(currentClipId, saveAs);
                    setPreviewBusy(false);
                    setPreviewStatus('Export saved. You can save another version or discard when done.', 'success');
                    return;
                }

                const response = await sendRuntimeMessage({
                    action: "saveClip",
                    payload: { clipId: currentClipId, saveAs },
                }, { recoverOnInvalidation: false });
                if (!response?.success) {
                    const error = new Error(response?.message || 'Failed to start download.');
                    error.code = response?.code || DOWNLOAD_FAILED_ERROR_CODE;
                    throw error;
                }
                setPreviewBusy(false);
                setPreviewStatus('Export started. You can save another version or discard when done.', 'success');
            } catch (error) {
                const details = extractErrorDetails(error);
                if (details.code === DOWNLOAD_CANCELLED_ERROR_CODE) {
                    console.info('YouTube Clip Recorder: Save action cancelled by user.');
                    setPreviewBusy(false);
                    setPreviewStatus(toUserErrorMessage(details), 'warning');
                    return;
                }
                console.error('YouTube Clip Recorder: Failed to save clip.', error);
                setPreviewBusy(false);
                setPreviewStatus(`Download failed: ${toUserErrorMessage(details)}`, 'error');
            }
            return;
        }

        setPreviewBusy(true, saveAs ? 'Preparing exported clip...' : 'Preparing exported download...', 'info');
        try {
            const sourceBlob = await getClipBlobForExport(currentClipId);
            const exportResult = await createExportBlobFromSource(sourceBlob, {
                includeAudio: withAudio,
                quality: selectedQuality,
                fps: selectedFps,
            });
            const exportFilename = buildExportFilename(
                filename,
                selectedQuality,
                selectedFps,
                withAudio,
                exportResult.extension
            );

            if (saveAs) {
                await saveBlobWithSystemPicker({
                    blob: exportResult.blob,
                    filename: exportFilename,
                });
            } else {
                triggerLocalBlobDownload({
                    blob: exportResult.blob,
                    filename: exportFilename,
                });
            }

            setPreviewBusy(false);
            setPreviewStatus('Export ready. You can save more versions or discard when done.', 'success');
        } catch (error) {
            const details = extractErrorDetails(error);
            if (details.code === DOWNLOAD_CANCELLED_ERROR_CODE) {
                console.info('YouTube Clip Recorder: Save action cancelled by user.');
                setPreviewBusy(false);
                setPreviewStatus(toUserErrorMessage(details), 'warning');
                return;
            }
            console.error('YouTube Clip Recorder: Failed to export clip.', error);
            setPreviewBusy(false);
            setPreviewStatus(`Export failed: ${toUserErrorMessage(details)}`, 'error');
        }
    };

    saveButton?.addEventListener('click', async () => {
        await handleSave(false);
    });

    saveAsButton?.addEventListener('click', async () => {
        await handleSave(true);
    });

    discardButton?.addEventListener('click', () => {
        if (isBusy) return;
        const isMinimized = overlay.classList.contains('yt-clip-preview-overlay-minimized');
        if (isMinimized) {
            const shouldDiscardNow = window.confirm('Discard this clip permanently?');
            if (shouldDiscardNow) {
                onDiscard().catch((error) => {
                    console.error('YouTube Clip Recorder: Failed to discard from minimized preview.', error);
                });
            }
            return;
        }
        setDiscardConfirmationVisible(true);
        setPreviewStatus('Confirm discard to permanently delete this clip.', 'warning');
    });

    discardConfirmYesButton?.addEventListener('click', onDiscard);
    discardConfirmCancelButton?.addEventListener('click', () => {
        if (isBusy) return;
        setDiscardConfirmationVisible(false);
        setPreviewStatus('', 'info');
    });

    replayButton?.addEventListener('click', async () => {
        const previewVideo = overlay.querySelector('video');
        if (!previewVideo || isBusy) return;
        try {
            previewVideo.pause();
            previewVideo.currentTime = 0;
            await previewVideo.play();
        } catch (error) {
            setPreviewStatus('Replay failed. Try Retry Preview.', 'warning');
        }
    });

    retryPreviewButton?.addEventListener('click', async () => {
        const previewVideo = overlay.querySelector('video');
        if (!previewVideo || isBusy || isLocalClipId(clipId)) {
            return;
        }
        setPreviewBusy(true, 'Retrying preview...', 'info');
        const recovered = await hydrateBackgroundPreviewSource(clipId, previewVideo);
        setPreviewBusy(false);
        if (recovered) {
            retryPreviewButton.hidden = true;
            setPreviewStatus('', 'info');
            return;
        }
        setPreviewStatus(toUserErrorMessage({ code: PREVIEW_LOAD_FAILED_ERROR_CODE }), 'error');
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay && !overlay.classList.contains('yt-clip-preview-overlay-minimized')) {
            minimizePreviewUi();
        }
    });

    const previewVideo = overlay.querySelector('video');
    if (previewVideo) {
        let initialPositionApplied = false;
        const applyInitialPreviewPosition = () => {
            if (initialPositionApplied || isBusy) {
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

            setTimeout(() => {
                if (!Number.isFinite(previewVideo.duration) || previewVideo.duration <= 0) {
                    return;
                }
                if (previewVideo.currentTime >= Math.max(previewVideo.duration * 0.9, previewVideo.duration - 0.5)) {
                    try {
                        previewVideo.currentTime = 0;
                    } catch (_) {
                        // no-op
                    }
                }
            }, 150);

            setPreviewStatus('', 'info');
        };

        previewVideo.addEventListener('loadedmetadata', applyInitialPreviewPosition);
        previewVideo.addEventListener('loadeddata', applyInitialPreviewPosition);

        let recoveryAttempted = false;
        previewVideo.addEventListener('error', async () => {
            if (isLocalClipId(clipId)) {
                setPreviewStatus(toUserErrorMessage({ code: PREVIEW_LOAD_FAILED_ERROR_CODE }), 'error');
                if (retryPreviewButton) {
                    retryPreviewButton.hidden = false;
                }
                return;
            }

            if (!recoveryAttempted) {
                recoveryAttempted = true;
                initialPositionApplied = false;
                const recovered = await hydrateBackgroundPreviewSource(clipId, previewVideo);
                if (recovered) {
                    if (retryPreviewButton) {
                        retryPreviewButton.hidden = true;
                    }
                    return;
                }
            }

            setPreviewStatus(toUserErrorMessage({ code: PREVIEW_LOAD_FAILED_ERROR_CODE }), 'error');
            if (retryPreviewButton) {
                retryPreviewButton.hidden = false;
            }
            console.warn('YouTube Clip Recorder: Preview player failed to load clip source.');
        });

        if (!isLocalClipId(clipId) && (!blob || typeof blob.size !== 'number')) {
            setPreviewBusy(true, 'Loading preview...', 'info');
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

function hasUnsavedMinimizedPreview() {
    return Boolean(
        activePreviewClipId
        && previewModalEl
        && previewModalEl.classList.contains('yt-clip-preview-overlay-minimized')
    );
}

function handleUnsavedPreviewBeforeUnload(event) {
    if (!hasUnsavedMinimizedPreview()) {
        return undefined;
    }

    event.preventDefault();
    event.returnValue = PREVIEW_UNSAVED_GUARD_MESSAGE;
    return PREVIEW_UNSAVED_GUARD_MESSAGE;
}

if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
        if (!message) return;

        if (message.action === 'clipReadyForPreview') {
            showPreviewModal(message.payload);
            return;
        }

        if (message.type === RECORDING_STARTED_EVENT) {
            if (!isRecording) {
                activeRecordingMode = BACKGROUND_RECORDING_MODE;
                applyRecordingState();
            }
        } else if (message.type === RECORDING_STOPPED_EVENT) {
            const stopReason = message.payload?.reason || '';
            if (
                stopReason === RECORDING_STOP_REASON_RECORDER_ERROR
                || stopReason === RECORDING_STOP_REASON_START_FAILED
                || stopReason === RECORDING_STOP_REASON_FINALIZE_FAILED
            ) {
                return;
            }
            resetUIState();
        } else if (message.type === RECORDING_ERROR_EVENT) {
            const details = extractErrorDetails(message.payload || {});
            console.error('YouTube Clip Recorder: Background recording error.', details.message);
            resetRuntimeUiFlags();
            showRecorderInlineError(toUserErrorMessage(details));
        }
    });
}

window.addEventListener('beforeunload', handleUnsavedPreviewBeforeUnload);
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
    const hasStatusChip = Boolean(document.getElementById('yt-clip-recorder-status'));
    const hasControls = Boolean(document.querySelector('.ytp-right-controls'));
    if ((!hasButton || !hasStatusChip) && hasControls) {
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
    const existingStatusChip = document.getElementById('yt-clip-recorder-status');
    if (existingButton) {
        existingButton.remove();
        recordButton = null;
    }
    if (existingStatusChip) {
        existingStatusChip.remove();
        recordingStatusChip = null;
        recordingStatusText = null;
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

async function getMaxRecordDurationMs() {
    const savedSettings = await getSavedRecorderSettings();
    if (savedSettings?.maxRecordDurationSeconds) {
        return clampDurationSeconds(savedSettings.maxRecordDurationSeconds) * 1000;
    }

    try {
        if (
            typeof chrome === 'undefined'
            || !chrome?.storage?.sync
            || typeof chrome.storage.sync.get !== 'function'
        ) {
            return DEFAULT_MAX_RECORD_DURATION_MS;
        }

        const settings = await chrome.storage.sync.get(STORAGE_KEY_MAX_DURATION_SECONDS);
        const seconds = clampDurationSeconds(settings?.[STORAGE_KEY_MAX_DURATION_SECONDS]);
        return seconds * 1000;
    } catch (error) {
        return DEFAULT_MAX_RECORD_DURATION_MS;
    }
}

bootstrap();
