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
        const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
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

    // Image mode - existing logic
    isPaused = false;

    // Get tab count for progress
    const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
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
skipDuplicatesToggle.addEventListener('change', saveSettings);
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
    if (currentMediaMode === 'videos') {
        btnText.innerHTML = 'List videos';
    } else {
        btnText.innerHTML = `<span id="tab-count">${tabCountEl.textContent}</span> file<span id="tab-plural">${tabPluralEl.textContent}</span>`;
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
        const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
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
        const result = await chrome.runtime.sendMessage({
            action: 'fetch-preview-snippet',
            url: video.url,
            maxBytes: 2 * 1024 * 1024  // 2 MB preview snippet
        });

        // Remove loading indicator
        loadingEl.remove();

        if (result.error) {
            const errorEl = document.createElement('div');
            errorEl.className = 'player-error';
            errorEl.textContent = 'Preview unavailable: ' + result.error;
            videoPlayer.appendChild(errorEl);
            return;
        }

        // Create blob URL from buffer data
        const buffer = new Uint8Array(result.buffer);
        const blob = new Blob([buffer], { type: result.contentType || 'video/mp4' });
        const blobUrl = URL.createObjectURL(blob);

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
});
