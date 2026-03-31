import React from 'react';
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import PlayerControls from './components/PlayerControls';
import ProgressBar from './components/ProgressBar';
import MobileMiniPlayer from './components/MobileMiniPlayer';
import MobileBottomTabs from './components/MobileBottomTabs';
import KeyboardHint from './components/KeyboardHint';
import { usePlayerStore } from './store/index';
import { TrackInfo } from './utils/fileSystem';
import { LibraryHome } from './components/library/LibraryHome';
import { AlbumDetail } from './components/library/AlbumDetail';
import { ArtistDetail } from './components/library/ArtistDetail';
import { GenreDetail } from './components/library/GenreDetail';
import { SetupWizard } from './components/SetupWizard';
import { LoginPage } from './components/LoginPage';
import { Hub } from './components/Hub';
import { Playlists } from './components/library/Playlists';
import { GlobalSearch } from './components/GlobalSearch';
import { SettingsModal } from './components/SettingsModal';
import { InviteRegister } from './components/InviteRegister';
import { UserMenu } from './components/UserMenu';
import { Settings as SettingsIcon, AudioWaveform, X } from 'lucide-react';
import { TrackContextMenu } from './components/library/TrackContextMenu';
import { DatabaseControl } from './components/DatabaseControl';

const TAB_CONFIG = [
  { path: '/library', label: 'Hub', end: true },
  { path: '/playlists', label: 'Playlists' },
  { path: '/library/artists', label: 'Artists' },
  { path: '/library/albums', label: 'Albums' },
  { path: '/library/genres', label: 'Genres' },
];

const App: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [dbConnected, _setDbConnected] = React.useState<boolean | null>(null);
  const dbConnectedRef = React.useRef<boolean | null>(null);
  
  const setDbConnected = React.useCallback((val: boolean | null) => {
    dbConnectedRef.current = val;
    _setDbConnected(val);
  }, []);
  const [isDatabaseStarting, setIsDatabaseStarting] = React.useState(false);
  const library = usePlayerStore(state => state.library);
  const needsSetup = usePlayerStore(state => state.needsSetup);
  const checkSetupStatus = usePlayerStore(state => state.checkSetupStatus);
  const authToken = usePlayerStore(state => state.authToken);
  const login = usePlayerStore(state => state.login);

  const libraryFolders = usePlayerStore(state => state.libraryFolders);
  const rescanLibrary = usePlayerStore(state => state.rescanLibrary);

  const [scannerVisible, setScannerVisible] = React.useState(false);
  const isScanningGlobal = usePlayerStore(state => state.isScanning);
  const scanningFileGlobal = usePlayerStore(state => state.scanningFile);
  const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);
  const playlist = usePlayerStore(state => state.playlist);
  const currentUser = usePlayerStore(state => state.currentUser);
  const isAdmin = currentUser?.role === 'admin';

  // Auto-show scanner toast when a scan starts
  React.useEffect(() => {
    if (isScanningGlobal) setScannerVisible(true);
  }, [isScanningGlobal]);

  const location = useLocation();

  // Health check function accessible from render
  const checkHealth = React.useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setDbConnected(data.dbConnected === true);
      return data.dbConnected === true;
    } catch {
      setDbConnected(false);
      return false;
    }
  }, []);

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

    const performInitialChecks = async () => {
      const ok = await checkHealth();
      if (ok) {
        await checkSetupStatus();
        const { needsSetup, authToken } = usePlayerStore.getState();
        if (!needsSetup && authToken) {
          usePlayerStore.getState().loadSettings();
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        }
      }
    };

    performInitialChecks();

    // Persistent health poller
    const interval = setInterval(async () => {
      const previouslyConnected = dbConnectedRef.current;
      const ok = await checkHealth();
      
      // Only trigger a sync if we just became healthy (transition from false to true)
      if (ok && previouslyConnected === false) {
        const { needsSetup } = usePlayerStore.getState();
        if (needsSetup === null) {
          await checkSetupStatus();
        }
        if (authToken) {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        }
      }
    }, 10000); // 10s is a good balance for background polling

    return () => clearInterval(interval);
  }, [checkSetupStatus, checkHealth]);

  // Connect to scan status SSE only when authenticated (EventSource can't send headers)
  React.useEffect(() => {
    // Don't connect if we're in setup mode or not yet authenticated
    if (needsSetup || !authToken) return;

    const eventSource = new EventSource(`/api/library/scan/status?token=${authToken}`);
    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const wasScanning = usePlayerStore.getState().isScanning;

      usePlayerStore.getState().setIsScanning(
        data.isScanning,
        data.phase,
        data.scannedFiles,
        data.totalFiles,
        data.activeWorkers,
        data.activeFiles,
        data.currentFile
      );

      if (wasScanning && !data.isScanning) {
        usePlayerStore.getState().fetchLibraryFromServer();
      }
    };

    return () => eventSource.close();
  }, [authToken, needsSetup]);

  const [folderPathInput, setFolderPathInput] = React.useState('');
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);

  const handleDatabaseReady = React.useCallback(() => {
    setIsDatabaseStarting(true);
    setDbConnected(null);

    // Initial check
    checkHealth().then(ok => {
      if (ok) {
        setIsDatabaseStarting(false);
        checkSetupStatus();
        if (authToken) {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        }
        return;
      }

      // If not immediately ok, poll aggressively every 2s
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        const healthy = await checkHealth();
        if (healthy || attempts > 15) {
          clearInterval(interval);
          setIsDatabaseStarting(false);
          if (healthy) {
            checkSetupStatus();
            if (authToken) {
              usePlayerStore.getState().fetchLibraryFromServer();
              usePlayerStore.getState().fetchPlaylistsFromServer();
            }
          } else {
            // If still not healthy after 30s, go back to recovery UI
            setDbConnected(false);
          }
        }
      }, 2000);
    });
  }, [checkHealth, checkSetupStatus, authToken]);

  // If database is not connected, show the control panel immediately
  if (dbConnected === false && !isDatabaseStarting) {
    return (
      <DatabaseControl
        onReady={handleDatabaseReady}
      />
    );
  }

  // Loading / Initializing gate
  // Shows if: 
  // 1. We are explicitly starting the database
  // 2. We don't know the connection status yet
  // 3. We are connected but don't know the setup status yet
  if (isDatabaseStarting || dbConnected === null || (dbConnected === true && needsSetup === null)) {
      const showStartingLabel = isDatabaseStarting;
      const showConnectingLabel = dbConnected === null;
      const showSetupLabel = dbConnected === true && needsSetup === null;

      return (
        <div className="h-screen w-full flex flex-col items-center justify-center bg-[var(--color-bg-primary)]">
          <div className="flex flex-col items-center space-y-6">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-[var(--color-primary)]/20 border-t-[var(--color-primary)] rounded-full animate-spin" />
              <div className="absolute inset-x-0 -bottom-1 w-full h-1 bg-[var(--color-primary)]/10 blur-md" />
            </div>
            <div className="text-center">
              <h1 className="text-xl font-bold text-[var(--color-text-primary)]">
                {showStartingLabel ? 'Establishing Database Connection...' : 
                 showConnectingLabel ? 'Connecting to Server...' :
                 'Initializing Application...'}
              </h1>
              <p className="text-sm text-[var(--color-text-secondary)] mt-2">
                {showStartingLabel ? 'The database is booting up, this may take a few seconds.' : 
                 showConnectingLabel ? 'Verifying server and database health.' :
                 'Checking application setup status.'}
              </p>
            </div>
          </div>
        </div>
      );
  }

  if (needsSetup) {
      return <SetupWizard onComplete={() => checkSetupStatus().then(() => {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
      })} />;
  }

  if (!authToken) {
      // Invite registration doesn't require auth
      if (location.pathname.startsWith('/invite/')) {
          return <InviteRegister />;
      }

      const handleLogin = async (username: string, password: string) => {
          const success = await login(username, password);
          if (success) {
              usePlayerStore.getState().loadSettings();
              usePlayerStore.getState().fetchLibraryFromServer();
              usePlayerStore.getState().fetchPlaylistsFromServer();
          }
          return success;
      };
      return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <>
      <TrackContextMenu />
      {/* Global Scanning Indicator (admin only) */}
      {isAdmin && isScanningGlobal && scannerVisible && (() => {
        const scanPhase = usePlayerStore.getState().scanPhase;
        const isAnalysis = scanPhase === 'analysis';
        const isMetaOrAnalysis = scanPhase === 'metadata' || scanPhase === 'analysis';
        const activeFiles = usePlayerStore.getState().activeFiles;

        return (
          <div className="global-scanning-indicator">
            <button className="scanner-hide-btn" onClick={() => setScannerVisible(false)} title="Hide">
              <X size={14} />
            </button>

            <div className="scan-header-row">
              <div className="scanning-spinner" />
              <div className="scan-info-col">
                <div className="scan-title-row">
                  <span className="scan-title">
                    {isAnalysis ? 'Analyzing Audio...' : 'Scanning Library...'}
                  </span>
                  <span className={`scan-phase-badge ${isAnalysis ? 'scan-phase-badge--analysis' : 'scan-phase-badge--other'}`}>
                    {scanPhase}
                  </span>
                </div>

                {isMetaOrAnalysis ? (
                  <div className="scan-progress-row">
                    <span>{usePlayerStore.getState().scannedFiles} / {usePlayerStore.getState().totalFiles} {isAnalysis ? 'tracks' : 'files'}</span>
                    <span>{usePlayerStore.getState().activeWorkers} workers</span>
                  </div>
                ) : (
                  <div className="scan-walk-status">
                    {scanningFileGlobal || 'Discovering files...'}
                  </div>
                )}
              </div>
            </div>

            {isMetaOrAnalysis && activeFiles.length > 0 && (
              <div className="scan-active-files">
                <div className="scan-active-files-heading">
                  {isAnalysis ? 'Currently Analyzing:' : 'Currently Processing:'}
                </div>
                <ul className="scan-active-files-list">
                  {activeFiles.slice(0, 10).map((file, i) => (
                    <li key={i}>{file}</li>
                  ))}
                  {activeFiles.length > 10 && (
                    <li className="scan-active-files-more">
                      ...and {activeFiles.length - 10} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        );
      })()}

      <div className="flex h-screen relative z-10 overflow-hidden text-[var(--color-text-primary)]">


        <main className="flex-1 flex flex-col min-w-0 relative">
          
          {/* Mobile Header (Hidden on Desktop) */}
          <div className="md:hidden px-4 pt-[max(0.75rem,var(--safe-area-top))] pb-3 flex items-center justify-between border-b border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md">
            <AudioWaveform size={22} className="text-[var(--color-primary)]" />
            <div className="flex items-center gap-1">
              {isAdmin && isScanningGlobal && (
                <button
                  onClick={() => setScannerVisible(v => !v)}
                  className="scan-indicator-btn scan-indicator-btn--dot-only"
                  title={scannerVisible ? 'Hide scan progress' : 'Show scan progress'}
                >
                  <div className="scan-indicator-dot" />
                </button>
              )}
              <GlobalSearch />
              <UserMenu onOpenSettings={() => setIsSettingsOpen(true)} />
            </div>
          </div>

          <div className="hidden md:flex items-center flex-none gap-3 overflow-x-auto hide-scrollbar z-20 w-full py-3 px-4 md:px-8 lg:px-12">
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
              <UserMenu onOpenSettings={() => setIsSettingsOpen(true)} />
              {isAdmin && isScanningGlobal && (
                <button
                  onClick={() => setScannerVisible(v => !v)}
                  className="scan-indicator-btn"
                  title={scannerVisible ? 'Hide scan progress' : 'Show scan progress'}
                >
                  <div className="scan-indicator-dot" />
                  <span>Scanning</span>
                </button>
              )}
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
            <div className={`flex-1 overflow-y-auto ${playlist.length > 0 ? 'pb-32 md:pb-48' : 'pb-16 md:pb-4'}`}>
              {library.length === 0 ? (
                <Routes>
                  <Route path="/invite/:token" element={<InviteRegister />} />
                  <Route path="*" element={
                    <div className="empty-state font-body flex flex-col items-center justify-center p-8 flex-1">
                      <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-[var(--aurora-green)] to-[var(--aurora-purple)] mb-4">
                        NorthernLights
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
                          className="btn btn-lg whitespace-nowrap"
                          disabled={isScanningGlobal || !folderPathInput.trim()}
                        >
                          {isScanningGlobal ? '✦ Scanning...' : '✦ Map Folder'}
                        </button>
                      </div>
                    </div>
                  } />
                </Routes>
              ) : (
                <Routes>
                  <Route path="/" element={<Navigate to="/library" replace />} />
                  <Route path="/invite/:token" element={<InviteRegister />} />
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

          {/* Floating Playback Controls Footer — Desktop Only */}
          {playlist.length > 0 && (
            <div className="hidden md:block absolute bottom-6 left-1/2 -translate-x-1/2 w-11/12 max-w-4xl z-40 bg-[var(--glass-bg)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-[2rem] p-4 pb-5 shadow-2xl">
              <ProgressBar />
              <div className="mt-2">
                <PlayerControls />
              </div>
            </div>
          )}

          {/* Mobile Mini Player */}
          {playlist.length > 0 && <MobileMiniPlayer />}

          {/* Mobile Bottom Tabs */}
          <MobileBottomTabs />

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
