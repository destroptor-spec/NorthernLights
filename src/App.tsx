import React from 'react';
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
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
import { Hub } from './components/Hub';
import { Playlists } from './components/library/Playlists';
import { GlobalSearch } from './components/GlobalSearch';
import { SettingsModal } from './components/SettingsModal';
import { Settings as SettingsIcon, Menu } from 'lucide-react';
import { TrackContextMenu } from './components/library/TrackContextMenu';

const TAB_CONFIG = [
  { path: '/library', label: 'Hub', end: true },
  { path: '/playlists', label: 'Playlists' },
  { path: '/library/artists', label: 'Artists' },
  { path: '/library/albums', label: 'Albums' },
  { path: '/library/genres', label: 'Genres' },
];

const App: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [dbConnected, setDbConnected] = React.useState<boolean | null>(null);
  const library = usePlayerStore(state => state.library);
  const needsSetup = usePlayerStore(state => state.needsSetup);
  const checkSetupStatus = usePlayerStore(state => state.checkSetupStatus);

  const libraryFolders = usePlayerStore(state => state.libraryFolders);
  const rescanLibrary = usePlayerStore(state => state.rescanLibrary);

  const isScanningGlobal = usePlayerStore(state => state.isScanning);
  const scanningFileGlobal = usePlayerStore(state => state.scanningFile);
  const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);

  const location = useLocation();

  // Determine which tab should be active based on current route
  const getActiveTab = (path: string): string => {
    if (path === '/library' || path === '/') return '/library';
    if (path.startsWith('/library/artist')) return '/library/artists';
    if (path.startsWith('/library/album')) return '/library/albums';
    if (path.startsWith('/library/genre')) return '/library/genres';
    if (path.startsWith('/playlists')) return '/playlists';
    return '/library';
  };
  const activeTab = getActiveTab(location.pathname);

  // Trigger an initial library fetch, apply theme, and subscribe to scan events
  React.useEffect(() => {
    usePlayerStore.getState().setTheme(usePlayerStore.getState().theme);

    // Check DB health first, then load normally
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        setDbConnected(data.dbConnected === true);
        return data.dbConnected === true;
      } catch {
        setDbConnected(false);
        return false;
      }
    };

    checkHealth().then((ok) => {
      if (!ok) {
        // Poll every 5 seconds until DB comes back
        const interval = setInterval(async () => {
          const ok = await checkHealth();
          if (ok) {
            clearInterval(interval);
            // Now do the normal startup
            checkSetupStatus().then(() => {
              const { needsSetup } = usePlayerStore.getState();
              if (!needsSetup) {
                usePlayerStore.getState().loadSettings();
                usePlayerStore.getState().fetchLibraryFromServer();
                usePlayerStore.getState().fetchPlaylistsFromServer();
              }
            });
          }
        }, 5000);
        return;
      }
      // Check if we need to show the First Time Setup Wizard
      checkSetupStatus().then(() => {
         const { needsSetup } = usePlayerStore.getState();
         if (!needsSetup) {
             usePlayerStore.getState().loadSettings();
             usePlayerStore.getState().fetchLibraryFromServer();
             usePlayerStore.getState().fetchPlaylistsFromServer();
         }
      });
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

  if (needsSetup === null) {
      // Still checking setup status...
      return <div className="h-screen w-full flex items-center justify-center text-[var(--color-primary)]">Loading Application...</div>;
  }

  if (needsSetup) {
      return <SetupWizard onComplete={() => checkSetupStatus().then(() => {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
      })} />;
  }

  return (
    <>
      <TrackContextMenu />
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

      {/* DB not connected? Show full-screen error instead of the app */}
      {dbConnected === false && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-text-primary)]">
          <div className="max-w-lg w-full mx-4 p-8 rounded-3xl border border-red-500/30 bg-red-500/5 backdrop-blur-2xl shadow-2xl text-center space-y-6">
            <div className="text-5xl">🗄️</div>
            <h1 className="text-2xl font-bold text-red-400">Database Unavailable</h1>
            <p className="text-[var(--color-text-secondary)] text-sm">
              Aurora cannot connect to PostgreSQL on <code className="bg-black/20 px-1.5 py-0.5 rounded text-red-300 text-xs">localhost:5432</code>.
              The server is running, but waiting for the database to come online.
            </p>
            <div className="text-left bg-black/20 rounded-2xl p-5 space-y-3 text-sm">
              <p className="font-semibold text-[var(--color-text-primary)] mb-2">Troubleshooting</p>
              <div className="space-y-2 text-[var(--color-text-secondary)]">
                <p>① Start your PostgreSQL / Podman container:<br/>
                  <code className="text-xs text-amber-300 mt-1 block">podman start musicdb</code>
                </p>
                <p>② Verify the DB is listening:<br/>
                  <code className="text-xs text-amber-300 mt-1 block">psql -U postgres -h localhost</code>
                </p>
                <p>③ Check your <code className="text-xs text-amber-300">.env</code> for the correct <code className="text-xs text-amber-300">DATABASE_URL</code>.</p>
              </div>
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]">
              <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
              Retrying every 5 seconds…
            </div>
          </div>
        </div>
      )}


        <main className="flex-1 flex flex-col min-w-0 relative">
          
          {/* Mobile Header (Hidden on Desktop) */}
          <div className="md:hidden p-4 flex items-center justify-between border-b border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md">
            <h1 className="font-bold text-lg text-[var(--color-primary)] tracking-wide">AURORA</h1>
            <button 
              className="p-2 text-[var(--color-text-primary)] focus:outline-none" 
              onClick={() => setIsSidebarOpen(true)}
            >
              <Menu size={24} />
            </button>
          </div>

          <div className="flex-none p-4 pb-0 flex gap-3 overflow-x-auto hide-scrollbar z-20 w-full pt-6 px-4 md:px-8 lg:px-12">
            {TAB_CONFIG.map(tab => {
                const isActive = activeTab === tab.path;
                return (
                    <NavLink
                        key={tab.path}
                        to={tab.path}
                        end={tab.end}
                        className={`
                            capitalize font-semibold text-sm px-5 py-2 rounded-full
                            border backdrop-blur-md whitespace-nowrap
                            transition-all duration-200 cursor-pointer
                            active:scale-95 no-underline
                            ${isActive
                                ? 'text-white border-purple-500/50 shadow-[0_0_18px_rgba(139,92,246,0.4)] hover:shadow-[0_0_24px_rgba(139,92,246,0.55)] hover:brightness-110'
                                : 'text-[var(--color-text-secondary)] border-[var(--color-border)] bg-black/5 dark:bg-white/[0.06] hover:bg-black/10 dark:hover:bg-white/[0.12] hover:text-[var(--color-text-primary)] hover:border-[var(--glass-border-hover)]'
                            }
                        `}
                        style={isActive ? {
                            background: 'linear-gradient(145deg, rgba(139, 92, 246, 0.85), rgba(109, 40, 217, 0.9))',
                            border: '1px solid rgba(168, 85, 247, 0.5)',
                            boxShadow: '0 0 18px rgba(139, 92, 246, 0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
                        } : {}}
                    >
                        {tab.label}
                    </NavLink>
                );
            })}
            <div className="flex items-center gap-2 ml-auto">
              <GlobalSearch />
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 rounded-full text-[var(--color-text-secondary)] bg-black/5 dark:bg-white/[0.06] hover:text-[var(--color-text-primary)] hover:bg-black/10 dark:hover:bg-white/[0.12] transition-all duration-300 border border-[var(--color-border)] hover:border-[var(--glass-border-hover)] flex-shrink-0"
                title="Settings"
              >
                <SettingsIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Main Content Area (Routing) */}
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 overflow-y-auto pb-48">
              {library.length === 0 ? (
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
              ) : (
                <Routes>
                  <Route path="/" element={<Navigate to="/library" replace />} />
                  <Route path="/library" element={<Hub />} />
                  <Route path="/library/artists" element={<LibraryHome section="artists" />} />
                  <Route path="/library/artist/:artistId" element={<ArtistDetail />} />
                  <Route path="/library/albums" element={<LibraryHome section="albums" />} />
                  <Route path="/library/album/:albumId" element={<AlbumDetail />} />
                  <Route path="/library/genres" element={<LibraryHome section="genres" />} />
                  <Route path="/library/genre/:genreId" element={<GenreDetail />} />
                  <Route path="/playlists" element={<Playlists />} />
                  <Route path="*" element={<Navigate to="/library" replace />} />
                </Routes>
              )}
            </div>
          </div>

          {/* Floating Playback Controls Footer */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-11/12 max-w-4xl z-40 bg-[var(--glass-bg)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-[2rem] p-4 pb-5 shadow-2xl">
            <ProgressBar />
            <div className="mt-2">
              <PlayerControls />
            </div>
          </div>

          {/* Keyboard Hint Overlay */}
          <KeyboardHint />
        </main>

        {isSettingsOpen && (
          <SettingsModal onClose={() => setIsSettingsOpen(false)} />
        )}

        {/* Mobile Sidebar Overlay Backdrop */}
        {isSidebarOpen && (
           <div 
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden transition-opacity" 
              onClick={() => setIsSidebarOpen(false)} 
            />
        )}
        
        {/* Sidebar Container (Right Side) */}
        <div className={`fixed inset-y-0 right-0 z-50 ${isSidebarCollapsed ? 'w-24' : 'w-96'} transform transition-all duration-300 ease-in-out md:relative md:translate-x-0 border-l border-[var(--glass-border)] ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full'}`}>
          <PlaylistSidebar />
        </div>
      </div>
    </>
  );
};

export default App;
