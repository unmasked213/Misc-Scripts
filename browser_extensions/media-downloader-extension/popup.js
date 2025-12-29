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
