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
    const stopBtn = document.getElementById('stop-btn');
    
    // Swarm UI elements
    const swarmCard = document.getElementById('swarm-card');
    const peerCountBadge = document.getElementById('peer-count');
    const swarmConnectedPeers = document.getElementById('swarm-connected-peers');
    const swarmLocalChunks = document.getElementById('swarm-local-chunks');
    const swarmTotalChunks = document.getElementById('swarm-total-chunks');

    // ==================== BANDWIDTH UI ELEMENTS ====================
    const bandwidthCard = document.getElementById('bandwidth-card');
    const bandwidthBadge = document.getElementById('bandwidth-badge');
    const bandwidthValue = document.getElementById('bandwidth-value');
    const adaptiveThreads = document.getElementById('adaptive-threads');
    const chunkSize = document.getElementById('chunk-size');

    let threadElements = {};
    let isPaused = false;
    let swarmStatsInterval = null;
    let uiInitialized = false; // Track if download UI has been initialized

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

    // Handle Stop click - completely halt the download
    stopBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "stop" });
        statusBadge.innerText = "Stopped";
        statusBadge.className = "badge bg-danger text-white";
        actionBtn.style.display = 'none';
        stopBtn.style.display = 'none';
        fileNameEl.innerText = "Download stopped";
        globalSpeedEl.innerText = "0 KB/s";
        uiInitialized = false; // Reset for next download
        
        // Stop swarm stats polling
        if (swarmStatsInterval) {
            clearInterval(swarmStatsInterval);
            swarmStatsInterval = null;
        }
        swarmCard.style.display = 'none';
        bandwidthCard.style.display = 'none';
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
        stopBtn.style.display = 'inline-block'; // Show stop button
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
        
        uiInitialized = true;
        
        // ==================== SWARM: Start polling swarm stats ====================
        startSwarmStatsPoll();
    }
    
    // ==================== SWARM FUNCTIONS ====================
    function startSwarmStatsPoll() {
        if (swarmStatsInterval) clearInterval(swarmStatsInterval);
        
        // Poll swarm stats every 2 seconds
        swarmStatsInterval = setInterval(() => {
            chrome.runtime.sendMessage({ action: "getSwarmStats" }, (response) => {
                if (!chrome.runtime.lastError && response) {
                    updateSwarmUI(response);
                }
            });
        }, 2000);
        
        // Fetch immediately
        chrome.runtime.sendMessage({ action: "getSwarmStats" }, (response) => {
            if (!chrome.runtime.lastError && response) {
                updateSwarmUI(response);
            }
        });
    }
    
    function updateSwarmUI(swarmStats) {
        // Check if swarm is enabled
        const swarmEnabled = swarmStats.swarmEnabled !== false;
        
        if (!swarmEnabled || swarmStats.connectedPeers === 0) {
            // Hide swarm card if no peers connected
            if (swarmStats.connectedPeers === 0) {
                swarmCard.style.display = 'none';
            }
            return;
        }
        
        // Show swarm card if peers are connected
        swarmCard.style.display = 'block';
        
        // Update swarm stats
        const connectedPeers = swarmStats.connectedPeers || 0;
        const localChunks = swarmStats.localChunks || 0;
        const totalChunks = swarmStats.totalChunksInSwarm || 0;
        
        peerCountBadge.innerText = `${connectedPeers} peer${connectedPeers !== 1 ? 's' : ''}`;
        swarmConnectedPeers.innerText = connectedPeers;
        swarmLocalChunks.innerText = localChunks;
        swarmTotalChunks.innerText = totalChunks;
        
        // Change color based on network health
        if (connectedPeers > 0) {
            peerCountBadge.className = 'badge bg-success';
        }
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "downloadInfo") {
            if (message.supported && !uiInitialized) {
                initDownloadUI("Target File", parseFloat(message.sizeMB), message.threads);
            }
        } 
        else if (message.action === "updateProgress") {
            // Auto-initialize UI if not already done (for fast initial broadcast)
            if (!uiInitialized && message.globalTotalMB && message.activeThreads) {
                initDownloadUI("Target File", parseFloat(message.globalTotalMB), message.activeThreads);
            }

            globalProgress.style.width = `${message.globalPercent}%`;
            globalPercentEl.innerText = `${message.globalPercent}%`;
            globalSpeedEl.innerText = message.speed || "0 KB/s";
            
            // Display file size with proper formatting
            const downloadedMB = parseFloat(message.globalDownloadedMB).toFixed(2);
            const totalMB = typeof message.globalTotalMB === 'string' 
                ? message.globalTotalMB 
                : parseFloat(message.globalTotalMB).toFixed(2);
            globalStatsEl.innerText = `${downloadedMB} / ${totalMB} MB`;

            // ==================== BANDWIDTH DISPLAY ====================
            if (message.bandwidth) {
                bandwidthCard.style.display = 'block';
                
                if (message.bandwidth === "--") {
                    bandwidthValue.innerText = "Measuring...";
                    bandwidthBadge.innerText = "Measuring";
                    bandwidthBadge.className = 'badge bg-secondary';
                } else {
                    const mbps = parseFloat(message.bandwidth);
                    bandwidthValue.innerText = `${message.bandwidth} Mbps`;
                    bandwidthBadge.innerText = `${message.bandwidth} Mbps`;
                    
                    // Update badge color based on bandwidth
                    if (mbps < 5) {
                        bandwidthBadge.className = 'badge bg-danger';
                    } else if (mbps < 25) {
                        bandwidthBadge.className = 'badge bg-warning';
                    } else if (mbps < 100) {
                        bandwidthBadge.className = 'badge bg-info';
                    } else {
                        bandwidthBadge.className = 'badge bg-success';
                    }
                }
            }

            // Update active thread count if changed
            if (message.activeThreads) {
                adaptiveThreads.innerText = message.activeThreads;
                threadCountEl.innerText = message.activeThreads;
            }

            // Display chunk count if available
            if (message.chunkCount !== undefined) {
                // Can be used for debug info if needed
                console.log(`Chunks remaining: ${message.chunkCount}`);
            }

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
        else if (message.action === "threadCountUpdated") {
            // Handle thread rebalancing notification
            console.log(`Thread count updated to ${message.threads} (${message.bandwidth} Mbps)`);
            adaptiveThreads.innerText = message.threads;
            threadCountEl.innerText = message.threads;
            
            // Flash the badge to indicate change
            threadCountEl.style.animation = 'none';
            setTimeout(() => {
                threadCountEl.style.animation = 'pulse 0.5s';
            }, 10);
        }
        else if (message.action === "downloadComplete") {
            statusBadge.innerText = "Downloaded";
            statusBadge.className = "badge bg-success text-white";
            actionBtn.style.display = 'none'; 
            fileNameEl.innerText = "Download Complete!";
            globalProgress.style.width = "100%";
            globalPercentEl.innerText = "100%";
            globalSpeedEl.innerText = "0 KB/s";
            uiInitialized = false; // Reset for next download
            
            // Display final file size
            const totalMB = parseFloat(message.totalMB) || 0;
            const downloadedMB = parseFloat(message.downloadedMB) || 0;
            globalStatsEl.innerText = `${downloadedMB.toFixed(2)} / ${totalMB.toFixed(2)} MB`;
            
            // Stop swarm stats polling
            if (swarmStatsInterval) {
                clearInterval(swarmStatsInterval);
                swarmStatsInterval = null;
            }
            swarmCard.style.display = 'none';
            bandwidthCard.style.display = 'none';
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
                 // Start swarm stats polling
                 startSwarmStatsPoll();
            }
        }
    });
});