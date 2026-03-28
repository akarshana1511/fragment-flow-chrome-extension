# Adaptive Bandwidth Detection Implementation

## Overview
This document describes the adaptive bandwidth detection system implemented in Fragment Flow that dynamically optimizes thread count and chunk size based on real-time network conditions.

## Features Implemented

### 1. **BandwidthDetector Class**
Measures real-time download speed and recommends optimal thread counts.

**Key Methods:**
- `recordMeasurement(totalBytesDownloaded, currentTime)` - Records bandwidth every 2 seconds
- `getAverageBandwidth()` - Returns rolling average of last 10 measurements  
- `getCurrentBandwidth()` - Returns latest measurement
- `recommendThreadCount(mbps)` - Thread recommendations based on bandwidth:
  - < 5 Mbps: 2 threads (Slow connection)
  - < 25 Mbps: 4 threads (Medium)
  - < 100 Mbps: 8 threads (Fast)
  - ≥ 100 Mbps: 16 threads (Very fast)

**Measurement Strategy:**
- Measures every 2 seconds (not every chunk) to reduce noise
- Keeps rolling average of 10 measurements for stability
- Only records delta bytes since last measurement for accuracy

### 2. **DynamicChunkOptimizer Class**
Combines file size and bandwidth for optimal chunk sizing.

**Key Methods:**
- `getOptimalChunkSize(totalBytes, bandwidthMbps)` - Calculates chunk size considering:
  - **File size-based baseline:**
    - < 50 MB: 1 MB chunks
    - < 200 MB: 2 MB chunks  
    - < 1000 MB: 4 MB chunks
    - ≥ 1000 MB: 8 MB chunks
  - **Bandwidth adjustment:** Target 3-second download per chunk
  - **Safe bounds:** 512 KB min to 16 MB max

- `calculateOptimalThreads(totalBytes, bandwidthMbps, fileSizeBased)` - Returns recommended threads with reasoning

### 3. **Real-Time Thread Rebalancing**
The `rebalanceThreadCount()` function:
- Checks every ~2 seconds during download
- Only rebalances if bandwidth change is > 20%
- Automatically adapts to network condition changes
- Logs rebalancing events with bandwidth info
- Notifies UI of thread changes

### 4. **Integration Points**

#### During Download Initialization (`initDownload`)
```javascript
// Reset bandwidth detector for new download
bandwidthDetector.reset();

// Initial threads based on file size (will be adjusted)
activeThreads = calculateDynamicThreads(totalBytes);

// Chunk size optimized for file size (will adapt as bandwidth measured)
const chunkSize = getDynamicChunkSize(totalBytes);
```

#### During Progress Broadcasting (`broadcastProgress`)
```javascript
// Measure bandwidth every 2 seconds
const measuredMbps = bandwidthDetector.recordMeasurement(sessionDownloadedBytes, now);

// Rebalance threads if needed
if (measuredMbps !== null) {
    rebalanceThreadCount();
}

// Send bandwidth data to UI
chrome.runtime.sendMessage({
    action: "updateProgress",
    bandwidth: avgBandwidth.toFixed(2),
    activeThreads: activeThreads
    // ... other progress data
});
```

#### On Resume (`restoreCheckpoint`)
```javascript
// Reset bandwidth detector for resumed session
bandwidthDetector.reset();
```

## How It Works

### Phase 1: Initial Download Start
1. File size is measured
2. Initial chunk size calculated based on file size
3. Initial thread count estimated from file size (1-16 threads)
4. Download begins with conservative settings

### Phase 2: Bandwidth Measurement
1. Every 2 seconds, bandwidth is measured
2. Rolling average of 10 measurements maintained
3. Noise filtered by 2-second measurement intervals
4. Bandwidth logged to console for debugging

### Phase 3: Dynamic Adaptation
1. Every ~2 seconds, check if rebalancing needed
2. If bandwidth changed by > 20%, adjust threads
3. Chunk size remains flexible for network changes
4. UI updated with new thread count and bandwidth

### Example Scenario
```
Time 0s:     File size: 500 MB
             Initial threads: 8 (size-based)
             Initial chunk size: 4 MB
             
Time 5s:     Measured: 120 Mbps
             Recommendation: 16 threads
             Change: 100% (> 20% threshold)
             Action: Rebalance to 16 threads
             
Time 15s:    Network congestion detected
             Measured: 45 Mbps  
             Recommendation: 8 threads
             Change: -50% (> 20% threshold)
             Action: Reduced back to 8 threads
```

## UI Display

### Network Performance Card
Shows in real-time:
- **Bandwidth:** Current average bandwidth (Mbps) with color coding
  - Red: < 5 Mbps (Slow)
  - Yellow: 5-25 Mbps (Medium) 
  - Blue: 25-100 Mbps (Fast)
  - Green: > 100 Mbps (Very Fast)
- **Adaptive Threads:** Current thread count
- **Thread Count Badge:** Pulses when thread count changes

### Progress Update
- Bandwidth displayed alongside speed
- Active thread count shown in progress area
- Real-time rebalancing visible to user

## Algorithm Benefits

### Efficiency Improvements
1. **Automatic Network Adaptation:** Adjusts to changing network conditions
2. **Resource Optimization:** Uses minimal threads on slow networks, maximizes on fast networks
3. **Chunk Size Balancing:** Targets 3-second chunks for responsiveness
4. **Reduced Network Congestion:** Conservative approach prevents overwhelming the network

### Stability Features
1. **Measurement Throttling:** Every 2 seconds prevents noise
2. **Threshold-Based Changes:** 20% change threshold prevents thrashing
3. **Rolling Averages:** Smooths temporary fluctuations
4. **Progressive Adaptation:** Gradually adjusts rather than sudden changes

## Performance Metrics

### Memory Footprint
- BandwidthDetector: ~1 KB (10 float measurements)
- DynamicChunkOptimizer: Class with static methods (no instance state)
- Overall impact: Negligible

### CPU Impact
- Bandwidth measurement: ~0.1ms every 2 seconds
- Thread rebalancing check: ~0.05ms every ~2 seconds
- Overall: Minimal, non-blocking operations

### Network Impact
- No additional network requests
- Opportunistic measurement using existing download data
- Zero overhead

## Configuration Tuning

To adjust behavior, modify these constants in `background.js`:

```javascript
// BandwidthDetector settings
this.maxMeasurements = 10;      // Larger = smoother, slower to adapt
this.measurementInterval = 2000; // Smaller = more responsive, noisier

// Thread recommendations (in BandwidthDetector.recommendThreadCount)
if (bandwidth < 5) return 2;    // Adjust thresholds as needed
if (bandwidth < 25) return 4;
if (bandwidth < 100) return 8;
return 16;

// Rebalance thresholds
percentChange > 0.2             // 20% threshold, adjust for stability/responsiveness

// Chunk size targets (in DynamicChunkOptimizer.getOptimalChunkSize)
targetBytes = (bandwidthMbps * 1_000_000 / 8) * 3;  // 3-second target
```

## Logging

Enable console to see bandwidth detection in action:

```
[Init] Starting with 8 threads for 500.00 MB file
[Init] Using chunk size: 4.00 MB
[Bandwidth] Measured: 125.43 Mbps, Avg: 120.50 Mbps
[Bandwidth] Rebalancing threads: 8 → 16 (Bandwidth: 120.50 Mbps)
[Bandwidth] Measured: 45.20 Mbps, Avg: 65.30 Mbps
[Bandwidth] Rebalancing threads: 16 → 8 (Bandwidth: 65.30 Mbps)
```

## Technical Details

### Why 2-Second Measurement Interval?
- Balances responsiveness with noise reduction
- At 100 Mbps: 25 MB of data per measurement = significant sample
- Prevents reacting to momentary fluctuations
- Aligns with typical UI refresh rates

### Why 20% Threshold for Rebalancing?
- Prevents thrashing between thread counts
- Significant enough change to justify rebalancing overhead
- Still responsive to real network changes
- Can be tuned based on network characteristics

### Why Rolling Average of 10 Measurements?
- 20-second window (10 × 2s measurements)
- Long enough to smooth fluctuations
- Short enough to adapt to sustained changes
- Memory efficient

## Future Enhancements

1. **Latency-Based Optimization:** Consider connection latency, not just bandwidth
2. **Predictive Chunking:** Predict bandwidth trends to pre-allocate resources
3. **Per-Thread Bandwidth Tracking:** Detect if individual threads are bottlenecked
4. **Network Change Detection:** Detect network switches (WiFi ↔ Mobile) and react
5. **User Preferences:** Allow user to set bandwidth/thread preferences
6. **Statistics Export:** Track and export bandwidth patterns over time

## Testing

To test the adaptive system:

1. **Simulate Slow Network:** Use DevTools network throttling
2. **Observe Thread Changes:** Watch thread count adjust in UI
3. **Check Console:** See bandwidth measurements and rebalancing logs
4. **Monitor Performance:** Compare completion time with/without adaptation

Example test scenario:
1. Start download on fast network (observe 16 threads)
2. Throttle network in DevTools to "Slow 3G"
3. Watch thread count reduce to 2-4 within ~10 seconds
4. Remove throttle
5. Watch thread count increase back to 16

## References

- Bandwidth measurement formula: `(bytes * 8) / (bits_per_second)`
- Mbps = Megabits per second (not MegaBYTES)
- Rolling average smoothing technique
- Adaptive algorithm best practices for resource allocation

---

**Implementation Date:** March 2024
**Author:** Fragment Flow Development Team
**Version:** 1.0
