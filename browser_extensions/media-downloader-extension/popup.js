/**
 * Popup script - handles UI interactions and communicates with background service worker
 *
 * VIDEO MODE:
 * Only shows "actionable" videos that have been confirmed by a play event
 * and validated via header probe. Uses the state machine in background.js.
 * Candidates (unconfirmed) can optionally be shown in a separate section
 * with actions disabled until the user plays them on the page.
 */

// Elements
const downloadSelectedBtn = document.getElementById('download-selected');
const closeTabsToggle = document.getElementById('close-tabs');
const skipDuplicatesToggle = document.getElementById('skip-duplicates');
const intervalInput = document.getElementById('interval');
const intervalUpBtn = document.getElementById('interval-up');
const intervalDownBtn = document.getElementById('interval-down');
const prefixInput = document.getElementById('prefix');
const prefixWrapper = document.getElementById('prefix-wrapper');
const actionArea = document.getElementById('action-area');
const headerEl = document.querySelector('.header');
const statusEl = document.getElementById('status');
const tabCountEl = document.getElementById('tab-count');
const tabPluralEl = document.getElementById('tab-plural');
const progressEl = document.getElementById('progress');
const progressFillEl = document.getElementById('progress-fill');
const progressTextEl = document.getElementById('progress-text');
const progressDupesEl = document.getElementById('progress-dupes');
const pauseBtn = document.getElementById('pause-btn');
const cancelBtn = document.getElementById('cancel-btn');

// Update floating label state for prefix input
function updatePrefixLabelState() {
    if (prefixInput.value.trim()) {
        prefixWrapper.classList.add('has-value');
    } else {
        prefixWrapper.classList.remove('has-value');
    }
}

// State
let isPaused = false;
let pollInterval = null;
let currentMediaMode = 'images';
let detectedVideos = [];
let candidateVideos = [];
let selectedVideoUrls = new Set();
let currentPreviewBlobUrl = null;

// =============================================================================
// DETACHED / PERSISTENT WINDOW MODE (early init - must run before tab queries)
// =============================================================================

let isDetached = false;
let detachedSourceWindowId = null;
let detachedTabIds = [];

(function detectDetachedMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('detached') === '1') {
        isDetached = true;
        document.body.classList.add('is-detached');
        detachedSourceWindowId = parseInt(params.get('sourceWindowId')) || null;
        const tabIdsStr = params.get('tabIds') || '';
        detachedTabIds = tabIdsStr ? tabIdsStr.split(',').map(Number).filter(n => !isNaN(n)) : [];
    }
})();

/**
 * Get the tabs to operate on.
 * In normal popup mode: queries highlighted tabs in the current window.
 * In detached mode: queries highlighted tabs from the source browser window,
 * falling back to the tab IDs captured at detach time.
 */
async function getTargetTabs() {
    if (isDetached && detachedSourceWindowId) {
        try {
            const tabs = await chrome.tabs.query({
                highlighted: true,
                windowId: detachedSourceWindowId
            });
            if (tabs.length > 0) return tabs;
        } catch (e) {
            // Source window may have been closed
        }

        // Fall back to the tab IDs captured at detach time
        if (detachedTabIds.length > 0) {
            try {
                const tabs = await Promise.all(
                    detachedTabIds.map(id => chrome.tabs.get(id).catch(() => null))
                );
                return tabs.filter(Boolean);
            } catch (e) {
                // tabs no longer exist
            }
        }

        return [];
    }

    return chrome.tabs.query({ highlighted: true, currentWindow: true });
}

// Video modal elements
const videoModal = document.getElementById('video-modal');
const modalClose = document.getElementById('modal-close');
const modalDownload = document.getElementById('modal-download');
const videoList = document.getElementById('video-list');
const selectionInfo = document.getElementById('selection-info');
const videoPlayer = document.getElementById('video-player');
const playerVideo = document.getElementById('player-video');
const mediaTypeBtns = document.querySelectorAll('.media-type__btn');

// Load saved settings
async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(['closeTabs', 'skipDuplicates', 'interval', 'prefix']);

        if (result.closeTabs !== undefined) {
            closeTabsToggle.checked = result.closeTabs;
        }
        if (result.skipDuplicates !== undefined) {
            skipDuplicatesToggle.checked = result.skipDuplicates;
        }
        if (result.interval !== undefined) {
            // Convert ms to seconds for display
            intervalInput.value = (result.interval / 1000).toFixed(1);
        }
        if (result.prefix !== undefined) {
            prefixInput.value = result.prefix;
            updatePrefixLabelState();
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Get interval in milliseconds from the seconds input
function getIntervalMs() {
    const seconds = parseFloat(intervalInput.value) || 0.5;
    return Math.max(100, Math.round(seconds * 1000));
}

// Save settings when changed
async function saveSettings() {
    try {
        await chrome.storage.local.set({
            closeTabs: closeTabsToggle.checked,
            skipDuplicates: skipDuplicatesToggle.checked,
            interval: getIntervalMs(),
            prefix: prefixInput.value.trim()
        });
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

// Update selected tab count
async function updateTabCount() {
    try {
        const tabs = await getTargetTabs();
        const count = tabs.length;
        tabCountEl.textContent = count;
        tabPluralEl.textContent = count === 1 ? '' : 's';
    } catch (error) {
        console.error('Error getting tab count:', error);
        tabCountEl.textContent = '?';
        tabPluralEl.textContent = 's';
    }
}

// Show status message
function showStatus(message, type = '') {
    statusEl.textContent = message;
    statusEl.className = 'status' + (type ? ' status--' + type : '');
    statusEl.style.display = 'flex';
}

// Show/hide progress UI (crossfade between button and progress)
function showProgress(show) {
    actionArea.classList.toggle('action-area--active', show);
    headerEl.classList.toggle('header--hidden', show);
    statusEl.style.display = show ? 'none' : 'flex';
}

// Update progress display
function updateProgress(processed, total, isPaused, duplicates = 0) {
    const percent = total > 0 ? (processed / total) * 100 : 0;
    progressFillEl.style.width = percent + '%';
    progressTextEl.textContent = `${processed} / ${total}${isPaused ? ' (paused)' : ''}`;
    progressDupesEl.textContent = duplicates > 0 ? `${duplicates} dupe${duplicates === 1 ? '' : 's'}` : '';
    pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
}

// Poll for download status
async function pollStatus() {
    try {
        const status = await chrome.runtime.sendMessage({ action: 'get-status' });

        if (status.isRunning) {
            updateProgress(status.processed, status.total, status.isPaused, status.duplicates);
            isPaused = status.isPaused;
        } else {
            // Download finished or was never running
            stopPolling();
            showProgress(false);
            await updateTabCount();
        }
    } catch (error) {
        console.error('Error polling status:', error);
    }
}

function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(pollStatus, 200);
}

function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

// Download from selected tabs
async function downloadSelected() {
    // For video mode, show the video list modal
    if (currentMediaMode === 'videos') {
        await showVideoModal();
        return;
    }

    // Image mode - download from selected tabs (original core functionality)
    isPaused = false;

    // Get tab count for progress
    const tabs = await getTargetTabs();
    if (tabs.length === 0) {
        showStatus('No tabs selected', 'error');
        showProgress(true); // Show the error in progress area
        return;
    }

    // Show progress UI
    showProgress(true);
    updateProgress(0, tabs.length, false);
    startPolling();

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'download-selected-tabs',
            options: {
                closeTabs: closeTabsToggle.checked,
                skipDuplicates: skipDuplicatesToggle.checked,
                interval: getIntervalMs(),
                prefix: prefixInput.value.trim()
            }
        });

        stopPolling();

        if (response.error) {
            showStatus(response.error, 'error');
        } else {
            const { success, skipped, duplicates, cancelled } = response;
            let msg = `${success} downloaded`;
            if (duplicates > 0) msg += `, ${duplicates} dupes`;
            if (skipped - duplicates > 0) msg += `, ${skipped - duplicates} failed`;
            if (cancelled) msg += ' (cancelled)';
            showStatus(msg, success > 0 ? 'success' : '');
        }

        showProgress(false);
        await updateTabCount();

    } catch (error) {
        stopPolling();
        showStatus('Error: ' + error.message, 'error');
        showProgress(false);
    }
}

// Pause/Resume toggle
async function togglePause() {
    try {
        if (isPaused) {
            await chrome.runtime.sendMessage({ action: 'resume' });
            isPaused = false;
        } else {
            await chrome.runtime.sendMessage({ action: 'pause' });
            isPaused = true;
        }
        pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    } catch (error) {
        console.error('Error toggling pause:', error);
    }
}

// Cancel download
async function cancelDownload() {
    try {
        await chrome.runtime.sendMessage({ action: 'cancel' });
        stopPolling();
        showStatus('Cancelled', '');
        showProgress(false);
        await updateTabCount();
    } catch (error) {
        console.error('Error cancelling:', error);
    }
}

// Interval button handlers (values in seconds)
function incrementInterval() {
    const current = parseFloat(intervalInput.value) || 0.5;
    const step = parseFloat(intervalInput.step) || 0.1;
    const max = parseFloat(intervalInput.max) || 10;
    intervalInput.value = Math.min(current + step, max).toFixed(1);
    saveSettings();
}

function decrementInterval() {
    const current = parseFloat(intervalInput.value) || 0.5;
    const step = parseFloat(intervalInput.step) || 0.1;
    const min = parseFloat(intervalInput.min) || 0.1;
    intervalInput.value = Math.max(current - step, min).toFixed(1);
    saveSettings();
}

// Check if download is already running on popup open
async function checkRunningDownload() {
    try {
        const status = await chrome.runtime.sendMessage({ action: 'get-status' });
        if (status.isRunning) {
            showProgress(true);
            updateProgress(status.processed, status.total, status.isPaused, status.duplicates);
            isPaused = status.isPaused;
            startPolling();
        }
    } catch (error) {
        console.error('Error checking status:', error);
    }
}

// Event listeners
downloadSelectedBtn.addEventListener('click', downloadSelected);
pauseBtn.addEventListener('click', togglePause);
cancelBtn.addEventListener('click', cancelDownload);
closeTabsToggle.addEventListener('change', saveSettings);
skipDuplicatesToggle.addEventListener('change', () => {
    saveSettings();
    // Re-render image grid if modal is open (to show/hide dupes)
    if (imageModal.classList.contains('active') && detectedImages.length > 0) {
        renderImageList();
    }
});
intervalInput.addEventListener('change', saveSettings);
intervalUpBtn.addEventListener('click', incrementInterval);
intervalDownBtn.addEventListener('click', decrementInterval);
prefixInput.addEventListener('change', saveSettings);
prefixInput.addEventListener('input', updatePrefixLabelState);

// Initialize
loadSettings();
updateTabCount();
checkRunningDownload();

// =============================================================================
// VIDEO MODE - Play-gated detection with state machine
// =============================================================================

// Media type selector
mediaTypeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        mediaTypeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMediaMode = btn.dataset.mode;
        updateButtonText();
    });
});

function updateButtonText() {
    const btnText = downloadSelectedBtn.querySelector('.btn__text');
    const pickerBtn = document.getElementById('image-picker-btn');

    if (currentMediaMode === 'videos') {
        btnText.innerHTML = 'List videos';
        // Hide image picker in video mode
        if (pickerBtn) pickerBtn.style.display = 'none';
    } else {
        btnText.innerHTML = `<span id="tab-count">${tabCountEl.textContent}</span> file<span id="tab-plural">${tabPluralEl.textContent}</span>`;
        // Show image picker in image mode
        if (pickerBtn) pickerBtn.style.display = 'flex';
    }
}

// Show video modal and scan for videos
async function showVideoModal() {
    videoModal.classList.add('active');
    videoList.innerHTML = '<div class="modal__empty">Scanning for videos...</div>';
    detectedVideos = [];
    candidateVideos = [];
    selectedVideoUrls.clear();
    updateSelectionInfo();
    hidePlayer();

    try {
        const tabs = await getTargetTabs();
        const tabIds = tabs.map(t => t.id);

        // Request videos with candidates included for display
        const response = await chrome.runtime.sendMessage({
            action: 'scan-videos',
            tabIds: tabIds,
            includeUnconfirmed: true  // Get candidates for the "unconfirmed" section
        });

        detectedVideos = response.videos || [];      // Actionable only
        candidateVideos = response.candidates || []; // Unconfirmed candidates

        renderVideoList();

    } catch (error) {
        videoList.innerHTML = `<div class="modal__empty">Error: ${error.message}</div>`;
    }
}

function hideModal() {
    videoModal.classList.remove('active');
    hidePlayer();
    cleanupPreviewBlob();
}

function renderVideoList() {
    const hasActionable = detectedVideos.length > 0;
    const hasCandidates = candidateVideos.length > 0;

    if (!hasActionable && !hasCandidates) {
        videoList.innerHTML = `
            <div class="modal__empty">
                <p>No videos detected yet.</p>
                <p class="hint">Play a video on the page, then click "List videos" again.</p>
            </div>`;
        return;
    }

    let html = '';

    // Actionable videos section
    if (hasActionable) {
        if (hasCandidates) {
            html += `<div class="section-label">Ready to Download (${detectedVideos.length})</div>`;
        }

        html += '<div class="video-grid">';
        html += detectedVideos.map((video, idx) => {
            return renderVideoCard(video, idx, true);
        }).join('');
        html += '</div>';
    }

    // Candidates section (unconfirmed)
    if (hasCandidates) {
        html += `
            <div class="section-label candidates-label">
                Unconfirmed (${candidateVideos.length})
                <span class="hint">Click play on page to confirm</span>
            </div>`;

        html += '<div class="video-grid candidates-grid">';
        html += candidateVideos.map((video, idx) => {
            return renderVideoCard(video, detectedVideos.length + idx, false);
        }).join('');
        html += '</div>';
    }

    videoList.innerHTML = html;
    updateSelectionInfo();
}

function renderVideoCard(video, index, isActionable) {
    const isSelected = selectedVideoUrls.has(video.url);
    const source = video.source || 'unknown';
    const isStream = video.isStream;

    // Status badge based on state
    let originClass, originLabel, tooltip;
    if (isStream) {
        originClass = 'origin-stream';
        originLabel = 'HLS';
        tooltip = 'Streaming video';
    } else if (video.state === 'actionable') {
        originClass = 'origin-ready';
        originLabel = '✓';
        tooltip = 'Ready to download';
    } else if (video.state === 'failed') {
        originClass = 'origin-failed';
        originLabel = '✗';
        tooltip = video.failureReason || 'Validation failed';
    } else if (video.state === 'candidate') {
        originClass = 'origin-candidate';
        originLabel = '?';
        tooltip = 'Unconfirmed - play on page to detect';
    } else {
        originClass = 'origin-net';
        originLabel = 'NET';
        tooltip = 'Network capture';
    }

    // Failure message for failed videos
    const failureHtml = video.failureReason
        ? `<div class="video-card__failure">${escapeHtml(video.failureReason)}</div>`
        : '';

    return `
        <div class="video-card ${isSelected ? 'selected' : ''} ${isStream ? 'is-stream' : ''} ${!isActionable ? 'is-candidate' : ''}"
             data-index="${index}"
             data-url="${escapeHtml(video.url)}"
             ${isStream ? 'data-stream="true"' : ''}>
            <div class="video-card__checkbox ${!isActionable ? 'disabled' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            </div>
            <div class="video-card__info">
                <div class="video-card__source">
                    ${escapeHtml(source)}
                    <span class="video-card__origin ${originClass}" title="${tooltip}">${originLabel}</span>
                </div>
                <div class="video-card__meta">
                    ${video.duration ? formatDuration(video.duration) : ''}
                    ${video.filesize ? formatFilesize(video.filesize) : ''}
                    ${video.dimensions || ''}
                    ${isStream ? '<span class="stream-note">Stream</span>' : ''}
                </div>
                ${failureHtml}
            </div>
            <button class="video-card__play ${!isActionable ? 'disabled' : ''}"
                    data-play="${index}"
                    title="${isActionable ? 'Preview' : 'Play on page first'}"
                    ${!isActionable ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                </svg>
            </button>
        </div>
    `;
}

function updateSelectionInfo() {
    const count = selectedVideoUrls.size;
    selectionInfo.textContent = count > 0 ? `${count} selected` : 'Select videos to download';
    modalDownload.disabled = count === 0;
}

function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFilesize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Preview using blob snippet from background
async function showPlayer(video) {
    if (!videoPlayer || !playerVideo) return;

    // Show loading state
    videoPlayer.classList.add('active');
    playerVideo.src = '';
    playerVideo.poster = '';

    const loadingEl = document.createElement('div');
    loadingEl.className = 'player-loading';
    loadingEl.textContent = 'Loading preview...';
    videoPlayer.appendChild(loadingEl);

    try {
        // Fetch preview snippet from background
        // Pass the video's tabId so the background can use the correct page context
        const result = await chrome.runtime.sendMessage({
            action: 'fetch-preview-snippet',
            url: video.url,
            tabId: video.tabId,  // Use video's original tab for proper auth context
            maxBytes: 2 * 1024 * 1024  // 2 MB preview snippet
        });

        // Remove loading indicator
        loadingEl.remove();

        if (result.error) {
            const errorEl = document.createElement('div');
            errorEl.className = 'player-error';
            errorEl.textContent = result.error;
            videoPlayer.appendChild(errorEl);
            return;
        }

        let blobUrl;

        // Handle base64 response from page context or buffer from service worker
        if (result.base64) {
            const binary = atob(result.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: result.contentType || 'video/mp4' });
            blobUrl = URL.createObjectURL(blob);
        } else if (result.buffer) {
            const buffer = new Uint8Array(result.buffer);
            const blob = new Blob([buffer], { type: result.contentType || 'video/mp4' });
            blobUrl = URL.createObjectURL(blob);
        } else {
            throw new Error('No preview data received');
        }

        // Cleanup previous blob URL
        cleanupPreviewBlob();
        currentPreviewBlobUrl = blobUrl;

        // Set video source and play
        playerVideo.src = blobUrl;
        playerVideo.load();
        playerVideo.play().catch((e) => {
            console.warn('Auto-play blocked:', e);
        });

    } catch (error) {
        loadingEl.remove();
        const errorEl = document.createElement('div');
        errorEl.className = 'player-error';
        errorEl.textContent = 'Preview failed: ' + error.message;
        videoPlayer.appendChild(errorEl);
    }
}

function hidePlayer() {
    if (!videoPlayer || !playerVideo) return;

    playerVideo.pause();
    playerVideo.src = '';
    videoPlayer.classList.remove('active');

    // Remove any loading/error elements
    videoPlayer.querySelectorAll('.player-loading, .player-error').forEach(el => el.remove());
}

function cleanupPreviewBlob() {
    if (currentPreviewBlobUrl) {
        URL.revokeObjectURL(currentPreviewBlobUrl);
        currentPreviewBlobUrl = null;
    }
}

// Video modal event listeners
modalClose.addEventListener('click', hideModal);

videoModal.addEventListener('click', (e) => {
    if (e.target === videoModal) hideModal();
});

videoList.addEventListener('click', (e) => {
    // Handle play button
    const playBtn = e.target.closest('.video-card__play');
    if (playBtn && !playBtn.disabled) {
        e.stopPropagation();
        const index = parseInt(playBtn.dataset.play);

        // Get video from combined list
        let video;
        if (index < detectedVideos.length) {
            video = detectedVideos[index];
        } else {
            video = candidateVideos[index - detectedVideos.length];
        }

        if (video) showPlayer(video);
        return;
    }

    // Handle card selection (only for actionable videos)
    const card = e.target.closest('.video-card');
    if (card && !card.classList.contains('is-candidate')) {
        const url = card.dataset.url;
        if (url) {
            if (selectedVideoUrls.has(url)) {
                selectedVideoUrls.delete(url);
                card.classList.remove('selected');
            } else {
                selectedVideoUrls.add(url);
                card.classList.add('selected');
            }
            updateSelectionInfo();
        }
    }
});

modalDownload.addEventListener('click', async () => {
    if (selectedVideoUrls.size === 0) return;

    // Build video info array with stream flags (only from actionable videos)
    const selectedVideos = detectedVideos.filter(v => selectedVideoUrls.has(v.url));

    hideModal();

    showProgress(true);
    updateProgress(0, selectedVideos.length, false);
    startPolling();

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'download-specific-videos',
            videos: selectedVideos,
            options: {
                interval: getIntervalMs(),
                prefix: prefixInput.value.trim()
            }
        });

        stopPolling();

        if (response.error) {
            showStatus(response.error, 'error');
        } else {
            const { success, skipped, cancelled, streams } = response;
            let msg = `${success} downloaded`;
            if (streams > 0) msg += `, ${streams} streams`;
            if (skipped > 0) msg += `, ${skipped} failed`;
            if (cancelled) msg += ' (cancelled)';
            showStatus(msg, success > 0 ? 'success' : '');
        }

        showProgress(false);

    } catch (error) {
        stopPolling();
        showStatus('Error: ' + error.message, 'error');
        showProgress(false);
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && videoModal.classList.contains('active')) {
        hideModal();
    }
});

// Cleanup on popup close
window.addEventListener('unload', () => {
    cleanupPreviewBlob();
    stopImageScanPolling();
});

// =============================================================================
// IMAGE MODE - Selection Modal
// =============================================================================

// Image modal elements
const imageModal = document.getElementById('image-modal');
const imageModalClose = document.getElementById('image-modal-close');
const imageModalDownload = document.getElementById('image-modal-download');
const imageList = document.getElementById('image-list');
const imageSelectionInfo = document.getElementById('image-selection-info');
const imageTotalCount = document.getElementById('image-total-count');
const imageSelectAll = document.getElementById('image-select-all');
const imageDeselectAll = document.getElementById('image-deselect-all');
const imageFilterBtns = document.querySelectorAll('.modal__filter-btn');
const imageSortSelect = document.getElementById('image-sort');
const imageMinSizeSlider = document.getElementById('image-min-size');
const imageMinSizeValue = document.getElementById('image-min-size-value');
const imageSelectionSize = document.getElementById('image-selection-size');
const imagePreview = document.getElementById('image-preview');
const imagePreviewImg = document.getElementById('image-preview-img');
const imagePreviewInfo = document.getElementById('image-preview-info');

let detectedImages = [];
let selectedImageUrls = new Set();
let currentImageFilter = 'all';
let currentImageSort = 'largest';
let minSizeThreshold = 0;
let keyboardFocusIndex = -1;   // Currently focused card index for arrow keys
let lastClickedIndex = -1;     // Last clicked card index for Shift+click range select
let duplicateImageUrls = new Set();
let imageScanInterval = null;
let imageScanTabIds = [];  // Tab IDs being scanned (cached for re-scans)
let knownImageUrls = new Set();  // Accumulated URLs to prevent removal
let knownNormalizedUrls = new Set();  // Normalized URLs for cross-scan dedup

/**
 * Normalize an image URL for deduplication.
 * Strips size params, dimension suffixes, CDN resize paths, cache-busters, etc.
 * Mirrors the background.js version so popup-side dedup matches.
 */
function normalizeImageUrl(url) {
    try {
        const u = new URL(url);
        // Normalize protocol
        u.protocol = 'https:';
        // Remove common size/quality query parameters
        const sizeParams = ['w', 'h', 'width', 'height', 'size', 'resize',
                            'fit', 'crop', 'quality', 'q', 'dpr', 'auto',
                            'fl', 'fm', 'format', 'maxwidth', 'maxheight',
                            's', 'sz', 'thumb', 'thumbnail'];
        for (const param of sizeParams) {
            u.searchParams.delete(param);
        }
        // Cache-busting params
        for (const p of ['v', '_', 't', 'cb', 'cache', 'ver', 'rev']) {
            u.searchParams.delete(p);
        }
        // WordPress: -150x150.jpg → .jpg
        u.pathname = u.pathname.replace(/-\d+x\d+(?=\.\w{3,4}$)/, '');
        // WordPress: -scaled.jpg → .jpg
        u.pathname = u.pathname.replace(/-scaled(?=\.\w{3,4}$)/, '');
        // Shopify / CDN: _150x150.jpg → .jpg
        u.pathname = u.pathname.replace(/_\d+x\d+(?=\.\w{3,4}$)/, '');
        // Cloudflare Image Resizing: /cdn-cgi/image/.../
        u.pathname = u.pathname.replace(/\/cdn-cgi\/image\/[^/]+\//, '/');
        // CDN resize paths: /resize/WxH/ or /fit-in/WxH/ or /thumbs/
        u.pathname = u.pathname.replace(/\/(resize|fit-in|thumb(nails?|s)?|crop)\/\d+x\d+\//, '/');
        // Sort remaining params for consistency
        u.searchParams.sort();
        u.hash = '';
        return u.href;
    } catch (e) {
        return url;
    }
}

// Show image modal and scan for images
async function showImageModal() {
    document.body.classList.add('image-modal-open');
    imageModal.classList.add('active');
    imageList.innerHTML = '<div class="modal__empty">Scanning for images...</div>';
    detectedImages = [];
    selectedImageUrls.clear();
    duplicateImageUrls.clear();
    knownImageUrls.clear();
    knownNormalizedUrls.clear();
    keyboardFocusIndex = -1;
    lastClickedIndex = -1;
    minSizeThreshold = 0;
    imageMinSizeSlider.value = 0;
    imageMinSizeValue.textContent = '0 px';
    updateImageSelectionInfo();

    try {
        const tabs = await getTargetTabs();
        imageScanTabIds = tabs.map(t => t.id);

        const response = await chrome.runtime.sendMessage({
            action: 'scan-images',
            tabIds: imageScanTabIds
        });

        detectedImages = response.images || [];

        // Track all known URLs so they persist across re-scans
        detectedImages.forEach(img => {
            knownImageUrls.add(img.url);
            knownNormalizedUrls.add(normalizeImageUrl(img.url));
        });

        // Check which images are already downloaded (dupes)
        if (detectedImages.length > 0) {
            const urls = detectedImages.map(img => img.url);
            const dupeResponse = await chrome.runtime.sendMessage({
                action: 'check-duplicate-urls',
                urls: urls
            });
            duplicateImageUrls = new Set(dupeResponse.duplicates || []);
        }

        renderImageList();

        // Start live scanning to pick up newly loaded images
        startImageScanPolling();

    } catch (error) {
        imageList.innerHTML = `<div class="modal__empty">Error: ${error.message}</div>`;
    }
}

// Live image scan polling - re-scans page periodically and merges new images
function startImageScanPolling() {
    stopImageScanPolling();
    imageScanInterval = setInterval(rescanForNewImages, 2000);
    // Show live indicator
    const liveIndicator = document.getElementById('image-live-indicator');
    if (liveIndicator) liveIndicator.classList.add('active');
}

function stopImageScanPolling() {
    if (imageScanInterval) {
        clearInterval(imageScanInterval);
        imageScanInterval = null;
    }
    const liveIndicator = document.getElementById('image-live-indicator');
    if (liveIndicator) liveIndicator.classList.remove('active');
}

async function rescanForNewImages() {
    // Don't scan if modal is closed
    if (!imageModal.classList.contains('active')) {
        stopImageScanPolling();
        return;
    }

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'scan-images',
            tabIds: imageScanTabIds
        });

        const freshImages = response.images || [];
        let newCount = 0;

        // Merge new images using normalized URL dedup
        for (const img of freshImages) {
            const normUrl = normalizeImageUrl(img.url);
            if (!knownNormalizedUrls.has(normUrl)) {
                // Genuinely new image
                knownNormalizedUrls.add(normUrl);
                knownImageUrls.add(img.url);
                detectedImages.push(img);
                newCount++;
            } else if (!knownImageUrls.has(img.url)) {
                // Same normalized URL but different raw URL — keep the larger one
                const existingIdx = detectedImages.findIndex(existing =>
                    normalizeImageUrl(existing.url) === normUrl
                );
                if (existingIdx >= 0) {
                    const existingArea = detectedImages[existingIdx].width * detectedImages[existingIdx].height;
                    const newArea = img.width * img.height;
                    if (newArea > existingArea) {
                        selectedImageUrls.delete(detectedImages[existingIdx].url);
                        knownImageUrls.delete(detectedImages[existingIdx].url);
                        knownImageUrls.add(img.url);
                        detectedImages[existingIdx] = img;
                        newCount++;
                    }
                }
            }
        }

        // If new images were found, check dupes and re-render
        if (newCount > 0) {
            // Check dupes for newly found URLs
            const newUrls = freshImages
                .filter(img => !duplicateImageUrls.has(img.url))
                .map(img => img.url);

            if (newUrls.length > 0) {
                const dupeResponse = await chrome.runtime.sendMessage({
                    action: 'check-duplicate-urls',
                    urls: newUrls
                });
                const newDupes = dupeResponse.duplicates || [];
                newDupes.forEach(url => duplicateImageUrls.add(url));
            }

            renderImageList();
        }
    } catch (error) {
        // Silently ignore scan errors during polling (extension might be reloaded)
        console.warn('Image rescan error:', error);
    }
}

function hideImageModal() {
    stopImageScanPolling();
    imageModal.classList.remove('active');
    document.body.classList.remove('image-modal-open');
}

function sortImages(images, sortMode) {
    const sorted = [...images];
    switch (sortMode) {
        case 'smallest':
            sorted.sort((a, b) => (a.width * a.height) - (b.width * b.height));
            break;
        case 'newest':
            // Preserve the order they were discovered (array insertion order)
            // detectedImages already has this order, so just reverse the size sort
            break;
        case 'largest':
        default:
            sorted.sort((a, b) => (b.width * b.height) - (a.width * a.height));
            break;
    }
    return sorted;
}

function renderImageList() {
    let filtered = filterImages(detectedImages, currentImageFilter);

    // Apply sort (skip for 'newest' which preserves discovery order)
    if (currentImageSort !== 'newest') {
        filtered = sortImages(filtered, currentImageSort);
    }

    // Reset keyboard focus on re-render
    keyboardFocusIndex = -1;
    imagePreview.classList.remove('visible');

    if (filtered.length === 0) {
        imageList.innerHTML = `<div class="modal__empty">No ${currentImageFilter === 'all' ? '' : currentImageFilter + ' '}images found</div>`;
        imageTotalCount.textContent = '0 images';
        return;
    }

    imageTotalCount.textContent = `${filtered.length} image${filtered.length !== 1 ? 's' : ''}`;

    imageList.innerHTML = filtered.map((img, idx) => {
        const isSelected = selectedImageUrls.has(img.url);
        const sizeClass = getSizeClass(img.width, img.height);
        const thumbSrc = img.thumb || img.url;

        return `
            <div class="image-card ${isSelected ? 'selected' : ''}"
                 data-url="${escapeHtml(img.url)}"
                 data-index="${idx}">
                <img class="image-card__img"
                     src="${escapeHtml(thumbSrc)}"
                     alt=""
                     loading="lazy">
                <div class="image-card__checkbox">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <polyline points="20 6 9 17 4 12"/>
                    </svg>
                </div>
                ${img.width && img.height ? `<span class="image-card__size-badge ${sizeClass}">${img.width}×${img.height}</span>` : ''}
                <div class="image-card__meta">
                    <span>${img.filesize ? formatFilesize(img.filesize) : ''}</span>
                    <span>${img.format?.toUpperCase() || 'IMG'}</span>
                </div>
            </div>
        `;
    }).join('');

    // Attach error handlers for broken images - hide broken icon gracefully
    imageList.querySelectorAll('.image-card__img').forEach(imgEl => {
        imgEl.addEventListener('error', () => {
            imgEl.style.opacity = '0';
            const card = imgEl.closest('.image-card');
            if (card) card.style.background = 'var(--ui-elevated-2)';
        });
    });

    updateImageSelectionInfo();

    // Request missing thumbnails from background (bypasses CORS)
    const missingThumbUrls = filtered
        .filter(img => !img.thumb)
        .map(img => img.url);
    if (missingThumbUrls.length > 0) {
        requestMissingThumbnails(missingThumbUrls);
    }
}

/**
 * Progressively fetch thumbnails from the background service worker
 * for images where the in-page canvas approach failed (cross-origin).
 */
async function requestMissingThumbnails(urls) {
    const batchSize = 10;
    for (let i = 0; i < urls.length; i += batchSize) {
        // Stop if modal was closed
        if (!imageModal.classList.contains('active')) return;

        const batch = urls.slice(i, i + batchSize);
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'fetch-image-thumbs',
                urls: batch
            });

            const thumbnails = response.thumbnails || {};

            // Update cached image objects
            for (const img of detectedImages) {
                if (!img.thumb && thumbnails[img.url]) {
                    img.thumb = thumbnails[img.url];
                }
            }

            // Update DOM directly (avoid full re-render)
            imageList.querySelectorAll('.image-card').forEach(card => {
                const url = card.dataset.url;
                if (url && thumbnails[url]) {
                    const imgEl = card.querySelector('.image-card__img');
                    if (imgEl) {
                        imgEl.src = thumbnails[url];
                        imgEl.style.opacity = '';
                        card.style.background = '';
                    }
                }
            });
        } catch (error) {
            console.warn('Thumbnail batch failed:', error);
        }
    }
}

function filterImages(images, filter) {
    let result = images;

    // Hide already-downloaded images when skip dupes is on
    if (skipDuplicatesToggle.checked && duplicateImageUrls.size > 0) {
        result = result.filter(img => !duplicateImageUrls.has(img.url));
    }

    // Apply min-size threshold
    if (minSizeThreshold > 0) {
        result = result.filter(img =>
            Math.max(img.width, img.height) >= minSizeThreshold
        );
    }

    if (filter === 'all') return result;
    if (filter === 'large') return result.filter(img => img.width >= 1000 || img.height >= 1000);
    if (filter === 'medium') return result.filter(img =>
        (img.width >= 500 || img.height >= 500) &&
        (img.width < 1000 && img.height < 1000)
    );
    return result;
}

function getSizeClass(width, height) {
    if (!width || !height) return '';
    if (width >= 1000 || height >= 1000) return 'large';
    if (width >= 500 || height >= 500) return 'medium';
    return '';
}

function updateImageSelectionInfo() {
    const count = selectedImageUrls.size;
    imageSelectionInfo.textContent = count > 0 ? `${count} selected` : 'Select images to download';
    imageModalDownload.disabled = count === 0;

    // Show estimated total filesize
    if (count > 0) {
        const totalBytes = detectedImages
            .filter(img => selectedImageUrls.has(img.url))
            .reduce((sum, img) => sum + (img.filesize || 0), 0);
        imageSelectionSize.textContent = totalBytes > 0 ? `· ~${formatFilesize(totalBytes)}` : '';
    } else {
        imageSelectionSize.textContent = '';
    }
}

// Image modal event listeners
imageModalClose.addEventListener('click', () => {
    if (isDetached) window.close();
    else hideImageModal();
});

imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal && !isDetached) hideImageModal();
});

// -- Image card click with Shift+click range select -------------------------
imageList.addEventListener('click', (e) => {
    const card = e.target.closest('.image-card');
    if (!card) return;

    const cards = Array.from(imageList.querySelectorAll('.image-card'));
    const clickedIdx = cards.indexOf(card);
    const url = card.dataset.url;

    // Shift+click = range select between lastClickedIndex and this one
    if (e.shiftKey && lastClickedIndex >= 0 && lastClickedIndex !== clickedIdx) {
        const start = Math.min(lastClickedIndex, clickedIdx);
        const end = Math.max(lastClickedIndex, clickedIdx);
        for (let i = start; i <= end; i++) {
            const u = cards[i]?.dataset.url;
            if (u) {
                selectedImageUrls.add(u);
                cards[i].classList.add('selected');
            }
        }
    } else {
        // Normal toggle
        if (selectedImageUrls.has(url)) {
            selectedImageUrls.delete(url);
            card.classList.remove('selected');
        } else {
            selectedImageUrls.add(url);
            card.classList.add('selected');
        }
    }

    lastClickedIndex = clickedIdx;
    keyboardFocusIndex = clickedIdx;
    updateImageSelectionInfo();
});

imageSelectAll.addEventListener('click', () => {
    const filtered = filterImages(detectedImages, currentImageFilter);
    filtered.forEach(img => selectedImageUrls.add(img.url));
    renderImageList();
});

imageDeselectAll.addEventListener('click', () => {
    selectedImageUrls.clear();
    renderImageList();
});

imageFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        imageFilterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentImageFilter = btn.dataset.filter;
        renderImageList();
    });
});

imageSortSelect.addEventListener('change', () => {
    currentImageSort = imageSortSelect.value;
    renderImageList();
});

// -- Min-size slider --------------------------------------------------------
imageMinSizeSlider.addEventListener('input', () => {
    const val = parseInt(imageMinSizeSlider.value, 10);
    minSizeThreshold = val;
    imageMinSizeValue.textContent = val > 0 ? `${val} px` : '0 px';
    renderImageList();
});

// -- Hover preview ----------------------------------------------------------
imageList.addEventListener('mouseenter', (e) => {
    const card = e.target.closest?.('.image-card');
    if (!card) return;

    const url = card.dataset.url;
    const img = detectedImages.find(i => i.url === url);
    if (!img) return;

    // Use the full-res URL for preview (not the thumbnail)
    imagePreviewImg.src = img.thumb || img.url;
    imagePreviewInfo.textContent = img.width && img.height
        ? `${img.width}×${img.height}  ·  ${img.format?.toUpperCase() || 'IMG'}`
        : '';

    // Position to the right of the card (or left if near right edge)
    const rect = card.getBoundingClientRect();
    const spaceRight = window.innerWidth - rect.right;
    const spaceLeft = rect.left;

    if (spaceRight >= 340) {
        imagePreview.style.left = (rect.right + 8) + 'px';
    } else if (spaceLeft >= 340) {
        imagePreview.style.left = (rect.left - 328) + 'px';
    } else {
        // Fallback: position above the card centered
        imagePreview.style.left = Math.max(4, rect.left + rect.width / 2 - 160) + 'px';
    }
    imagePreview.style.top = Math.max(4, Math.min(rect.top, window.innerHeight - 340)) + 'px';

    imagePreview.classList.add('visible');
}, true);

imageList.addEventListener('mouseleave', (e) => {
    const card = e.target.closest?.('.image-card');
    if (card) {
        imagePreview.classList.remove('visible');
    }
}, true);

// Hide preview on scroll too
imageList.addEventListener('scroll', () => {
    imagePreview.classList.remove('visible');
});

// -- Keyboard navigation: Ctrl+A, arrows, Space/Enter ----------------------
document.addEventListener('keydown', (e) => {
    // Only handle when image modal is open
    if (!imageModal.classList.contains('active')) return;

    const cards = Array.from(imageList.querySelectorAll('.image-card'));
    if (cards.length === 0) return;

    // Ctrl/Cmd+A = select all visible
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const filtered = filterImages(detectedImages, currentImageFilter);
        if (currentImageSort !== 'newest') {
            // Selection operates on all filtered, sort doesn't matter
        }
        filtered.forEach(img => selectedImageUrls.add(img.url));
        renderImageList();
        return;
    }

    // Arrow key navigation
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();

        // Calculate grid columns from first card width
        const gridWidth = imageList.clientWidth;
        const cardWidth = cards[0]?.offsetWidth || 160;
        const cols = Math.max(1, Math.round(gridWidth / cardWidth));

        let newIdx = keyboardFocusIndex;
        if (e.key === 'ArrowRight') newIdx = Math.min(cards.length - 1, newIdx + 1);
        else if (e.key === 'ArrowLeft') newIdx = Math.max(0, newIdx - 1);
        else if (e.key === 'ArrowDown') newIdx = Math.min(cards.length - 1, newIdx + cols);
        else if (e.key === 'ArrowUp') newIdx = Math.max(0, newIdx - cols);

        if (newIdx < 0) newIdx = 0;

        // Move focus ring
        cards.forEach(c => c.classList.remove('keyboard-focus'));
        cards[newIdx]?.classList.add('keyboard-focus');
        cards[newIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        keyboardFocusIndex = newIdx;
        return;
    }

    // Space or Enter = toggle selection on focused card
    if ((e.key === ' ' || e.key === 'Enter') && keyboardFocusIndex >= 0) {
        e.preventDefault();
        const card = cards[keyboardFocusIndex];
        if (!card) return;
        const url = card.dataset.url;
        if (selectedImageUrls.has(url)) {
            selectedImageUrls.delete(url);
            card.classList.remove('selected');
        } else {
            selectedImageUrls.add(url);
            card.classList.add('selected');
        }
        updateImageSelectionInfo();
        return;
    }
});

imageModalDownload.addEventListener('click', async () => {
    if (selectedImageUrls.size === 0) return;

    const selectedImages = detectedImages.filter(img => selectedImageUrls.has(img.url));

    hideImageModal();

    showProgress(true);
    updateProgress(0, selectedImages.length, false);
    startPolling();

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'download-specific-images',
            images: selectedImages,
            options: {
                skipDuplicates: skipDuplicatesToggle.checked,
                interval: getIntervalMs(),
                prefix: prefixInput.value.trim()
            }
        });

        stopPolling();

        if (response.error) {
            showStatus(response.error, 'error');
        } else {
            const { success, skipped, duplicates, cancelled } = response;
            let msg = `${success} downloaded`;
            if (duplicates > 0) msg += `, ${duplicates} dupes`;
            if (skipped - duplicates > 0) msg += `, ${skipped - duplicates} failed`;
            if (cancelled) msg += ' (cancelled)';
            showStatus(msg, success > 0 ? 'success' : '');
        }

        showProgress(false);

    } catch (error) {
        stopPolling();
        showStatus('Error: ' + error.message, 'error');
        showProgress(false);
    }

    // In detached mode, re-open the grid with a fresh scan
    if (isDetached) {
        setTimeout(() => showImageModal(), 400);
    }
});

// Handle Escape for image modal too
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && imageModal.classList.contains('active')) {
        if (isDetached) window.close();
        else hideImageModal();
    }
});

// Image picker button (separate from main download button)
const imagePickerBtn = document.getElementById('image-picker-btn');
if (imagePickerBtn) {
    imagePickerBtn.addEventListener('click', async () => {
        if (currentMediaMode === 'images') {
            await showImageModal();
        }
    });
}

// =============================================================================
// KEYBOARD SHORTCUTS CONFIGURATION
// =============================================================================

const shortcutInputs = {
    'shortcut-hover': 'download-hovered',
    'shortcut-picker': 'open-image-modal'
};

let recordingShortcut = null;

async function loadShortcuts() {
    try {
        const result = await chrome.storage.local.get(['customShortcuts']);
        const shortcuts = result.customShortcuts || {};

        for (const [inputId, actionId] of Object.entries(shortcutInputs)) {
            const input = document.getElementById(inputId);
            if (input && shortcuts[actionId]) {
                input.value = formatShortcut(shortcuts[actionId]);
            }
        }
    } catch (error) {
        console.error('Error loading shortcuts:', error);
    }
}

function formatShortcut(shortcut) {
    if (!shortcut || !shortcut.key) return '';
    const parts = [];
    if (shortcut.modifiers.includes('ctrl')) parts.push('Ctrl');
    if (shortcut.modifiers.includes('alt')) parts.push('Alt');
    if (shortcut.modifiers.includes('shift')) parts.push('Shift');
    // Clean up key name for display
    let keyName = shortcut.key;
    keyName = keyName.replace('Key', '').replace('Digit', '');
    parts.push(keyName);
    return parts.join('+');
}

function parseKeyEvent(e) {
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('ctrl');
    if (e.altKey) modifiers.push('alt');
    if (e.shiftKey) modifiers.push('shift');

    // Ignore modifier-only presses
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;

    return {
        key: e.code,
        modifiers,
        enabled: true
    };
}

async function saveShortcut(actionId, shortcut) {
    try {
        const result = await chrome.storage.local.get(['customShortcuts']);
        const shortcuts = result.customShortcuts || {};
        shortcuts[actionId] = shortcut;
        await chrome.storage.local.set({ customShortcuts: shortcuts });

        // Notify content scripts to update
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    action: 'update-shortcuts',
                    shortcuts
                });
            } catch (e) {
                // Tab may not have content script
            }
        }
    } catch (error) {
        console.error('Error saving shortcut:', error);
    }
}

// Set up shortcut input listeners
for (const [inputId, actionId] of Object.entries(shortcutInputs)) {
    const input = document.getElementById(inputId);
    if (!input) continue;

    input.addEventListener('click', () => {
        if (recordingShortcut) {
            document.getElementById(recordingShortcut)?.classList.remove('recording');
        }
        recordingShortcut = inputId;
        input.classList.add('recording');
        input.value = 'Press keys...';
    });

    input.addEventListener('keydown', async (e) => {
        if (recordingShortcut !== inputId) return;
        e.preventDefault();

        const shortcut = parseKeyEvent(e);
        if (!shortcut) return;

        if (e.key === 'Escape') {
            input.classList.remove('recording');
            recordingShortcut = null;
            await loadShortcuts();
            return;
        }

        input.value = formatShortcut(shortcut);
        input.classList.remove('recording');
        recordingShortcut = null;

        await saveShortcut(actionId, shortcut);
    });

    input.addEventListener('blur', () => {
        if (recordingShortcut === inputId) {
            input.classList.remove('recording');
            recordingShortcut = null;
            loadShortcuts();
        }
    });

    const clearBtn = document.getElementById('clear-' + inputId);
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            input.value = '';
            await saveShortcut(actionId, null);
        });
    }
}

// Load shortcuts on popup open
loadShortcuts();

// =============================================================================
// DETACHED MODE - Auto-open image grid
// =============================================================================

if (isDetached) {
    // In detached mode, the image grid IS the main interface.
    // Auto-open it after a short delay to let init complete.
    setTimeout(() => showImageModal(), 150);
}

// =============================================================================
// DETACHED WINDOW - Button handlers (state & getTargetTabs defined at top)
// =============================================================================

const pinBtn = document.getElementById('pin-btn');

// Pin button - detach to persistent window (only in normal popup mode)
if (pinBtn && !isDetached) {
    pinBtn.addEventListener('click', async () => {
        try {
            const currentWindow = await chrome.windows.getCurrent();
            await chrome.runtime.sendMessage({
                action: 'detach-to-window',
                sourceWindowId: currentWindow.id
            });
            window.close();
        } catch (error) {
            console.error('Error detaching to window:', error);
        }
    });
}

// Close button in detached mode (replaces the hidden pin button)
if (isDetached && pinBtn) {
    const closeDetachedBtn = document.createElement('button');
    closeDetachedBtn.className = 'header__pin';
    closeDetachedBtn.title = 'Close persistent window';
    closeDetachedBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
    `;
    closeDetachedBtn.addEventListener('click', () => window.close());
    pinBtn.parentNode.insertBefore(closeDetachedBtn, pinBtn);
}
