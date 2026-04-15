# Core Features

## Implemented Features

### Playback & Audio
- **HLS Streaming**: Fast, adaptive streaming via FFmpeg (on-the-fly slicing) and `hls.js`.
- **Hi-Res Support**: Native playback for FLAC, ALAC, WAV, and AIFF.
- **Transcoding**: Automatic on-the-fly transcoding for WMA and low-bandwidth modes.
- **Gapless Foundation**: Micro-second precision scheduling via Web Audio API.
- **Chromecast**: Native Google Cast integration for local and network streaming.

### Library & Intelligence
- **PostgreSQL + pgvector**: Native vector database for lightning-fast similarity search and metadata storage.
- **ML Audio Analysis**: Dual-model pipeline (MusiCNN + Discogs-EffNet) extracting 1288-dimensional fingerprints.
- **Hierarchical Genres**: MBDB-driven ontology with hierarchical "Hop Cost" calculation.
- **Global Search**: Instant client-side search across tracks, artists, albums, and genres.
- **User Authentication**: Secure JWT-based auth with admin-controlled invites.

### UI & Interaction
- **Glassmorphism Design**: High-fidelity frosted glass aesthetic with Light/Dark mode support.
- **Advanced State**: Robust queue management and persistent session settings via Zustand.
- **PWA Support**: Installable Progressive Web App with service-worker caching for offline resilience.
- **Keyboard Shortcuts**: Full control surface for power users.

---

## Planned / Potential Features
- **Tag Editing**: Direct write-back support for audio file metadata.
- **Audio Visualizer**: Real-time frequency analysis and waveform display.
- **Equalizer**: Multi-band frequency manipulation using BiquadFilterNodes.
- **Lyrics Display**: Synced LRC support and external API integration.
- **Internationalization**: Full i18n support for global accessibility.
