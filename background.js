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

    const now = Date.now();
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
        
        threadProgress[id] = {
            percent: 0,
            downloadedMB: 0,
            totalMB: chunkSize / (1024 * 1024)
        };

        const response = await fetch(url, {
            headers: { Range: `bytes=${chunk.start}-${chunk.end}` }
        });

        const reader = response.body.getReader();
        const chunks = [];
        let downloaded = 0;

        while (true) {
            if (isPaused) {
                await reader.cancel(); // Abort the fetch stream immediately
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

        // Save whatever we managed to download
        if (chunks.length > 0) {
            const blob = new Blob(chunks);
            results.push({ start: chunk.start, data: blob });
        }

        // If we paused before finishing the chunk, put the remainder back in the queue
        if (isPaused && downloaded < chunkSize) {
            chunkQueue.unshift({
                start: chunk.start + downloaded,
                end: chunk.end
            });
            break;
        }
        
        if (!isPaused) {
            threadProgress[id].percent = 100;
            broadcastProgress();
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

    activeThreads = calculateDynamicThreads(totalBytes);

    const chunkSize = getDynamicChunkSize(totalBytes);
    createChunks(totalBytes, chunkSize);

    startWorkers();
}
async function mergeChunks() {
    results.sort((a, b) => a.start - b.start);
    const blobs = results.map(r => r.data);
    const finalBlob = new Blob(blobs);

    const reader = new FileReader();
    reader.onloadend = function () {
        chrome.downloads.download({
            url: reader.result,
            filename: "fragment_download.bin",
            saveAs: true
        });
        isDownloading = false;
        downloadCompleted = true;
        
        // Notify popup that download is complete
        chrome.runtime.sendMessage({
            action: "downloadComplete"
        }).catch(() => {});
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

        if (isDownloading) {
            setTimeout(() => {
                chrome.runtime.sendMessage({
                    action: "downloadInfo",
                    supported: true,
                    sizeMB: (globalTotalBytes / (1024 * 1024)).toFixed(2),
                    threads: activeThreads
                }).catch(() => {});
                broadcastProgress(); // Force UI to jump to current progress
            }, 200);
        }
    }
    
    // Handle UI controls
    if (message.action === "pause") {
        isPaused = true;
    }
    if (message.action === "resume") {
        isPaused = false;
        startWorkers();
    }
    
    return true;
});