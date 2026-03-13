# Audio Management

## Playback Engine
- **HTML5 Audio**: Uses a single `HTMLAudioElement` wrapped by a `PlaybackManager` singleton.
- **Source Handling**: Audio is served via the `/api/stream?path=...` endpoint.
- **HTTP Streaming**: Implements partial content support (`Range` headers) on the Node.js server for efficient buffering and seeking of large lossless files (FLAC).

## Audio Processing (Planned)
- **Web Audio API**: Will wrap the audio element with an `AudioContext` for advanced processing.
- **Chain**: `MediaElementAudioSourceNode` → `GainNode` (Volume) → `BiquadFilterNodes` (EQ) → `AnalyserNode` (Visualizer) → `destination`.
- **Cross-fade**: Orchestrated by dual gain-node ramps during track transitions.
- **Gapless**: Leveraging `audioContext.currentTime` and look-ahead buffering to schedule next track starts with micro-second precision.
