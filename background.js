
chrome.downloads.onCreated.addListener(async (downloadItem) => {
    console.log("Fragment Flow detected a new download:", downloadItem.url);

    // Pause the default Chrome download immediately
    chrome.downloads.pause(downloadItem.id, () => {
        console.log("Default download paused. Analyzing server capabilities...");
    });

    try {
        // Attempt a HEAD request to check for multithreading support
        const response = await fetch(downloadItem.url, { method: 'HEAD' });
        
        const acceptRanges = response.headers.get('Accept-Ranges');
        const contentLength = response.headers.get('Content-Length');

        if (acceptRanges === 'bytes' && contentLength) {
            // Server explicitly allows splitting
            const totalBytes = parseInt(contentLength, 10);
            const sizeInMB = (totalBytes / (1024 * 1024)).toFixed(2);
            const threads = 4;
            const chunkSize = Math.floor(totalBytes / threads);
            
            console.log(`Success! File is ${sizeInMB} MB. Supports splitting.`);
            console.log(`Allocating ${threads} threads at ~${chunkSize} bytes each.`);
            
            // Send data to the Popup UI
            chrome.runtime.sendMessage({
                action: "downloadInfo",
                supported: true,
                sizeMB: sizeInMB,
                threads: threads
            }).catch(() => {});

            // [DAY 3: Akarshana's chunk downloading code will go here]

        } else {
            // Server actively refuses splitting
            console.warn("Server does not support multithreading. Falling back to default.");
            chrome.runtime.sendMessage({ action: "downloadInfo", supported: false }).catch(() => {});
            chrome.downloads.resume(downloadItem.id);
        }

    } catch (error) {

        console.warn("HEAD request blocked by server (CORS). Activating Smart Fallback...");

        if (downloadItem.totalBytes > 0) {
            // Chrome already figured out the file size for us!
            const sizeInMB = (downloadItem.totalBytes / (1024 * 1024)).toFixed(2);
            const threads = 4;
            const chunkSize = Math.floor(downloadItem.totalBytes / threads);

            console.log(`Fallback Success! Chrome reports file is ${sizeInMB} MB.`);
            console.log(`Ready to allocate ${threads} threads at ~${chunkSize} bytes each.`);

            chrome.runtime.sendMessage({
                action: "downloadInfo",
                supported: true,
                sizeMB: sizeInMB,
                threads: threads
            }).catch(() => {});

            // [Akarshana's chunk downloading code will go here]

        } else {
            // File size is entirely unknown (e.g., dynamic live stream file)
            console.error("File size is completely unknown. Resuming standard Chrome download.");
            chrome.runtime.sendMessage({ action: "downloadInfo", supported: false }).catch(() => {});
            chrome.downloads.resume(downloadItem.id);
        }
    }
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Message received from Popup:", message.action);

    if (message.action === "getStatus") {
        sendResponse({ status: "Manager Active", threads: 4 });
    } 
    else if (message.action === "testConnection") {
        console.log("Handshake successful. Communication bridge active.");
        sendResponse({ success: true });
    }

    return true; 
});