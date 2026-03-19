document.addEventListener('DOMContentLoaded', () => {
    const statusBadge = document.getElementById('status-badge');
    const fileNameEl = document.getElementById('file-name');
    const globalStatsEl = document.getElementById('global-stats');
    const globalProgress = document.getElementById('global-progress');
    const globalSpeedEl = document.getElementById('global-speed');
    const globalPercentEl = document.getElementById('global-percent');
    const threadsContainer = document.getElementById('threads-container');
    const threadCountEl = document.getElementById('thread-count');
    const noThreadsMsg = document.getElementById('no-threads-msg');
    const actionBtn = document.getElementById('action-btn');

    let threadElements = {};
    let isPaused = false;

    // Handle Pause/Resume clicks
    actionBtn.addEventListener('click', () => {
        isPaused = !isPaused;
        if (isPaused) {
            chrome.runtime.sendMessage({ action: "pause" });
            setUIPaused();
        } else {
            chrome.runtime.sendMessage({ action: "resume" });
            setUIResumed();
        }
    });

    function setUIPaused() {
        actionBtn.innerText = "Resume";
        actionBtn.classList.replace('text-primary', 'text-success');
        statusBadge.innerText = "Paused";
        statusBadge.classList.replace('text-success', 'text-warning');
        globalSpeedEl.innerText = "0 KB/s";
    }

    function setUIResumed() {
        actionBtn.innerText = "Pause";
        actionBtn.classList.replace('text-success', 'text-primary');
        statusBadge.innerText = "Downloading";
        statusBadge.classList.replace('text-warning', 'text-success');
    }

    function initDownloadUI(fileName, totalMB, numThreads) {
        statusBadge.innerText = "Downloading";
        statusBadge.classList.replace('text-primary', 'text-success');
        actionBtn.style.display = 'inline-block'; // Show the button
        fileNameEl.innerText = fileName || "fragment_download.bin";
        globalStatsEl.innerText = `0.00 / ${totalMB.toFixed(2)} MB`;
        threadCountEl.innerText = numThreads;
        
        threadsContainer.innerHTML = '';
        threadElements = {};
        noThreadsMsg.style.display = 'none';

        for (let i = 0; i < numThreads; i++) {
            const threadRow = document.createElement('div');
            threadRow.className = 'thread-row';
            threadRow.innerHTML = `
                <div class="d-flex justify-content-between x-small mb-1">
                    <span class="text-muted fw-bold">Part ${i + 1}</span>
                    <span id="thread-stats-${i}" class="text-secondary">0.00 / 0.00 MB</span>
                </div>
                <div class="progress thread-bar">
                    <div id="thread-progress-${i}" class="progress-bar bg-info" style="width: 0%"></div>
                </div>
            `;
            threadsContainer.appendChild(threadRow);
            threadElements[i] = {
                bar: document.getElementById(`thread-progress-${i}`),
                stats: document.getElementById(`thread-stats-${i}`)
            };
        }
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "downloadInfo") {
            if (message.supported) {
                initDownloadUI("Target File", parseFloat(message.sizeMB), message.threads);
            }
        } 
        else if (message.action === "updateProgress") {
            globalProgress.style.width = `${message.globalPercent}%`;
            globalPercentEl.innerText = `${message.globalPercent}%`;
            globalSpeedEl.innerText = message.speed || "0 KB/s";
            globalStatsEl.innerText = `${message.globalDownloadedMB.toFixed(2)} / ${message.globalTotalMB.toFixed(2)} MB`;

            if (message.threadsData) {
                message.threadsData.forEach(thread => {
                    const elements = threadElements[thread.id];
                    if (elements) {
                        elements.bar.style.width = `${thread.percent}%`;
                        elements.stats.innerText = `${thread.downloadedMB.toFixed(2)} / ${thread.totalMB.toFixed(2)} MB`;
                        if (thread.percent >= 100) {
                            elements.bar.classList.replace('bg-info', 'bg-success');
                        }
                    }
                });
            }
        }
        else if (message.action === "downloadComplete") {
            statusBadge.innerText = "Downloaded";
            statusBadge.className = "badge bg-success text-white";
            actionBtn.style.display = 'none'; 
            fileNameEl.innerText = "Download Complete!";
            globalProgress.style.width = "100%";
            globalPercentEl.innerText = "100%";
            globalSpeedEl.innerText = "0 KB/s";
        }
    });

    chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
        if (!chrome.runtime.lastError && response) {
            if (response.downloadCompleted) {
                statusBadge.innerText = "Downloaded";
                statusBadge.className = "badge bg-success text-white";
                actionBtn.style.display = 'none';
                fileNameEl.innerText = "✓ Download Complete!";
                globalProgress.style.width = "100%";
                globalPercentEl.innerText = "100%";
            } else if (response.isDownloading) {
                 actionBtn.style.display = 'inline-block';
                 if (response.isPaused) {
                     isPaused = true;
                     setUIPaused();
                 }
            }
        }
    });
});