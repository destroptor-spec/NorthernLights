import React from 'react';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import PlayerControls from './components/PlayerControls';
import ProgressBar from './components/ProgressBar';
import KeyboardHint from './components/KeyboardHint';
import { usePlayerStore } from './store/index';
import { TrackInfo } from './utils/fileSystem';
import { LibraryHome } from './components/library/LibraryHome';
import { AlbumDetail } from './components/library/AlbumDetail';
import { ArtistDetail } from './components/library/ArtistDetail';
import { GenreDetail } from './components/library/GenreDetail';
import { SetupWizard } from './components/SetupWizard';

const App: React.FC = () => {
  const library = usePlayerStore(state => state.library);
  const currentView = usePlayerStore(state => state.currentView);
  const needsSetup = usePlayerStore(state => state.needsSetup);
  const checkSetupStatus = usePlayerStore(state => state.checkSetupStatus);

  const libraryFolders = usePlayerStore(state => state.libraryFolders);
  const rescanLibrary = usePlayerStore(state => state.rescanLibrary);

  const isScanningGlobal = usePlayerStore(state => state.isScanning);
  const scanningFileGlobal = usePlayerStore(state => state.scanningFile);

  // Trigger an initial library fetch, apply theme, and subscribe to scan events
  React.useEffect(() => {
    usePlayerStore.getState().setTheme(usePlayerStore.getState().theme);
    
    // Check if we need to show the First Time Setup Wizard
    checkSetupStatus().then(() => {
       const { needsSetup } = usePlayerStore.getState();
       if (!needsSetup) {
           usePlayerStore.getState().fetchLibraryFromServer();
       }
    });

    // Listen to real-time scanning progress from backend
    const eventSource = new EventSource('/api/library/scan/status');
    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const wasScanning = usePlayerStore.getState().isScanning;
      
      // Update global UI state
      usePlayerStore.getState().setIsScanning(
        data.isScanning, 
        data.phase,
        data.scannedFiles,
        data.totalFiles,
        data.activeWorkers,
        data.activeFiles,
        data.currentFile
      );
      
      // If a scan just finished, refresh the library automatically
      if (wasScanning && !data.isScanning) {
        usePlayerStore.getState().fetchLibraryFromServer();
      }
    };

    return () => eventSource.close();
  }, []);

  const [folderPathInput, setFolderPathInput] = React.useState('');
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);

  const renderView = () => {
    if (library.length === 0) {
      return (
        <div className="empty-state font-body flex flex-col items-center justify-center p-8 flex-1">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-[var(--aurora-green)] to-[var(--aurora-purple)] mb-4">
            Aurora Media Server
          </h1>
          <p className="text-lg text-[var(--color-text-secondary)] mb-8 max-w-md text-center">
            Provide the absolute path to your local music directory to let the host scan and stream it.
          </p>
          <div className="flex flex-col md:flex-row gap-4 w-full max-w-lg">
            <input 
              type="text" 
              placeholder="/home/andreas/Music"
              value={folderPathInput}
              onChange={(e) => setFolderPathInput(e.target.value)}
              className="flex-1 px-4 py-3 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md text-[var(--color-text-primary)] shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent transition-all duration-300"
              disabled={isScanningGlobal}
            />
            <button
              onClick={async () => {
                if (!folderPathInput.trim()) return;
                await usePlayerStore.getState().addLibraryFolder(folderPathInput.trim());
                setFolderPathInput('');
              }}
              className="btn whitespace-nowrap"
              disabled={isScanningGlobal || !folderPathInput.trim()}
            >
              {isScanningGlobal ? '✦ Scanning...' : '✦ Map Folder'}
            </button>
          </div>
        </div>
      );
    }

    switch (currentView) {
      case 'album': return <AlbumDetail />;
      case 'artist': return <ArtistDetail />;
      case 'genre': return <GenreDetail />;
      case 'home':
      default: return <LibraryHome />;
    }
  };

  if (needsSetup === null) {
      // Still checking setup status...
      return <div className="h-screen w-full flex items-center justify-center text-[var(--color-primary)]">Loading Application...</div>;
  }

  if (needsSetup) {
      return <SetupWizard onComplete={() => checkSetupStatus().then(() => usePlayerStore.getState().fetchLibraryFromServer())} />;
  }

  return (
    <>
      {/* Global Scanning Indicator */}
      {isScanningGlobal && (
        <div className="global-scanning-indicator" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '16px', gap: '8px', width: '320px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
            <div className="scanning-spinner"></div>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <span style={{ fontWeight: 600 }}>Scanning Library...</span>
                <span style={{ 
                  fontSize: '0.7rem', 
                  padding: '2px 6px', 
                  borderRadius: '12px', 
                  backgroundColor: 'var(--color-primary)', 
                  color: 'white',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em'
                }}>
                  {usePlayerStore.getState().scanPhase}
                </span>
              </div>
              
              {usePlayerStore.getState().scanPhase === 'metadata' ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginTop: '2px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{usePlayerStore.getState().scannedFiles} / {usePlayerStore.getState().totalFiles} files</span>
                  <span>{usePlayerStore.getState().activeWorkers} workers</span>
                </div>
              ) : (
                <div style={{ 
                  fontSize: '0.8rem', 
                  color: 'var(--color-text-secondary)', 
                  marginTop: '2px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  width: '100%'
                }}>
                  {scanningFileGlobal || 'Discovering files...'}
                </div>
              )}
            </div>
          </div>

          {usePlayerStore.getState().scanPhase === 'metadata' && usePlayerStore.getState().activeFiles.length > 0 && (
            <div style={{ 
              width: '100%', 
              marginTop: '8px', 
              paddingTop: '8px', 
              borderTop: '1px solid var(--glass-border)',
              fontSize: '0.75rem',
              color: 'var(--color-text-secondary)',
              maxHeight: '120px',
              overflowY: 'auto'
            }}>
              <div style={{ marginBottom: '4px', fontWeight: 600, color: 'var(--color-text-primary)' }}>Currently Processing:</div>
              <ul style={{ listStyleType: 'disc', paddingLeft: '16px', margin: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {usePlayerStore.getState().activeFiles.slice(0, 10).map((file, i) => (
                  <li key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {file}
                  </li>
                ))}
                {usePlayerStore.getState().activeFiles.length > 10 && (
                  <li style={{ fontStyle: 'italic', listStyleType: 'none', marginLeft: '-16px' }}>
                    ...and {usePlayerStore.getState().activeFiles.length - 10} more
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="flex h-screen relative z-10 overflow-hidden text-[var(--color-text-primary)]">
        
        {/* Mobile Sidebar Overlay Backdrop */}
        {isSidebarOpen && (
           <div 
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden transition-opacity" 
              onClick={() => setIsSidebarOpen(false)} 
            />
        )}
        
        {/* Sidebar Container */}
        <div className={`fixed inset-y-0 left-0 z-50 w-72 transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <PlaylistSidebar />
        </div>

        <main className="flex-1 flex flex-col min-w-0 relative">
          
          {/* Mobile Header (Hidden on Desktop) */}
          <div className="md:hidden p-4 flex items-center justify-between border-b border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md">
            <h1 className="font-bold text-lg text-[var(--color-primary)] tracking-wide">AURORA</h1>
            <button 
              className="p-2 text-[var(--color-text-primary)] focus:outline-none" 
              onClick={() => setIsSidebarOpen(true)}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>
          </div>

          {/* Main Content Area (Routing) */}
          <div className="flex-1 flex overflow-hidden">
            {renderView()}
          </div>

          {/* Playback Controls Footer */}
          <div className="playback-controls-footer">
            <ProgressBar />
            <div className="mt-2">
              <PlayerControls />
            </div>
          </div>

          {/* Keyboard Hint Overlay */}
          <KeyboardHint />
        </main>
      </div>
    </>
  );
};

export default App;
