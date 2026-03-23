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
restoreCheckpoint();
function calculateDynamicThreads(totalBytes) {
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
    const MB = 1024 * 1024;
    const sizeMB = totalBytes / MB;

    if (sizeMB < 50) return 1 * MB;
    if (sizeMB < 200) return 2 * MB;
    if (sizeMB < 1000) return 4 * MB;
    return 8 * MB;
}

function createChunks(totalBytes, chunkSize = 2 * 1024 * 1024) {
    let start = 0;
    while (start < totalBytes) {
        let end = Math.min(start + chunkSize - 1, totalBytes - 1);
        chunkQueue.push({ start, end });
        start = end + 1;
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

    chrome.runtime.sendMessage({
        action: "updateProgress",
        globalPercent: globalPercent,
        speed: speedText,
        globalDownloadedMB: globalDownloadedBytes / (1024 * 1024),
        globalTotalMB: globalTotalBytes / (1024 * 1024),
        threadsData: threadsData
    }).catch(() => {}); 
}

async function downloadWorker(url, id) {
    while (chunkQueue.length > 0) {
        if (isPaused) break;

        const chunk = chunkQueue.shift();
        if (!chunk) break;

        const chunkSize = chunk.end - chunk.start + 1;
        const chunkKey = `${chunk.start}-${chunk.end}`; // Cache key for swarm
        
        threadProgress[id] = {
            percent: 0,
            downloadedMB: 0,
            totalMB: chunkSize / (1024 * 1024),
            source: 'server' // Track where chunk comes from
        };

        try {
            let blob = null;
            let fromPeer = false;

            // ==================== SWARM: Try peer first ====================
            if (swarmEnabled && Object.keys(peers).length > 0) {
                try {
                    console.log(`[SWARM] Attempting to get chunk ${chunkKey} from peer...`);
                    blob = await requestChunkFromPeer(chunkKey);
                    fromPeer = true;
                    threadProgress[id].source = 'peer';
                    console.log(`[SWARM] Successfully retrieved chunk ${chunkKey} from peer!`);
                } catch (peerError) {
                    console.log(`[SWARM] Peer fetch failed, fallback to server: ${peerError.message}`);
                    blob = null; // Fall back to server
                }
            }

            // ==================== FALLBACK: Download from server ====================
            if (!blob) {
                const response = await fetch(url, {
                    headers: { Range: `bytes=${chunk.start}-${chunk.end}` }
                });

                const reader = response.body.getReader();
                const chunks = [];
                let downloaded = 0;

                while (true) {
                    if (isPaused) {
                        await reader.cancel(); // Abort the fetch stream immediately
                        await saveCheckpoint();
                        break;
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

                if (chunks.length > 0) {
                    blob = new Blob(chunks);
                    threadProgress[id].source = 'server';
                }
            }

            // Save whatever we managed to download
            if (blob) {
                results.push({ start: chunk.start, data: blob });
                
                // ==================== SWARM: Cache chunk for peer sharing ====================
                if (swarmEnabled) {
                    cacheChunkLocally(chunkKey, blob);
                }
                
                // Save checkpoint after successful chunk completion (WAL)
                await saveCheckpoint();
                
                threadProgress[id].percent = 100;
                threadProgress[id].downloadedMB = chunkSize / (1024 * 1024);
            }

            // If we paused before finishing the chunk, put the remainder back in the queue
            if (isPaused && !blob) {
                chunkQueue.unshift({
                    start: chunk.start + downloaded,
                    end: chunk.end
                });
                break;
            }
            
            if (!isPaused && blob) {
                threadProgress[id].percent = 100;
                broadcastProgress();
            }
        } catch (error) {
            // Network error occurred - put chunk back in queue and save checkpoint
            console.error(`[Download] Network error for chunk ${id}:`, error);
            chunkQueue.unshift(chunk); // Re-queue the failed chunk
            await saveCheckpoint(); // Persist state before breaking
            break; // Stop this worker, will retry on next resume
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
    
    // Clear any existing broadcast timeouts
    if (broadcastTimeoutId) {
        clearTimeout(broadcastTimeoutId);
        broadcastTimeoutId = null;
    }

    // Clear old checkpoint before starting new download (WAL)
    clearCheckpoint();

    activeThreads = calculateDynamicThreads(totalBytes);

    const chunkSize = getDynamicChunkSize(totalBytes);
    createChunks(totalBytes, chunkSize);

    // ==================== SWARM: Initialize P2P swarm ====================
    if (swarmEnabled) {
        initializeSwarm(url);
        console.log('[SWARM] P2P swarm initialized for distributed downloading');
    }

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
        
        // Clear any pending timeouts
        if (broadcastTimeoutId) {
            clearTimeout(broadcastTimeoutId);
            broadcastTimeoutId = null;
        }
        
        // Notify popup that download is complete
        chrome.runtime.sendMessage({
            action: "downloadComplete"
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