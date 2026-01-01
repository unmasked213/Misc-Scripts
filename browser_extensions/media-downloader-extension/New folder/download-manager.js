/**
 * Media Downloader - Download Manager
 * 
 * This script runs in a dedicated extension tab, which means:
 * - It has full access to chrome.* APIs
 * - Fetch requests use the extension's host permissions (bypasses CORS)
 * - It can hold large data in memory without SW timeout concerns
 * - Blob URLs created here persist until the tab closes
 * 
 * CocoCut-style pattern: Background sends task data, this tab does the heavy lifting.
 */

// =============================================================================
// STATE
// =============================================================================

const State = {
    taskId: null,
    url: null,
    filename: null,
    pageUrl: null,        // For Referer header
    isHLS: false,
    isPaused: false,
    isCancelled: false,
    isComplete: false,
    
    // Progress tracking
    totalBytes: 0,
    downloadedBytes: 0,
    segments: [],
    segmentsComplete: 0,
    startTime: null,
    
    // The assembled data
    blob: null,
    blobUrl: null
};

// =============================================================================
// UI UPDATES
// =============================================================================

const UI = {
    log(message, level = 'info') {
        const container = document.getElementById('logContainer');
        const entry = document.createElement('div');
        entry.className = `log-entry ${level}`;
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${message}`;
        container.appendChild(entry);
        container.scrollTop = container.scrollHeight;
        console.log(`[DownloadManager] ${message}`);
    },

    setStatus(status) {
        const badge = document.getElementById('statusBadge');
        badge.className = `status-badge ${status}`;
        badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    },

    setFilename(name) {
        document.getElementById('filename').textContent = name;
    },

    setMediaType(type) {
        document.getElementById('mediaType').textContent = type;
    },

    setFileSize(bytes) {
        if (bytes > 0) {
            document.getElementById('fileSize').textContent = formatBytes(bytes);
            document.getElementById('totalStat').textContent = formatBytes(bytes);
        }
    },

    updateProgress(downloaded, total, speed = null) {
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        document.getElementById('progressBar').style.width = `${percent}%`;
        document.getElementById('progressText').textContent = `${percent}%`;
        document.getElementById('downloadedStat').textContent = formatBytes(downloaded);
        
        if (total > 0) {
            document.getElementById('totalStat').textContent = formatBytes(total);
        }
        
        if (speed !== null) {
            document.getElementById('speedText').textContent = `${formatBytes(speed)}/s`;
        }
        
        // Update elapsed time
        if (State.startTime) {
            const elapsed = Math.round((Date.now() - State.startTime) / 1000);
            document.getElementById('timeStat').textContent = formatTime(elapsed);
        }
    },

    showSegments(segments) {
        document.getElementById('segmentsSection').classList.remove('hidden');
        this.updateSegmentsList(segments);
    },

    updateSegmentsList(segments) {
        const list = document.getElementById('segmentsList');
        const progress = document.getElementById('segmentsProgress');
        const complete = segments.filter(s => s.status === 'complete').length;
        
        progress.textContent = `${complete} / ${segments.length}`;
        document.getElementById('segmentsStat').textContent = `${complete}/${segments.length}`;
        
        // Only show last 20 segments to avoid DOM bloat
        const visible = segments.slice(-20);
        list.innerHTML = visible.map((seg, i) => {
            const idx = segments.length - 20 + i;
            const size = seg.size ? formatBytes(seg.size) : '-';
            return `<div class="segment-item ${seg.status}">
                <span>#${idx + 1}</span>
                <span>${size}</span>
            </div>`;
        }).join('');
    },

    showSaveButton() {
        document.getElementById('saveBtn').classList.remove('hidden');
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('cancelBtn').disabled = true;
    },

    enableControls() {
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('cancelBtn').disabled = false;
    }
};

// =============================================================================
// UTILITIES
// =============================================================================

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function resolveUrl(url, baseUrl) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
    }
    try {
        return new URL(url, baseUrl).href;
    } catch (e) {
        return url;
    }
}

function getFilenameFromUrl(url) {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.split('/').pop();
        return path.split('?')[0] || 'video';
    } catch {
        return 'video';
    }
}

// =============================================================================
// HLS PARSER
// =============================================================================

const HLSParser = {
    parse(manifestText, baseUrl) {
        const lines = manifestText.split('\n').map(l => l.trim()).filter(Boolean);
        const result = {
            isValid: lines[0]?.includes('#EXTM3U'),
            isMaster: false,
            isDRM: false,
            segments: [],
            variants: [],
            totalDuration: 0
        };

        if (!result.isValid) return result;

        let currentDuration = 0;

        for (const line of lines) {
            // Check for DRM
            if (line.includes('#EXT-X-KEY:')) {
                const methodMatch = line.match(/METHOD=([^,]+)/);
                if (methodMatch) {
                    const method = methodMatch[1].toUpperCase();
                    if (method !== 'NONE' && method !== 'AES-128') {
                        // Widevine, PlayReady, etc. - not supported
                        result.isDRM = true;
                        return result;
                    }
                }
            }

            // Master playlist variant
            if (line.includes('#EXT-X-STREAM-INF:')) {
                result.isMaster = true;
                const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                result.variants.push({
                    bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
                    resolution: resMatch ? resMatch[1] : 'unknown'
                });
            }

            // Segment duration
            if (line.startsWith('#EXTINF:')) {
                const durMatch = line.match(/#EXTINF:([\d.]+)/);
                if (durMatch) {
                    currentDuration = parseFloat(durMatch[1]);
                    result.totalDuration += currentDuration;
                }
            }

            // Segment URL (line after EXTINF or variant URL after STREAM-INF)
            if (!line.startsWith('#')) {
                if (result.isMaster && result.variants.length > 0) {
                    // This is a variant playlist URL
                    result.variants[result.variants.length - 1].url = resolveUrl(line, baseUrl);
                } else {
                    // This is a segment URL
                    result.segments.push({
                        url: resolveUrl(line, baseUrl),
                        duration: currentDuration
                    });
                    currentDuration = 0;
                }
            }
        }

        return result;
    },

    selectBestVariant(variants) {
        // Select highest bandwidth variant
        return variants.reduce((best, v) => 
            v.bandwidth > (best?.bandwidth || 0) ? v : best, null);
    }
};

// =============================================================================
// DOWNLOAD ENGINE
// =============================================================================

const Downloader = {
    abortController: null,
    speedSamples: [],
    lastProgressTime: 0,
    lastProgressBytes: 0,

    /**
     * Fetch a URL with extension permissions (bypasses CORS)
     */
    async fetch(url, options = {}) {
        const headers = new Headers(options.headers || {});
        
        // Add Referer if we have pageUrl
        if (State.pageUrl && !headers.has('Referer')) {
            headers.set('Referer', State.pageUrl);
        }
        
        // Add common headers
        if (!headers.has('Accept')) {
            headers.set('Accept', '*/*');
        }

        const fetchOptions = {
            method: options.method || 'GET',
            headers,
            credentials: 'include',
            signal: this.abortController?.signal
        };

        if (options.range) {
            headers.set('Range', `bytes=${options.range.start}-${options.range.end || ''}`);
        }

        return fetch(url, fetchOptions);
    },

    /**
     * Download a progressive video file
     */
    async downloadProgressive(url, filename) {
        UI.log(`Starting progressive download: ${filename}`);
        UI.setStatus('downloading');
        UI.setMediaType('Progressive Video');
        State.startTime = Date.now();

        this.abortController = new AbortController();
        
        try {
            // First, do a HEAD request to get file size
            const headResponse = await this.fetch(url, { method: 'HEAD' });
            const contentLength = headResponse.headers.get('content-length');
            const acceptRanges = headResponse.headers.get('accept-ranges');
            
            if (contentLength) {
                State.totalBytes = parseInt(contentLength);
                UI.setFileSize(State.totalBytes);
            }

            UI.log(`File size: ${contentLength ? formatBytes(parseInt(contentLength)) : 'unknown'}`);
            UI.log(`Range support: ${acceptRanges || 'none'}`);

            // For now, single-threaded download
            // Could implement multi-range later like CocoCut Pro
            const response = await this.fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            // Check content type
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
                throw new Error('Server returned HTML instead of video - authentication may be required');
            }

            // Stream the response
            const reader = response.body.getReader();
            const chunks = [];
            
            while (true) {
                if (State.isCancelled) {
                    reader.cancel();
                    throw new Error('Download cancelled');
                }

                while (State.isPaused) {
                    await new Promise(r => setTimeout(r, 100));
                }

                const { done, value } = await reader.read();
                
                if (done) break;
                
                chunks.push(value);
                State.downloadedBytes += value.length;
                
                this.updateSpeed();
                UI.updateProgress(State.downloadedBytes, State.totalBytes, this.getSpeed());
            }

            // Assemble blob
            UI.log('Assembling file...');
            State.blob = new Blob(chunks, { type: contentType || 'video/mp4' });
            State.blobUrl = URL.createObjectURL(State.blob);
            
            UI.log(`Download complete: ${formatBytes(State.blob.size)}`);
            this.complete(filename);
            
        } catch (error) {
            if (error.name === 'AbortError' || State.isCancelled) {
                UI.log('Download cancelled', 'warning');
                UI.setStatus('idle');
            } else {
                UI.log(`Download failed: ${error.message}`, 'error');
                UI.setStatus('error');
            }
            throw error;
        }
    },

    /**
     * Download an HLS stream
     */
    async downloadHLS(manifestUrl, filename) {
        UI.log(`Starting HLS download: ${filename}`);
        UI.setStatus('downloading');
        UI.setMediaType('HLS Stream');
        State.isHLS = true;
        State.startTime = Date.now();

        this.abortController = new AbortController();

        try {
            // Fetch the manifest
            UI.log('Fetching manifest...');
            const manifestResponse = await this.fetch(manifestUrl);
            
            if (!manifestResponse.ok) {
                throw new Error(`Failed to fetch manifest: HTTP ${manifestResponse.status}`);
            }

            const manifestText = await manifestResponse.text();
            const baseUrl = manifestResponse.url || manifestUrl;
            
            let parsed = HLSParser.parse(manifestText, baseUrl);
            
            if (!parsed.isValid) {
                throw new Error('Invalid HLS manifest');
            }

            if (parsed.isDRM) {
                throw new Error('DRM-protected stream - cannot download');
            }

            // If master playlist, fetch the best variant
            if (parsed.isMaster) {
                UI.log(`Master playlist with ${parsed.variants.length} variants`);
                const best = HLSParser.selectBestVariant(parsed.variants);
                
                if (!best || !best.url) {
                    throw new Error('No valid variant found in master playlist');
                }

                UI.log(`Selected variant: ${best.resolution} @ ${formatBytes(best.bandwidth)}/s`);
                
                const variantResponse = await this.fetch(best.url);
                if (!variantResponse.ok) {
                    throw new Error(`Failed to fetch variant playlist: HTTP ${variantResponse.status}`);
                }
                
                const variantText = await variantResponse.text();
                parsed = HLSParser.parse(variantText, best.url);
            }

            if (parsed.segments.length === 0) {
                throw new Error('No segments found in playlist');
            }

            UI.log(`Found ${parsed.segments.length} segments, ~${Math.round(parsed.totalDuration)}s total`);
            
            // Initialize segment tracking
            State.segments = parsed.segments.map(s => ({
                url: s.url,
                duration: s.duration,
                status: 'pending',
                size: 0,
                data: null
            }));
            
            UI.showSegments(State.segments);

            // Download all segments sequentially
            const allChunks = [];
            
            for (let i = 0; i < State.segments.length; i++) {
                if (State.isCancelled) {
                    throw new Error('Download cancelled');
                }

                while (State.isPaused) {
                    await new Promise(r => setTimeout(r, 100));
                }

                const segment = State.segments[i];
                segment.status = 'downloading';
                UI.updateSegmentsList(State.segments);

                try {
                    const response = await this.fetch(segment.url);
                    
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const data = await response.arrayBuffer();
                    segment.data = new Uint8Array(data);
                    segment.size = data.byteLength;
                    segment.status = 'complete';
                    
                    State.downloadedBytes += segment.size;
                    State.segmentsComplete++;
                    
                    allChunks.push(segment.data);
                    
                    // Estimate total size
                    if (i === 0) {
                        State.totalBytes = segment.size * State.segments.length;
                        UI.setFileSize(State.totalBytes);
                    }

                    this.updateSpeed();
                    UI.updateProgress(State.downloadedBytes, State.totalBytes, this.getSpeed());
                    UI.updateSegmentsList(State.segments);

                } catch (segError) {
                    segment.status = 'error';
                    UI.log(`Segment ${i + 1} failed: ${segError.message}`, 'error');
                    UI.updateSegmentsList(State.segments);
                    // Continue to next segment - don't abort entire download
                }
            }

            // Assemble all segments
            UI.log('Assembling segments...');
            
            const totalLength = allChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const assembled = new Uint8Array(totalLength);
            let offset = 0;
            
            for (const chunk of allChunks) {
                assembled.set(chunk, offset);
                offset += chunk.length;
            }

            // Create blob - use video/MP2T for TS segments
            // CocoCut does this too - raw concatenation, not true remux
            State.blob = new Blob([assembled], { type: 'video/MP2T' });
            State.blobUrl = URL.createObjectURL(State.blob);

            // Clear segment data from memory
            for (const seg of State.segments) {
                seg.data = null;
            }

            UI.log(`Assembly complete: ${formatBytes(State.blob.size)}`);
            this.complete(filename);

        } catch (error) {
            if (error.name === 'AbortError' || State.isCancelled) {
                UI.log('Download cancelled', 'warning');
                UI.setStatus('idle');
            } else {
                UI.log(`HLS download failed: ${error.message}`, 'error');
                UI.setStatus('error');
            }
            throw error;
        }
    },

    updateSpeed() {
        const now = Date.now();
        if (now - this.lastProgressTime >= 1000) {
            const bytesSinceLast = State.downloadedBytes - this.lastProgressBytes;
            const timeSinceLast = (now - this.lastProgressTime) / 1000;
            const speed = bytesSinceLast / timeSinceLast;
            
            this.speedSamples.push(speed);
            if (this.speedSamples.length > 5) {
                this.speedSamples.shift();
            }
            
            this.lastProgressTime = now;
            this.lastProgressBytes = State.downloadedBytes;
        }
    },

    getSpeed() {
        if (this.speedSamples.length === 0) return 0;
        return this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
    },

    complete(filename) {
        State.isComplete = true;
        UI.setStatus('complete');
        UI.showSaveButton();
        
        // Notify background
        chrome.runtime.sendMessage({
            action: 'download-complete',
            taskId: State.taskId,
            filename: filename,
            size: State.blob.size
        }).catch(() => {});
    },

    cancel() {
        State.isCancelled = true;
        if (this.abortController) {
            this.abortController.abort();
        }
    },

    pause() {
        State.isPaused = true;
        UI.setStatus('idle');
        UI.log('Download paused', 'warning');
    },

    resume() {
        State.isPaused = false;
        UI.setStatus('downloading');
        UI.log('Download resumed');
    }
};

// =============================================================================
// SAVE FILE
// =============================================================================

function saveFile() {
    if (!State.blobUrl || !State.blob) {
        UI.log('No file to save!', 'error');
        return;
    }

    let filename = State.filename || 'video';
    
    // Ensure proper extension
    if (State.isHLS) {
        // HLS concatenation produces TS data - many players handle .mp4 extension anyway
        // But .ts is more accurate
        if (!filename.match(/\.(mp4|ts|m2ts)$/i)) {
            filename = filename.replace(/\.[^/.]+$/, '') + '.ts';
        }
    } else {
        if (!filename.match(/\.(mp4|webm|mkv|avi|mov)$/i)) {
            filename = filename.replace(/\.[^/.]+$/, '') + '.mp4';
        }
    }

    UI.log(`Saving as: ${filename}`);

    // Use chrome.downloads API
    chrome.downloads.download({
        url: State.blobUrl,
        filename: filename,
        saveAs: false
    }, (downloadId) => {
        if (chrome.runtime.lastError) {
            UI.log(`Save failed: ${chrome.runtime.lastError.message}`, 'error');
        } else {
            UI.log(`Download started (ID: ${downloadId})`, 'success');
            
            // Could close tab after save, but let user verify first
            // setTimeout(() => window.close(), 2000);
        }
    });
}

// =============================================================================
// INITIALIZATION
// =============================================================================

function init() {
    // Parse URL parameters for task data
    const params = new URLSearchParams(window.location.search);
    
    State.taskId = params.get('taskId');
    State.url = params.get('url');
    State.filename = params.get('filename') || getFilenameFromUrl(State.url || '');
    State.pageUrl = params.get('pageUrl');
    State.isHLS = params.get('isHLS') === 'true';

    UI.setFilename(State.filename);
    UI.log('Download Manager initialized');

    if (State.url) {
        UI.log(`URL: ${State.url.substring(0, 80)}...`);
        if (State.pageUrl) {
            UI.log(`Referer: ${State.pageUrl.substring(0, 60)}...`);
        }
        
        // Start download automatically
        startDownload();
    } else {
        UI.log('Waiting for download task...', 'warning');
    }

    // Set up controls
    document.getElementById('pauseBtn').addEventListener('click', () => {
        if (State.isPaused) {
            Downloader.resume();
            document.getElementById('pauseBtn').textContent = 'Pause';
        } else {
            Downloader.pause();
            document.getElementById('pauseBtn').textContent = 'Resume';
        }
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
        if (confirm('Cancel this download?')) {
            Downloader.cancel();
        }
    });

    document.getElementById('saveBtn').addEventListener('click', saveFile);

    // Listen for messages from background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'start-download') {
            State.taskId = message.taskId;
            State.url = message.url;
            State.filename = message.filename || getFilenameFromUrl(message.url);
            State.pageUrl = message.pageUrl;
            State.isHLS = message.isHLS;
            
            UI.setFilename(State.filename);
            UI.log(`Received task: ${State.filename}`);
            
            startDownload();
            sendResponse({ received: true });
        }
        return true;
    });
}

async function startDownload() {
    if (!State.url) {
        UI.log('No URL provided', 'error');
        return;
    }

    UI.enableControls();

    try {
        if (State.isHLS || /\.m3u8(\?|#|$)/i.test(State.url)) {
            await Downloader.downloadHLS(State.url, State.filename);
        } else {
            await Downloader.downloadProgressive(State.url, State.filename);
        }
    } catch (error) {
        // Error already logged in downloader
        console.error('Download error:', error);
    }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
