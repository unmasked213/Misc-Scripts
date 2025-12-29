/**
 * Popup script - handles UI interactions and communicates with background service worker
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
const progressEl = document.getElementById('progress');
const progressFillEl = document.getElementById('progress-fill');
const progressTextEl = document.getElementById('progress-text');
const progressDupesEl = document.getElementById('progress-dupes');
const pauseBtn = document.getElementById('pause-btn');
const cancelBtn = document.getElementById('cancel-btn');
const mediaTypeBtns = document.querySelectorAll('.media-type__btn');

// Modal elements
const videoModal = document.getElementById('video-modal');
const modalClose = document.getElementById('modal-close');
const modalCancel = document.getElementById('modal-cancel');
const modalDownload = document.getElementById('modal-download');
const videoList = document.getElementById('video-list');
const selectionInfo = document.getElementById('selection-info');
const filterDuration = document.getElementById('filter-duration');
const filterSize = document.getElementById('filter-size');
const videoPlayerPanel = document.getElementById('video-player-panel');
const playerVideo = document.getElementById('player-video');
const playerTitle = document.getElementById('player-title');
const playerClose = document.getElementById('player-close');

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
let currentMediaMode = 'auto';
let detectedVideos = [];
let selectedVideoUrls = new Set();

// Load saved settings
async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(['closeTabs', 'skipDuplicates', 'interval', 'prefix', 'mediaMode']);
        
        if (result.closeTabs !== undefined) {
            closeTabsToggle.checked = result.closeTabs;
        }
        if (result.skipDuplicates !== undefined) {
            skipDuplicatesToggle.checked = result.skipDuplicates;
        }
        if (result.interval !== undefined) {
            intervalInput.value = (result.interval / 1000).toFixed(1);
        }
        if (result.prefix !== undefined) {
            prefixInput.value = result.prefix;
            updatePrefixLabelState();
        }
        if (result.mediaMode !== undefined) {
            currentMediaMode = result.mediaMode;
        }
        updateMediaModeUI();
        updateButtonText();
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Update media mode button UI
function updateMediaModeUI() {
    mediaTypeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === currentMediaMode);
    });
}

// Update button text based on mode
function updateButtonText() {
    if (currentMediaMode === 'videos') {
        document.body.classList.add('mode-videos');
        // Hide count, show "List videos"
        const btnText = document.getElementById('btn-text');
        if (btnText) btnText.innerHTML = 'List videos';
    } else {
        document.body.classList.remove('mode-videos');
        const labels = {
            'images': 'image',
            'auto': 'tab'
        };
        const label = labels[currentMediaMode] || 'tab';
        const btnText = document.getElementById('btn-text');
        if (btnText) {
            btnText.innerHTML = `<span id="tab-count">1</span> <span id="media-type-label">${label}</span><span id="tab-plural">s</span>`;
            // Re-query and update count
            updateTabCount();
        }
    }
}

// Handle media mode button clicks
function handleMediaModeClick(event) {
    const btn = event.target.closest('.media-type__btn');
    if (!btn) return;
    
    currentMediaMode = btn.dataset.mode;
    updateMediaModeUI();
    updateButtonText();
    saveSettings();
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
            prefix: prefixInput.value.trim(),
            mediaMode: currentMediaMode
        });
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

// Update selected tab count
async function updateTabCount() {
    // Skip if in videos mode (button shows "List videos" instead)
    if (currentMediaMode === 'videos') return;
    
    try {
        const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
        const count = tabs.length;
        const tabCountEl = document.getElementById('tab-count');
        const tabPluralEl = document.getElementById('tab-plural');
        if (tabCountEl) tabCountEl.textContent = count;
        if (tabPluralEl) tabPluralEl.textContent = count === 1 ? '' : 's';
    } catch (error) {
        console.error('Error getting tab count:', error);
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

// =============================================================================
// VIDEO PREVIEW MODAL
// =============================================================================

function showModal() {
    if (videoModal) videoModal.classList.add('active');
}

function hideModal() {
    if (videoModal) videoModal.classList.remove('active');
    hidePlayer();
    detectedVideos = [];
    selectedVideoUrls.clear();
}

function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return '—';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) {
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    return `${secs}s`;
}

function formatFilesize(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFilteredState(video) {
    const minDuration = parseInt(filterDuration.value) || 0;
    const minSizeMB = parseInt(filterSize.value) || 0;
    
    // Only filter if we know the value and it's below threshold
    if (minDuration > 0 && video.duration !== null && video.duration < minDuration) {
        return true;
    }
    if (minSizeMB > 0 && video.filesize !== null && video.filesize < minSizeMB * 1024 * 1024) {
        return true;
    }
    return false;
}

function renderVideoList() {
    if (!videoList) return;
    
    if (detectedVideos.length === 0) {
        videoList.innerHTML = '<div class="modal__empty">No videos found. Try playing a video first.</div>';
        updateSelectionInfo();
        return;
    }
    
    const html = detectedVideos.map((video, index) => {
        const isSelected = selectedVideoUrls.has(video.url);
        const isFiltered = getFilteredState(video);
        const isVerified = video.verified !== false;
        const isStream = video.status === 'stream';
        const source = video.source || 'unknown';
        
        // Show origin badge for debugging
        const originBadge = video.origin === 'dom' ? 'DOM' : 'NET';
        const originClass = video.origin === 'dom' ? 'origin-dom' : 'origin-net';
        
        return `
            <div class="video-card ${isSelected ? 'selected' : ''} ${isFiltered ? 'filtered' : ''} ${!isVerified ? 'unverified' : ''}" 
                 data-index="${index}" data-url="${encodeURIComponent(video.url)}" data-verified="${isVerified}">
                <div class="video-card__checkbox">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <polyline points="20 6 9 17 4 12"/>
                    </svg>
                </div>
                <div class="video-card__info">
                    <div class="video-card__source">
                        ${escapeHtml(source)}
                        <span class="video-card__origin ${originClass}">${originBadge}</span>
                        ${isStream ? '<span class="video-card__stream">Stream</span>' : ''}
                    </div>
                    <div class="video-card__meta">
                        <span class="video-card__badge">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            ${formatDuration(video.duration)}
                        </span>
                        <span class="video-card__badge">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                                <polyline points="13 2 13 9 20 9"/>
                            </svg>
                            ${formatFilesize(video.filesize)}
                        </span>
                        ${video.dimensions ? `<span class="video-card__badge">${video.dimensions}</span>` : ''}
                    </div>
                </div>
                <button class="video-card__play ${!isVerified ? 'disabled' : ''}" 
                        data-play-index="${index}" 
                        title="${isVerified ? 'Preview video' : 'Preview unavailable'}"
                        ${!isVerified ? 'disabled' : ''}>
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </button>
            </div>
        `;
    }).join('');
    
    videoList.innerHTML = `<div class="video-grid">${html}</div>`;
    updateSelectionInfo();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function updateSelectionInfo() {
    const count = selectedVideoUrls.size;
    if (selectionInfo) selectionInfo.textContent = `${count} selected`;
    if (modalDownload) modalDownload.disabled = count === 0;
}

function handleVideoCardClick(event) {
    // Ignore clicks on play button
    if (event.target.closest('.video-card__play')) return;
    
    const card = event.target.closest('.video-card');
    if (!card || card.classList.contains('filtered')) return;
    
    const url = decodeURIComponent(card.dataset.url);
    
    if (selectedVideoUrls.has(url)) {
        selectedVideoUrls.delete(url);
        card.classList.remove('selected');
    } else {
        selectedVideoUrls.add(url);
        card.classList.add('selected');
    }
    
    updateSelectionInfo();
}

function handlePlayClick(event) {
    const playBtn = event.target.closest('.video-card__play');
    if (!playBtn || playBtn.disabled || playBtn.classList.contains('disabled')) return;
    
    event.stopPropagation();
    
    const index = parseInt(playBtn.dataset.playIndex);
    const video = detectedVideos[index];
    if (!video || video.verified === false) return;
    
    showPlayer(video);
}

function showPlayer(video) {
    if (!videoPlayerPanel || !playerVideo || !playerTitle) return;
    
    // Set title
    const source = video.source || new URL(video.url).hostname;
    playerTitle.textContent = source;
    
    // Set video source
    playerVideo.src = video.url;
    playerVideo.load();
    
    // Show panel
    videoPlayerPanel.style.display = 'block';
    
    // Auto-play
    playerVideo.play().catch(() => {});
}

function hidePlayer() {
    if (!videoPlayerPanel || !playerVideo) return;
    
    playerVideo.pause();
    playerVideo.src = '';
    videoPlayerPanel.style.display = 'none';
}

function applyFilters() {
    if (!videoList) return;
    
    const cards = videoList.querySelectorAll('.video-card');
    cards.forEach((card, index) => {
        const video = detectedVideos[index];
        const isFiltered = getFilteredState(video);
        card.classList.toggle('filtered', isFiltered);
        
        // Deselect filtered items
        if (isFiltered && selectedVideoUrls.has(video.url)) {
            selectedVideoUrls.delete(video.url);
            card.classList.remove('selected');
        }
    });
    updateSelectionInfo();
}

async function scanForVideos() {
    if (!videoModal || !videoList) {
        console.error('Modal elements not found in DOM');
        return;
    }
    
    hidePlayer();
    videoList.innerHTML = '<div class="modal__loading"><span>Scanning for videos...</span></div>';
    showModal();
    
    try {
        const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
        
        const response = await chrome.runtime.sendMessage({
            action: 'scan-videos',
            tabIds: tabs.map(t => t.id)
        });
        
        if (response.error) {
            videoList.innerHTML = `<div class="modal__empty">Error: ${response.error}</div>`;
            return;
        }
        
        detectedVideos = response.videos || [];
        selectedVideoUrls.clear();
        
        renderVideoList();
        
    } catch (error) {
        console.error('Error scanning videos:', error);
        videoList.innerHTML = `<div class="modal__empty">Error scanning: ${error.message}</div>`;
    }
}

async function downloadSelectedVideos() {
    if (selectedVideoUrls.size === 0) return;
    
    // Capture URLs before hideModal clears them
    const urls = Array.from(selectedVideoUrls);
    
    hideModal();
    
    showProgress(true);
    updateProgress(0, urls.length, false);
    startPolling();
    
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'download-specific-videos',
            urls: urls,
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

// =============================================================================
// MAIN DOWNLOAD HANDLER
// =============================================================================

async function downloadSelected() {
    // For video mode, show preview modal
    if (currentMediaMode === 'videos') {
        await scanForVideos();
        return;
    }
    
    // For images or auto mode, proceed directly
    isPaused = false;

    const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
    if (tabs.length === 0) {
        showStatus('No tabs selected', 'error');
        showProgress(true);
        return;
    }

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
                prefix: prefixInput.value.trim(),
                mediaMode: currentMediaMode
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

// Interval button handlers
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

// =============================================================================
// EVENT LISTENERS
// =============================================================================

// Main controls
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

// Media type selector
document.getElementById('media-type').addEventListener('click', handleMediaModeClick);

// Modal controls (only if modal exists in DOM)
if (modalClose) modalClose.addEventListener('click', hideModal);
if (modalCancel) modalCancel.addEventListener('click', hideModal);
if (modalDownload) modalDownload.addEventListener('click', downloadSelectedVideos);
if (videoList) {
    videoList.addEventListener('click', handleVideoCardClick);
    videoList.addEventListener('click', handlePlayClick);
}
if (filterDuration) filterDuration.addEventListener('change', applyFilters);
if (filterSize) filterSize.addEventListener('change', applyFilters);
if (playerClose) playerClose.addEventListener('click', hidePlayer);

// Close modal on overlay click
if (videoModal) {
    videoModal.addEventListener('click', (e) => {
        if (e.target === videoModal) hideModal();
    });
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && videoModal.classList.contains('active')) {
        hideModal();
    }
});

// Initialize
loadSettings();
updateTabCount();
checkRunningDownload();
