document.addEventListener('DOMContentLoaded', () => {
    const statusText = document.getElementById('status-text');
    const threadCount = document.getElementById('thread-count');
    const progressBar = document.getElementById('main-progress');
    const percentDisplay = document.getElementById('percent-display');
    const speedDisplay = document.getElementById('speed-display');
    const testBtn = document.getElementById('test-btn');

    chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Connection Error:", chrome.runtime.lastError);
            statusText.innerText = "Error connecting to manager.";
            return;
        }

        if (response) {
            statusText.innerText = response.status;
            threadCount.innerText = response.threads || 0;
            if (response.progress) {
                updateUI(response.progress, response.speed);
            }
        }
    });

    testBtn.addEventListener('click', () => {
        testBtn.disabled = true;
        testBtn.innerText = "Checking...";

        chrome.runtime.sendMessage({ action: "testConnection" }, (response) => {
            if (response && response.success) {
                // Change button style using Bootstrap classes
                testBtn.classList.replace('btn-primary', 'btn-success');
                testBtn.innerText = "Manager Connected!";
                statusText.innerText = "Ready to accelerate downloads.";
            } else {
                testBtn.classList.replace('btn-primary', 'btn-danger');
                testBtn.innerText = "Connection Failed";
            }
        });
    });

    function updateUI(percent, speed) {
        // Update the width of the Bootstrap progress bar
        progressBar.style.width = `${percent}%`;
        progressBar.setAttribute('aria-valuenow', percent);
        
        // Update text displays
        percentDisplay.innerText = `${percent}%`;
        speedDisplay.innerText = speed || "0 KB/s";
        
        if (percent > 0) {
            statusText.innerText = "Downloading segments...";
        }
    }
});