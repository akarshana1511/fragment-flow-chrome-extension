/**
 * SWARM.js - Decentralized P2P Chunk Sharing System
 * Uses WebRTC for peer-to-peer local network chunk distribution
 * Implements BitTorrent-like chunk sharing within browser extension
 */

// ==================== SWARM CONFIGURATION ====================
const SWARM_CONFIG = {
    ENABLE_SWARM: true,
    DISCOVERY_KEY: 'swarm_peers_discovery',
    HEARTBEAT_INTERVAL: 5000, // 5 seconds
    PEER_TIMEOUT: 15000, // 15 seconds
    CHUNK_REQUEST_TIMEOUT: 30000, // 30 seconds
    MAX_PEER_CONNECTIONS: 8,
    STUN_SERVERS: [
        { urls: ['stun:stun.l.google.com:19302'] },
        { urls: ['stun:stun1.l.google.com:19302'] },
        { urls: ['stun:stun2.l.google.com:19302'] }
    ]
};

// ==================== SWARM STATE ====================
let swarmId = null; // Unique ID for this download session
let downloadUrl = ''; // URL being downloaded
let downloadHash = ''; // Hash of URL for matching peers
let peers = {}; // Connected peers map
let peerChunkMap = {}; // Track which chunks peers have
let localChunkCache = {}; // Cache of locally stored chunks
let swarmEnabled = SWARM_CONFIG.ENABLE_SWARM;
let discoveryInterval = null;
let heartbeatInterval = null;

/**
 * Generate unique session ID for swarm discovery
 */
function generateSwarmId() {
    return `swarm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create hash of download URL for peer matching
 * Ensures peers downloading same file can share
 */
function hashDownloadUrl(url) {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
        const char = url.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
}

/**
 * Initialize swarm for new download
 */
function initializeSwarm(url) {
    if (!swarmEnabled) return;
    
    swarmId = generateSwarmId();
    downloadUrl = url;
    downloadHash = hashDownloadUrl(url);
    peers = {};
    peerChunkMap = {};
    localChunkCache = {};
    
    console.log(`[SWARM] Initialized with ID: ${swarmId}, Hash: ${downloadHash}`);
    
    // Start peer discovery
    startPeerDiscovery();
    startHeartbeat();
    
    // Broadcast our presence
    broadcastPeerPresence();
}

/**
 * Broadcast peer presence to local network
 * Uses chrome.storage as a simple local peer registry
 */
async function broadcastPeerPresence() {
    if (!swarmEnabled || !swarmId) return;
    
    try {
        const peers = await chrome.storage.local.get(SWARM_CONFIG.DISCOVERY_KEY);
        const peerRegistry = peers[SWARM_CONFIG.DISCOVERY_KEY] || {};
        
        // Add this peer to registry
        peerRegistry[swarmId] = {
            id: swarmId,
            downloadHash: downloadHash,
            timestamp: Date.now(),
            url: downloadUrl,
            chunks: Object.keys(localChunkCache),
            connectable: true
        };
        
        // Clean up stale peers (older than 30 seconds)
        const now = Date.now();
        for (const peerId in peerRegistry) {
            if (now - peerRegistry[peerId].timestamp > SWARM_CONFIG.PEER_TIMEOUT * 2) {
                delete peerRegistry[peerId];
            }
        }
        
        await chrome.storage.local.set({ [SWARM_CONFIG.DISCOVERY_KEY]: peerRegistry });
    } catch (err) {
        console.warn('[SWARM] Failed to broadcast peer presence:', err);
    }
}

/**
 * Discover peers on local network
 */
async function discoverPeers() {
    if (!swarmEnabled || !swarmId) return;
    
    try {
        const data = await chrome.storage.local.get(SWARM_CONFIG.DISCOVERY_KEY);
        const peerRegistry = data[SWARM_CONFIG.DISCOVERY_KEY] || {};
        
        for (const peerId in peerRegistry) {
            if (peerId === swarmId) continue; // Skip self
            
            const peerInfo = peerRegistry[peerId];
            
            // Only connect to peers downloading the same file
            if (peerInfo.downloadHash !== downloadHash) continue;
            
            // Skip if already connected
            if (peers[peerId]) continue;
            
            // Skip if peer is stale
            if (Date.now() - peerInfo.timestamp > SWARM_CONFIG.PEER_TIMEOUT) continue;
            
            console.log(`[SWARM] Discovered peer: ${peerId}`);
            
            // Attempt to connect
            await connectToPeer(peerId, peerInfo);
        }
    } catch (err) {
        console.warn('[SWARM] Peer discovery failed:', err);
    }
}

/**
 * Connect to discovered peer via WebRTC
 */
async function connectToPeer(peerId, peerInfo) {
    if (peers[peerId]) return; // Already connecting/connected
    if (Object.keys(peers).length >= SWARM_CONFIG.MAX_PEER_CONNECTIONS) return;
    
    try {
        const peerConnection = new RTCPeerConnection({ iceServers: SWARM_CONFIG.STUN_SERVERS });
        
        // Create data channel for chunk transfer
        const dataChannel = peerConnection.createDataChannel('chunks', {
            ordered: true,
            maxRetransmits: 2
        });
        
        setupDataChannelHandlers(dataChannel, peerId);
        
        // Setup ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignalingMessage(peerId, {
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };
        
        // Create offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        // Send offer to peer
        sendSignalingMessage(peerId, {
            type: 'offer',
            sdp: offer.sdp,
            senderId: swarmId
        });
        
        // Store peer connection
        peers[peerId] = {
            id: peerId,
            connection: peerConnection,
            dataChannel: dataChannel,
            connected: false,
            lastSeen: Date.now()
        };
        
        console.log(`[SWARM] Initiated connection to peer: ${peerId}`);
    } catch (err) {
        console.error(`[SWARM] Failed to connect to peer ${peerId}:`, err);
    }
}

/**
 * Setup handlers for data channel communication
 */
function setupDataChannelHandlers(dataChannel, peerId) {
    dataChannel.onopen = () => {
        console.log(`[SWARM] Data channel opened with peer: ${peerId}`);
        if (peers[peerId]) {
            peers[peerId].connected = true;
            peers[peerId].lastSeen = Date.now();
        }
        
        // Request peer's chunk inventory
        dataChannel.send(JSON.stringify({
            type: 'request-inventory',
            senderId: swarmId
        }));
    };
    
    dataChannel.onmessage = (event) => {
        handlePeerMessage(event.data, peerId);
    };
    
    dataChannel.onerror = (error) => {
        console.error(`[SWARM] Data channel error with peer ${peerId}:`, error);
    };
    
    dataChannel.onclose = () => {
        console.log(`[SWARM] Data channel closed with peer: ${peerId}`);
        if (peers[peerId]) {
            peers[peerId].connected = false;
        }
    };
}

/**
 * Handle incoming messages from peers
 */
function handlePeerMessage(messageData, peerId) {
    try {
        const message = JSON.parse(messageData);
        
        switch (message.type) {
            case 'request-inventory':
                // Peer is asking what chunks we have
                sendChunkInventory(peerId);
                break;
                
            case 'inventory':
                // Peer is sending their available chunks
                updatePeerChunkMap(peerId, message.chunks);
                break;
                
            case 'chunk-request':
                // Peer is requesting a chunk we have
                serveChunkToPeer(peerId, message.chunkKey);
                break;
                
            case 'chunk-data':
                // Receiving chunk data from peer
                handleChunkFromPeer(message.chunkKey, message.data, peerId);
                break;
                
            case 'chunk-not-available':
                // Peer doesn't have requested chunk
                console.log(`[SWARM] Peer ${peerId} doesn't have chunk: ${message.chunkKey}`);
                break;
                
            default:
                console.warn(`[SWARM] Unknown message type: ${message.type}`);
        }
    } catch (err) {
        console.error(`[SWARM] Failed to handle message from ${peerId}:`, err);
    }
}

/**
 * Send our chunk inventory to peer
 */
function sendChunkInventory(peerId) {
    if (!peers[peerId] || !peers[peerId].dataChannel) return;
    
    try {
        const chunks = Object.keys(localChunkCache);
        peers[peerId].dataChannel.send(JSON.stringify({
            type: 'inventory',
            senderId: swarmId,
            chunks: chunks
        }));
    } catch (err) {
        console.error(`[SWARM] Failed to send inventory to ${peerId}:`, err);
    }
}

/**
 * Update our knowledge of what chunks a peer has
 */
function updatePeerChunkMap(peerId, chunks) {
    peerChunkMap[peerId] = chunks || [];
    console.log(`[SWARM] Peer ${peerId} has ${chunks.length} chunks`);
}

/**
 * Serve chunk to peer
 */
function serveChunkToPeer(peerId, chunkKey) {
    if (!peers[peerId] || !peers[peerId].dataChannel) return;
    
    try {
        const chunk = localChunkCache[chunkKey];
        if (!chunk) {
            peers[peerId].dataChannel.send(JSON.stringify({
                type: 'chunk-not-available',
                chunkKey: chunkKey
            }));
            return;
        }
        
        // Convert blob to ArrayBuffer for efficient transmission
        const reader = new FileReader();
        reader.onload = () => {
            peers[peerId].dataChannel.send(JSON.stringify({
                type: 'chunk-data',
                chunkKey: chunkKey,
                data: reader.result
            }));
            console.log(`[SWARM] Served chunk ${chunkKey} to peer ${peerId}`);
        };
        reader.readAsArrayBuffer(chunk);
    } catch (err) {
        console.error(`[SWARM] Failed to serve chunk to ${peerId}:`, err);
    }
}

/**
 * Handle chunk received from peer
 */
function handleChunkFromPeer(chunkKey, data, peerId) {
    try {
        console.log(`[SWARM] Received chunk ${chunkKey} from peer ${peerId}`);
        localChunkCache[chunkKey] = new Blob([data]);
    } catch (err) {
        console.error(`[SWARM] Failed to handle chunk from ${peerId}:`, err);
    }
}

/**
 * Request chunk from best available peer
 */
async function requestChunkFromPeer(chunkKey) {
    if (!swarmEnabled || Object.keys(peers).length === 0) return null;
    
    // Find peers that have this chunk
    const peersWithChunk = Object.entries(peerChunkMap)
        .filter(([peerId, chunks]) => chunks.includes(chunkKey) && peers[peerId]?.connected)
        .map(([peerId]) => peerId);
    
    if (peersWithChunk.length === 0) return null;
    
    // Request from random peer (load balancing)
    const selectedPeer = peersWithChunk[Math.floor(Math.random() * peersWithChunk.length)];
    
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Chunk request timeout for ${chunkKey}`));
        }, SWARM_CONFIG.CHUNK_REQUEST_TIMEOUT);
        
        try {
            peers[selectedPeer].dataChannel.send(JSON.stringify({
                type: 'chunk-request',
                chunkKey: chunkKey,
                senderId: swarmId
            }));
            
            // Resolve immediately; chunk will be added to localChunkCache
            setTimeout(() => {
                clearTimeout(timeout);
                if (localChunkCache[chunkKey]) {
                    resolve(localChunkCache[chunkKey]);
                } else {
                    reject(new Error(`Chunk ${chunkKey} not received within timeout`));
                }
            }, 1000);
        } catch (err) {
            clearTimeout(timeout);
            reject(err);
        }
    });
}

/**
 * Send signaling message to peer (placeholder for signaling server)
 * In production, this would use a WebSocket to a signaling server
 */
function sendSignalingMessage(peerId, message) {
    // This is simplified for local network lab environment
    // In production, you'd have a signaling server
    console.log(`[SWARM] Would send signaling message to ${peerId}:`, message.type);
    
    // For lab environment, you could use localStorage or IndexedDB
    // to store signaling messages temporarily
}

/**
 * Start periodic peer discovery
 */
function startPeerDiscovery() {
    if (discoveryInterval) clearInterval(discoveryInterval);
    
    discoveryInterval = setInterval(() => {
        discoverPeers();
    }, 3000);
}

/**
 * Start heartbeat to refresh peer availability
 */
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    heartbeatInterval = setInterval(() => {
        broadcastPeerPresence();
        
        // Clean up stale peer connections
        const now = Date.now();
        for (const peerId in peers) {
            if (now - peers[peerId].lastSeen > SWARM_CONFIG.PEER_TIMEOUT) {
                console.log(`[SWARM] Removing stale peer: ${peerId}`);
                peers[peerId].connection?.close();
                delete peers[peerId];
            }
        }
    }, SWARM_CONFIG.HEARTBEAT_INTERVAL);
}

/**
 * Cache downloaded chunk locally for peer sharing
 */
function cacheChunkLocally(chunkKey, blob) {
    localChunkCache[chunkKey] = blob;
    console.log(`[SWARM] Cached chunk ${chunkKey} for peer sharing`);
    
    // Broadcast updated inventory
    broadcastChunkInventoryUpdate();
}

/**
 * Broadcast that our chunk inventory has updated
 */
function broadcastChunkInventoryUpdate() {
    for (const peerId in peers) {
        if (peers[peerId].connected && peers[peerId].dataChannel) {
            sendChunkInventory(peerId);
        }
    }
}

/**
 * Cleanup swarm on download completion or stop
 */
function cleanupSwarm() {
    console.log('[SWARM] Cleaning up swarm');
    
    // Close all peer connections
    for (const peerId in peers) {
        peers[peerId].dataChannel?.close();
        peers[peerId].connection?.close();
    }
    
    // Clear intervals
    if (discoveryInterval) clearInterval(discoveryInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    // Remove from peer registry
    try {
        chrome.storage.local.get(SWARM_CONFIG.DISCOVERY_KEY, (data) => {
            const peerRegistry = data[SWARM_CONFIG.DISCOVERY_KEY] || {};
            delete peerRegistry[swarmId];
            chrome.storage.local.set({ [SWARM_CONFIG.DISCOVERY_KEY]: peerRegistry });
        });
    } catch (err) {
        console.warn('[SWARM] Failed to clean up peer registry:', err);
    }
    
    // Reset swarm state
    swarmId = null;
    downloadUrl = '';
    downloadHash = '';
    peers = {};
    peerChunkMap = {};
    localChunkCache = {};
}

/**
 * Get swarm statistics
 */
function getSwarmStats() {
    const connectedPeers = Object.values(peers).filter(p => p.connected).length;
    const totalChunksInSwarm = new Set(Object.values(peerChunkMap).flat()).size;
    
    return {
        swarmId: swarmId,
        connectedPeers: connectedPeers,
        totalPeerConnections: Object.keys(peers).length,
        localChunks: Object.keys(localChunkCache).length,
        totalChunksInSwarm: totalChunksInSwarm,
        peerChunkDistribution: peerChunkMap
    };
}

// Export functions for use in background.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initializeSwarm,
        cleanupSwarm,
        getSwarmStats,
        requestChunkFromPeer,
        cacheChunkLocally
    };
}
