let chunkQueue = [];
let results = [];
let activeThreads = 4;

function createChunks(totalBytes, chunkSize = 2 * 1024 * 1024) {

    console.log("Creating chunks...");

    let start = 0;

    while (start < totalBytes) {

        let end = Math.min(start + chunkSize - 1, totalBytes - 1);

        chunkQueue.push({ start, end });

        console.log("Chunk created:", start, "-", end);

        start = end + 1;
    }

    console.log("Total chunks:", chunkQueue.length);
}

async function downloadWorker(url, id) {

    console.log("Worker", id, "started");

    while (chunkQueue.length > 0) {

        const chunk = chunkQueue.shift();

        if (!chunk) break;

        console.log("Worker", id, "downloading", chunk.start, "-", chunk.end);

        const response = await fetch(url, {
            headers: {
                Range: `bytes=${chunk.start}-${chunk.end}`
            }
        });

        const blob = await response.blob();

        console.log("Worker", id, "finished", chunk.start, "-", chunk.end);

        results.push({
            start: chunk.start,
            data: blob
        });
    }

    console.log("Worker", id, "finished all tasks");
}

async function startDownload(url, totalBytes) {

    console.log("Starting multithread download");

    chunkQueue = [];
    results = [];

    createChunks(totalBytes);

    const workers = [];

    for (let i = 0; i < activeThreads; i++) {

        workers.push(downloadWorker(url, i));
    }

    await Promise.all(workers);

    console.log("All workers completed");

    mergeChunks();
}

async function mergeChunks() {

    console.log("Merging chunks...");

    results.sort((a, b) => a.start - b.start);

    const blobs = results.map(r => r.data);

    const finalBlob = new Blob(blobs);

    console.log("Final file size:", finalBlob.size);

    const reader = new FileReader();

    reader.onloadend = function () {

        chrome.downloads.download({
            url: reader.result,
            filename: "fragment_download.bin",
            saveAs: true
        });

        console.log("Download triggered successfully");

    };

    reader.readAsDataURL(finalBlob);
}

chrome.downloads.onCreated.addListener(async (downloadItem) => {
    if (!downloadItem.url.startsWith("http")) {
        console.log("Ignoring internal extension download");
        return;
    }
    console.log("Fragment Flow detected download:", downloadItem.url);

    chrome.downloads.cancel(downloadItem.id);

    try {

        console.log("Checking file size...");

        const response = await fetch(downloadItem.url, { method: "HEAD" });

        const contentLength = response.headers.get("Content-Length");

        if (contentLength) {

            const totalBytes = parseInt(contentLength);

            const sizeMB = (totalBytes / (1024 * 1024)).toFixed(2);

            console.log("File size:", sizeMB, "MB");

            console.log("Using", activeThreads, "threads");

            chrome.runtime.sendMessage({
                action: "downloadInfo",
                supported: true,
                sizeMB: sizeMB,
                threads: activeThreads
            }).catch(() => {});

            startDownload(downloadItem.url, totalBytes);

        } else {

            console.warn("Server did not return file size");

        }

    } catch (err) {

        console.warn("HEAD request blocked, using fallback");

        if (downloadItem.totalBytes > 0) {

            startDownload(downloadItem.url, downloadItem.totalBytes);

        } else {

            console.error("Unable to determine file size");

        }
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === "getStatus") {

        sendResponse({
            status: "Manager Active",
            threads: activeThreads
        });

    }

    if (message.action === "testConnection") {

        sendResponse({ success: true });

    }

    return true;
});