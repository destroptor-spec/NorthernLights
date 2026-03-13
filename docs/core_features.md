# Core Features

## Implemented Features

### Playback & Audio
- **Local File Streaming**: Native HTTP streaming for MP3, FLAC, M4A, and AAC via Node.js backend.
- **Playback Controls**: Play/pause, next/previous, shuffle, and repeat modes.
- **Progress & Seeking**: Dynamic progress bar with click-to-seek functionality and time displays (MM:SS).
- **Volume Control**: Persistent volume slider with mute capability and visual percentage feedback.
- **Gapless Foundation**: Basic gapless transition between tracks in the playback queue.

### Library Management
- **Persistent Library**: SQLite3 back-end for storing collection metadata across sessions.
- **Folder Mapping**: Support for mapping absolute host directories for recursive scanning.
- **Metadata Extraction**: Automatic parsing of Artist, Album, Title, Genre, and Track Number.
- **Album Artwork**: Extraction and display of embedded covers.

### UI & Interaction
- **Library Views**: Dedicated navigation for Artists, Albums, and Genres.
- **Glassmorphism Design**: Premium frosted glass aesthetic for both Light and Dark modes.
- **Matte Background**: Performant CSS-based matte glass background with noise texture.
- **Responsive Layout**: Mobile-friendly drawer-style sidebar and fluid grids.
- **Keyboard Shortcuts**: Comprehensive hotkey support for all major playback functions.

---

## Planned / Potential Features
- **Tag Editing**: Basic support for ID3v2 and Vorbis Comments with undo/redo capability.
- **Audio Visualizer**: Waveform or frequency bars using Web Audio API.
- **Equalizer**: Preset curves and custom sliders for frequency manipulation.
- **Cross-fade**: Smooth transitions between tracks.
- **Lyrics Display**: Fetch and sync LRC files or online lyric APIs.
- **Search**: Global search across library metadata.
- **Internationalization**: Support for multiple languages (i18n).
