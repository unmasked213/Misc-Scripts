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
const statusEl = document.getElementById('status');
const tabCountEl = document.getElementById('tab-count');
const tabPluralEl = document.getElementById('tab-plural');
const progressEl = document.getElementById('progress');
const progressFillEl = document.getElementById('progress-fill');
const progressTextEl = document.getElementById('progress-text');
const progressDupesEl = document.getElementById('progress-dupes');
const pauseBtn = document.getElementById('pause-btn');
const cancelBtn = document.getElementById('cancel-btn');

// State
let isPaused = false;
let pollInterval = null;

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
            intervalInput.value = result.interval;
        }
        if (result.prefix !== undefined) {
            prefixInput.value = result.prefix;
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Save settings when changed
async function saveSettings() {
    try {
        await chrome.storage.local.set({
            closeTabs: closeTabsToggle.checked,
            skipDuplicates: skipDuplicatesToggle.checked,
            interval: Math.max(100, parseInt(intervalInput.value) || 500),
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

// Show/hide progress UI
function showProgress(show) {
    progressEl.classList.toggle('progress--visible', show);
    statusEl.style.display = show ? 'none' : 'flex';
    downloadSelectedBtn.disabled = show;
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
    downloadSelectedBtn.disabled = true;
    isPaused = false;
    
    // Get tab count for progress
    const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
    if (tabs.length === 0) {
        showStatus('No tabs selected', 'error');
        downloadSelectedBtn.disabled = false;
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
                interval: Math.max(100, parseInt(intervalInput.value) || 500),
                prefix: prefixInput.value.trim()
            }
        });

        stopPolling();
        showProgress(false);

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

        await updateTabCount();

    } catch (error) {
        stopPolling();
        showProgress(false);
        showStatus('Error: ' + error.message, 'error');
    }

    downloadSelectedBtn.disabled = false;
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
        showProgress(false);
        showStatus('Cancelled', '');
        downloadSelectedBtn.disabled = false;
        await updateTabCount();
    } catch (error) {
        console.error('Error cancelling:', error);
    }
}

// Interval button handlers
function incrementInterval() {
    const current = parseInt(intervalInput.value) || 500;
    const step = parseInt(intervalInput.step) || 100;
    const max = parseInt(intervalInput.max) || 10000;
    intervalInput.value = Math.min(current + step, max);
    saveSettings();
}

function decrementInterval() {
    const current = parseInt(intervalInput.value) || 500;
    const step = parseInt(intervalInput.step) || 100;
    const min = parseInt(intervalInput.min) || 100;
    intervalInput.value = Math.max(current - step, min);
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

// Initialize
loadSettings();
updateTabCount();
checkRunningDownload();
