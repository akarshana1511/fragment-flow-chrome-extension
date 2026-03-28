// ==================== IMPORT MODULES ====================
// Import P2P Swarm module for peer-to-peer chunk sharing
import('./swarm.js').then(() => {
    console.log('[System] Swarm module loaded successfully');
}).catch(err => {
    console.warn('[System] Failed to load swarm module:', err);
    // Continue without swarm if loading fails
    swarmEnabled = false;
});

let chunkQueue = [];
let results = [];
let activeThreads = 4;

// Global tracking
let threadProgress = {};
let globalDownloadedBytes = 0;
let sessionDownloadedBytes = 0; // Tracks bytes downloaded strictly in the current resume session for accurate speed
let globalTotalBytes = 0;
let startTime = 0;
let isDownloading = false;
let isPaused = false;
let downloadCompleted = false;
let currentTargetUrl = "";
let broadcastTimeoutId = null; // Track broadcast timeout for cleanup
let lastProgressBroadcastTime = 0; // Prevent excessive broadcasting
let swarmEnabled = true; // Enable P2P swarm by default

// ==================== WRITE-AHEAD LOG (WAL) & CHECKPOINTING ====================
// Persistent state manager for fault tolerance
const CHECKPOINT_KEY = 'download_checkpoint_wal';
const CHECKPOINT_INTERVAL = 1000; // Checkpoint every 1 second for high frequency persistence
let lastCheckpointTime = 0;

/**
 * Save checkpoint to persistent storage (Write-Ahead Log)
 * Writes the exact state needed to recover from any interruption
 */
async function saveCheckpoint() {
    const now = Date.now();
    
    // Throttle checkpoint writes to avoid excessive storage operations
    if (now - lastCheckpointTime < CHECKPOINT_INTERVAL) {
        return;
    }
    lastCheckpointTime = now;

    const checkpoint = {
        timestamp: now,
        url: currentTargetUrl,
        globalTotalBytes: globalTotalBytes,
        globalDownloadedBytes: globalDownloadedBytes,
        chunkQueue: chunkQueue, // Remaining chunks to download
        threadProgress: threadProgress, // Per-thread progress
        isPaused: isPaused,
        activeThreads: activeThreads,
        resultsMetadata: results.map(r => ({ start: r.start })) // Blob data not persisted
    };

    try {
        await chrome.storage.local.set({ [CHECKPOINT_KEY]: checkpoint });
    } catch (err) {
        console.error('WAL checkpoint save failed:', err);
    }
}

/**
 * Restore checkpoint from persistent storage
 * Called on extension load to resume interrupted downloads
 */
async function restoreCheckpoint() {
    try {
        const data = await chrome.storage.local.get(CHECKPOINT_KEY);
        if (data[CHECKPOINT_KEY]) {
            const checkpoint = data[CHECKPOINT_KEY];
            const timeSinceSave = Date.now() - checkpoint.timestamp;

            // Only restore if checkpoint was recent (within 1 hour)
            if (timeSinceSave < 3600000) {
                console.log(`[WAL] Restoring download checkpoint from ${timeSinceSave}ms ago`);
                
                currentTargetUrl = checkpoint.url;
                globalTotalBytes = checkpoint.globalTotalBytes;
                globalDownloadedBytes = checkpoint.globalDownloadedBytes;
                chunkQueue = checkpoint.chunkQueue || [];
                threadProgress = checkpoint.threadProgress || {};
                isPaused = checkpoint.isPaused || false;
                activeThreads = checkpoint.activeThreads || 4;
                
                // Resume the download if there are chunks remaining
                if (chunkQueue.length > 0) {
                    isDownloading = true;
                    console.log(`[WAL] Resuming with ${chunkQueue.length} chunks remaining`);
                    
                    // ==================== ADAPTIVE BANDWIDTH DETECTION ====================
                    // Reset bandwidth detector for new session (pause/resume = new session)
                    bandwidthDetector.reset();
                    
                    // Notify UI that download is in progress
                    openCenteredPopup();
                    
                    // Resume download workers
                    startTime = Date.now();
                    sessionDownloadedBytes = 0;
                    startWorkers();
                }
                
                return true;
            }
        }
    } catch (err) {
        console.error('WAL checkpoint restore failed:', err);
    }
    return false;
}

/**
 * Clear checkpoint after successful download completion
 */
async function clearCheckpoint() {
    try {
        await chrome.storage.local.remove(CHECKPOINT_KEY);
        console.log('[WAL] Checkpoint cleared');
    } catch (err) {
        console.error('WAL checkpoint clear failed:', err);
    }
}

// Restore checkpoint on extension load
let resumeAttempts = 0;
const MAX_RESUME_ATTEMPTS = 3;

async function attemptRestoreCheckpoint() {
    resumeAttempts++;
    if (resumeAttempts > MAX_RESUME_ATTEMPTS) {
        console.warn('[WAL] Max resume attempts reached, clearing checkpoint');
        await clearCheckpoint();
        return false;
    }
    
    return await restoreCheckpoint();
}

attemptRestoreCheckpoint();

// ==================== ADAPTIVE BANDWIDTH DETECTION ====================
/**
 * BandwidthDetector - Measures real-time download speed
 * Dynamically recommends thread count based on network conditions
 */
class BandwidthDetector {
    constructor() {
        this.measurements = [];
        this.maxMeasurements = 10; // Keep rolling average of last 10 measurements
        this.lastMeasurementTime = 0;
        this.lastMeasuredBytes = 0;
        this.measurementInterval = 2000; // Measure every 2 seconds
    }

    /**
     * Record bandwidth measurement
     * Returns the bandwidth in Mbps or null if measurement interval hasn't passed
     */
    recordMeasurement(totalBytesDownloaded, currentTime = Date.now()) {
        const timeSinceLastMeasure = currentTime - this.lastMeasurementTime;
        
        // Only measure every measurementInterval ms to avoid noise
        if (timeSinceLastMeasure < this.measurementInterval) {
            return null;
        }

        const bytesDelta = totalBytesDownloaded - this.lastMeasuredBytes;
        const seconds = timeSinceLastMeasure / 1000;
        const mbps = (bytesDelta * 8) / (1_000_000 * seconds);

        this.measurements.push(mbps);
        if (this.measurements.length > this.maxMeasurements) {
            this.measurements.shift();
        }

        this.lastMeasurementTime = currentTime;
        this.lastMeasuredBytes = totalBytesDownloaded;

        return mbps;
    }

    /**
     * Get average bandwidth from recent measurements
     */
    getAverageBandwidth() {
        if (this.measurements.length === 0) return 0;
        const sum = this.measurements.reduce((a, b) => a + b, 0);
        return sum / this.measurements.length;
    }

    /**
     * Get current bandwidth (latest measurement)
     */
    getCurrentBandwidth() {
        return this.measurements.length > 0 ? this.measurements[this.measurements.length - 1] : 0;
    }

    /**
     * Recommend thread count based on bandwidth
     * Ranges from 1 to 16 threads
     */
    recommendThreadCount(mbps = null) {
        const bandwidth = mbps !== null ? mbps : this.getAverageBandwidth();

        if (bandwidth < 5) return 2;        // Slow: minimal threads
        if (bandwidth < 25) return 4;       // Medium: 4 threads
        if (bandwidth < 100) return 8;      // Fast: 8 threads
        return 16;                           // Very fast: 16 threads
    }

    /**
     * Reset detector for new download
     */
    reset() {
        this.measurements = [];
        this.lastMeasurementTime = 0;
        this.lastMeasuredBytes = 0;
    }
}

/**
 * DynamicChunkOptimizer - Combines file size + bandwidth for optimal chunking
 * Ensures chunks are sized appropriately for network conditions
 */
class DynamicChunkOptimizer {
    /**
     * Calculate optimal chunk size based on file size and current bandwidth
     * Chunk should complete in 2-5 seconds at current bandwidth for responsiveness
     */
    static getOptimalChunkSize(totalBytes, bandwidthMbps = 0) {
        const MB = 1024 * 1024;
        const sizeMB = totalBytes / MB;
        let baseChunkSize;

        // Base chunk size on file size
        if (sizeMB < 50) {
            baseChunkSize = 1 * MB;
        } else if (sizeMB < 200) {
            baseChunkSize = 2 * MB;
        } else if (sizeMB < 1000) {
            baseChunkSize = 4 * MB;
        } else {
            baseChunkSize = 8 * MB;
        }

        // If we have bandwidth info, adjust chunk size for 3-second download per chunk
        if (bandwidthMbps > 0.1) {
            // Target: chunk completes in 3 seconds
            const targetBytes = (bandwidthMbps * 1_000_000 / 8) * 3;
            // Use average of base size and bandwidth-based size for stability
            baseChunkSize = (baseChunkSize + targetBytes) / 2;
        }

        // Clamp between reasonable limits
        return Math.max(512 * 1024, Math.min(16 * MB, baseChunkSize));
    }

    /**
     * Calculate optimal thread count considering BOTH file size AND bandwidth
     * Combines both factors using a weighted average for optimal performance
     * Returns { threads, reason }
     */
    static calculateOptimalThreads(totalBytes, bandwidthMbps = 0, fileSizeBased = null) {
        const MB = 1024 * 1024;
        const sizeMB = totalBytes / MB;

        // ==================== FILE SIZE BASED CALCULATION ====================
        let fileThreads = 1;
        if (sizeMB < 5) {
            fileThreads = 1;
        } else if (sizeMB < 50) {
            fileThreads = Math.min(4, Math.ceil(sizeMB / 15));
        } else if (sizeMB < 200) {
            fileThreads = Math.min(8, Math.ceil(sizeMB / 25));
        } else {
            fileThreads = Math.min(16, Math.ceil(sizeMB / 50));
        }

        let threads = fileThreads;
        let reason = 'file-size-based';

        // ==================== BANDWIDTH BASED CALCULATION ====================
        if (bandwidthMbps > 0.1) {
            const bandwidthDetector = new BandwidthDetector();
            const bandwidthThreads = bandwidthDetector.recommendThreadCount(bandwidthMbps);
            
            // Combine both approaches: average them for balanced optimization
            threads = Math.round((fileThreads + bandwidthThreads) / 2);
            reason = `combined (${sizeMB.toFixed(0)}MB + ${bandwidthMbps.toFixed(1)} Mbps)`;
        }

        // Safety limits
        threads = Math.max(1, Math.min(16, threads));

        return { threads, reason };
    }
}

// Initialize global bandwidth detector
let bandwidthDetector = new BandwidthDetector();

function calculateDynamicThreads(totalBytes) {
    // First estimate: use file size
    const MB = 1024 * 1024;
    const sizeMB = totalBytes / MB;

    let threads;

    if (sizeMB < 5) {
        threads = 1;
    } else if (sizeMB < 50) {
        threads = Math.min(4, Math.ceil(sizeMB / 15));
    } else if (sizeMB < 200) {
        threads = Math.min(8, Math.ceil(sizeMB / 25));
    } else {
        threads = Math.min(16, Math.ceil(sizeMB / 50));
    }

    // Safety limits
    const MAX_THREADS = 16;
    const MIN_THREADS = 1;

    return Math.max(MIN_THREADS, Math.min(MAX_THREADS, threads));
}

function getDynamicChunkSize(totalBytes) {
    // Use bandwidth-aware optimizer if we have collected enough bandwidth data
    const avgBandwidth = bandwidthDetector.getAverageBandwidth();
    return DynamicChunkOptimizer.getOptimalChunkSize(totalBytes, avgBandwidth);
}

function createChunks(totalBytes, chunkSize = 2 * 1024 * 1024) {
    let start = 0;
    while (start < totalBytes) {
        let end = Math.min(start + chunkSize - 1, totalBytes - 1);
        chunkQueue.push({ start, end });
        start = end + 1;
    }
}

/**
 * Rebalance thread count based on current bandwidth
 * Called periodically during download to adapt to network changes
 */
function rebalanceThreadCount() {
    const currentBandwidth = bandwidthDetector.getAverageBandwidth();
    if (currentBandwidth < 0.1) return; // Not enough data yet
    
    const { threads: recommendedThreads } = DynamicChunkOptimizer.calculateOptimalThreads(
        globalTotalBytes,
        currentBandwidth
    );
    
    // Only rebalance if significant change (>20% difference)
    const percentChange = Math.abs(recommendedThreads - activeThreads) / activeThreads;
    if (percentChange > 0.2 && recommendedThreads !== activeThreads) {
        const oldThreads = activeThreads;
        activeThreads = recommendedThreads;
        
        console.log(
            `[Bandwidth] Rebalancing threads: ${oldThreads} → ${activeThreads} ` +
            `(Bandwidth: ${currentBandwidth.toFixed(2)} Mbps)`
        );
        
        // Broadcast the thread change to UI
        chrome.runtime.sendMessage({
            action: "threadCountUpdated",
            threads: activeThreads,
            bandwidth: currentBandwidth.toFixed(2)
        }).catch(() => {});
    }
}

function broadcastProgress() {
    if (isPaused) return; // Don't broadcast speed if paused
    if (!isDownloading) return; // Don't broadcast if not actively downloading

    const now = Date.now();
    // Throttle broadcasting to at most every 500ms
    if (now - lastProgressBroadcastTime < 500) return;
    lastProgressBroadcastTime = now;

    const elapsed = (now - startTime) / 1000;
    const speedBps = elapsed > 0 ? sessionDownloadedBytes / elapsed : 0;
    
    // ==================== BANDWIDTH DETECTION ====================
    // Measure bandwidth and rebalance threads if needed
    const measuredMbps = bandwidthDetector.recordMeasurement(sessionDownloadedBytes, now);
    if (measuredMbps !== null) {
        console.log(`[Bandwidth] Measured: ${measuredMbps.toFixed(2)} Mbps, Avg: ${bandwidthDetector.getAverageBandwidth().toFixed(2)} Mbps`);
        rebalanceThreadCount(); // Check if we should adjust threads
    }
    
    let speedText = `${(speedBps / 1024).toFixed(2)} KB/s`;
    if (speedBps > 1024 * 1024) {
        speedText = `${(speedBps / (1024 * 1024)).toFixed(2)} MB/s`;
    }

    const globalPercent = globalTotalBytes > 0 ? Math.round((globalDownloadedBytes / globalTotalBytes) * 100) : 0;

    const threadsData = Object.keys(threadProgress).map(id => ({
        id: id,
        percent: threadProgress[id].percent,
        downloadedMB: threadProgress[id].downloadedMB,
        totalMB: threadProgress[id].totalMB
    }));

    const avgBandwidth = bandwidthDetector.getAverageBandwidth();

    chrome.runtime.sendMessage({
        action: "updateProgress",
        globalPercent: globalPercent,
        speed: speedText,
        globalDownloadedMB: globalDownloadedBytes / (1024 * 1024),
        globalTotalMB: globalTotalBytes / (1024 * 1024),
        threadsData: threadsData,
        bandwidth: avgBandwidth > 0 ? avgBandwidth.toFixed(2) : "--",
        activeThreads: activeThreads,
        chunkCount: chunkQueue.length
    }).catch(() => {}); 
}

async function downloadWorker(url, id) {
    let retryCount = 0;

    while (true) {
        if (isPaused || !isDownloading) break;

        // 🔹 Get next chunk
        const chunk = chunkQueue.shift();
        if (!chunk) break;

        const chunkSize = chunk.end - chunk.start + 1;

        threadProgress[id] = {
            percent: 0,
            downloadedMB: 0,
            totalMB: chunkSize / (1024 * 1024),
            source: 'server'
        };

        let downloaded = 0;

        try {
            // 🔥 Keep fetching continuously (connection reuse benefit)
            const response = await fetch(url, {
                headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
                signal: AbortSignal.timeout(30000)
            });

            if (!response.ok && response.status !== 206) {
                throw new Error(`HTTP ${response.status}`);
            }

            const reader = response.body.getReader();
            const chunks = [];

            while (true) {
                if (isPaused || !isDownloading) {
                    await reader.cancel();
                    await saveCheckpoint();

                    // 🔁 Put remaining back
                    chunkQueue.unshift({
                        start: chunk.start + downloaded,
                        end: chunk.end
                    });
                    return;
                }

                const { done, value } = await reader.read();
                if (done) break;

                chunks.push(value);
                downloaded += value.length;

                globalDownloadedBytes += value.length;
                sessionDownloadedBytes += value.length;

                threadProgress[id].percent = Math.round((downloaded / chunkSize) * 100);
                threadProgress[id].downloadedMB = downloaded / (1024 * 1024);

                broadcastProgress();
            }

            // ✅ Save chunk
            const blob = new Blob(chunks);
            results.push({ start: chunk.start, data: blob });

            threadProgress[id].percent = 100;

            await saveCheckpoint();

            retryCount = 0; // reset retry after success

        } catch (err) {
            console.warn(`[Worker ${id}] Error:`, err.message);

            // 🔁 Retry with exponential backoff
            retryCount++;
            const delay = Math.min(2000 * Math.pow(2, retryCount), 15000);

            // Requeue chunk
            chunkQueue.unshift({
                start: chunk.start + downloaded,
                end: chunk.end
            });

            await saveCheckpoint();

            await new Promise(res => setTimeout(res, delay));

            // ❌ Too many retries → exit worker
            if (retryCount > 5) {
                console.error(`[Worker ${id}] Too many retries, stopping`);
                return;
            }
        }
    }
}

async function startWorkers() {
    sessionDownloadedBytes = 0;
    startTime = Date.now();
    const workers = [];
    
    for (let i = 0; i < activeThreads; i++) {
        workers.push(downloadWorker(currentTargetUrl, i));
    }

    await Promise.all(workers);

    // Only merge if the queue is completely empty and we aren't paused
    if (!isPaused && chunkQueue.length === 0) {
        mergeChunks();
    }
}

function initDownload(url, totalBytes) {
    isDownloading = true;
    isPaused = false;
    downloadCompleted = false;
    currentTargetUrl = url;
    chunkQueue = [];
    results = [];
    threadProgress = {};
    globalDownloadedBytes = 0;
    globalTotalBytes = totalBytes;
    lastProgressBroadcastTime = 0;
    
    // ==================== ADAPTIVE BANDWIDTH DETECTION ====================
    // Reset bandwidth detector for new download
    bandwidthDetector.reset();
    
    // Clear any existing broadcast timeouts
    if (broadcastTimeoutId) {
        clearTimeout(broadcastTimeoutId);
        broadcastTimeoutId = null;
    }

    // Clear old checkpoint before starting new download (WAL)
    clearCheckpoint();

    // Initial thread count based on file size (will be adjusted by bandwidth detection)
    activeThreads = calculateDynamicThreads(totalBytes);
    console.log(`[Init] Starting with ${activeThreads} threads for ${(totalBytes / (1024 * 1024)).toFixed(2)} MB file`);

    // Chunk size optimized for file size (will adapt as bandwidth is measured)
    const chunkSize = getDynamicChunkSize(totalBytes);
    console.log(`[Init] Using chunk size: ${(chunkSize / (1024 * 1024)).toFixed(2)} MB`);
    
    createChunks(totalBytes, chunkSize);

    // ==================== SWARM: Initialize P2P swarm ====================
    if (swarmEnabled) {
        initializeSwarm(url);
        console.log('[SWARM] P2P swarm initialized for distributed downloading');
    }

    // ==================== BROADCAST INITIAL STATE ====================
    // Send initial progress update so UI shows correct file size from the start
    const initialPercent = globalTotalBytes > 0 ? Math.round((0 / globalTotalBytes) * 100) : 0;
    chrome.runtime.sendMessage({
        action: "updateProgress",
        globalPercent: initialPercent,
        speed: "0 KB/s",
        globalDownloadedMB: 0,
        globalTotalMB: (globalTotalBytes / (1024 * 1024)).toFixed(2),
        threadsData: [],
        bandwidth: null,
        activeThreads: activeThreads
    }).catch(() => {});

    startWorkers();
}
async function mergeChunks() {
    results.sort((a, b) => a.start - b.start);
    const blobs = results.map(r => r.data);
    const finalBlob = new Blob(blobs);

    const reader = new FileReader();
    reader.onloadend = async function () {
        chrome.downloads.download({
            url: reader.result,
            filename: "fragment_download.bin",
            saveAs: true
        });
        isDownloading = false;
        downloadCompleted = true;
        
        // ==================== SWARM: Cleanup P2P swarm ====================
        if (swarmEnabled) {
            cleanupSwarm();
        }
        
        // Clear checkpoint after successful completion (WAL cleanup)
        await clearCheckpoint();
        resumeAttempts = 0; // Reset resume counter on successful completion
        
        // Clear any pending timeouts
        if (broadcastTimeoutId) {
            clearTimeout(broadcastTimeoutId);
            broadcastTimeoutId = null;
        }
        
        // Notify popup that download is complete
        chrome.runtime.sendMessage({
            action: "downloadComplete",
            totalMB: (globalTotalBytes / (1024 * 1024)).toFixed(2),
            downloadedMB: (globalDownloadedBytes / (1024 * 1024)).toFixed(2)
        }).catch(() => {});
        
        // Reset state after a delay
        setTimeout(() => {
            isDownloading = false;
            isPaused = false;
            downloadCompleted = false;
            chunkQueue = [];
            results = [];
            threadProgress = {};
            globalDownloadedBytes = 0;
            sessionDownloadedBytes = 0;
            globalTotalBytes = 0;
        }, 2000);
    };
    reader.readAsDataURL(finalBlob);
}

function openCenteredPopup() {
    chrome.windows.getLastFocused((win) => {
        const width = 420;
        const height = 450;
        const left = Math.round(win.left + (win.width / 2) - (width / 2));
        const top = Math.round(win.top + (win.height / 2) - (height / 2));

        chrome.windows.create({
            url: chrome.runtime.getURL("popup.html"),
            type: "popup",
            width: width,
            height: height,
            left: left,
            top: top,
            focused: true
        });
    });
}

chrome.downloads.onCreated.addListener(async (downloadItem) => {
    if (!downloadItem.url.startsWith("http")) return;

    chrome.downloads.cancel(downloadItem.id);

    try {
        const response = await fetch(downloadItem.url, { method: "HEAD" });
        const contentLength = response.headers.get("Content-Length");

        if (contentLength) {
            globalTotalBytes = parseInt(contentLength);
            isDownloading = true; 

            openCenteredPopup();
            initDownload(downloadItem.url, globalTotalBytes);
        }
    } catch (err) {
        if (downloadItem.totalBytes > 0) {
            globalTotalBytes = downloadItem.totalBytes;
            isDownloading = true;
            
            openCenteredPopup();
            initDownload(downloadItem.url, downloadItem.totalBytes);
        }
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "getStatus") {
        sendResponse({ 
            isDownloading: isDownloading,
            isPaused: isPaused,
            downloadCompleted: downloadCompleted,
            threads: activeThreads 
        });

        // Only send additional info if actively downloading
        if (isDownloading && !isPaused) {
            // Clear any existing timeout to prevent multiple simultaneous timeouts
            if (broadcastTimeoutId) {
                clearTimeout(broadcastTimeoutId);
            }
            
            broadcastTimeoutId = setTimeout(() => {
                chrome.runtime.sendMessage({
                    action: "downloadInfo",
                    supported: true,
                    sizeMB: (globalTotalBytes / (1024 * 1024)).toFixed(2),
                    threads: activeThreads
                }).catch(() => {});
                broadcastProgress(); // Force UI to jump to current progress
                broadcastTimeoutId = null;
            }, 200);
        }
    }
    
    // Handle UI controls
    if (message.action === "pause") {
        isPaused = true;
        // Save checkpoint when paused (WAL)
        saveCheckpoint();
    }
    if (message.action === "resume") {
        isPaused = false;
        startWorkers();
    }
    
    // Handle Stop - completely halt the download
    if (message.action === "stop") {
        isDownloading = false;
        isPaused = true;
        downloadCompleted = false;
        
        // Clear the queue so workers stop immediately
        chunkQueue = [];
        
        // ==================== SWARM: Cleanup on stop ====================
        if (swarmEnabled) {
            cleanupSwarm();
        }
        
        // Clear any pending timeouts
        if (broadcastTimeoutId) {
            clearTimeout(broadcastTimeoutId);
            broadcastTimeoutId = null;
        }
        
        // Reset all state
        results = [];
        threadProgress = {};
        globalDownloadedBytes = 0;
        sessionDownloadedBytes = 0;
        globalTotalBytes = 0;
        currentTargetUrl = "";
        lastProgressBroadcastTime = 0;
    }
    
    // ==================== SWARM: Get swarm statistics ====================
    if (message.action === "getSwarmStats") {
        const stats = swarmEnabled ? getSwarmStats() : { swarmEnabled: false };
        sendResponse(stats);
    }
    
    return true;
});