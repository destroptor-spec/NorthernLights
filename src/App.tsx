import React from 'react';
import { PlaylistSidebar } from './components/PlaylistSidebar';
import PlayerShell from './components/PlayerShell';
import MobileMiniPlayer from './components/MobileMiniPlayer';
import MobileBottomTabs from './components/MobileBottomTabs';
import MobileHeader from './components/MobileHeader';
import DesktopTabBar from './components/DesktopTabBar';
import MainContent, { InviteRegister } from './components/MainContent';
import CastHealthToasts from './components/cast/CastHealthToasts';
import KeyboardHint from './components/KeyboardHint';
import { usePlayerStore } from './store/index';
import { RefreshCw, WifiOff } from 'lucide-react';
import { ToastContainer } from './components/ToastContainer';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useSSE } from './hooks/useSSE';
import { useToast } from './hooks/useToast';
import { playbackManager } from './utils/PlaybackManager';
import { GlobalScanningIndicator } from './components/GlobalScanningIndicator';
import { applyPendingPwaUpdate } from './utils/pwaUpdate';
import { isServerDatabaseConnected } from './utils/serverHealth';

const SetupWizard = React.lazy(() => import('./components/SetupWizard').then(module => ({ default: module.SetupWizard })));
const LoginPage = React.lazy(() => import('./components/LoginPage').then(module => ({ default: module.LoginPage })));
const SharedPlaylistView = React.lazy(() => import('./components/SharedPlaylistView').then(module => ({ default: module.SharedPlaylistView })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const TrackContextMenu = React.lazy(() => import('./components/library/TrackContextMenu').then(module => ({ default: module.TrackContextMenu })));
const DatabaseControl = React.lazy(() => import('./components/DatabaseControl').then(module => ({ default: module.DatabaseControl })));

const FullPageFallback: React.FC<{ label?: string }> = ({ label = 'Loading...' }) => (
  <div className="h-screen w-full flex flex-col items-center justify-center bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
    <div className="w-12 h-12 border-4 border-primary/20 border-t-[var(--color-primary)] rounded-full animate-spin" />
    <p className="mt-4 text-sm text-[var(--color-text-secondary)]">{label}</p>
  </div>
);

let authExpirationFetchInterceptorInstalled = false;

const isProtectedApiRequest = (input: RequestInfo | URL): boolean => {
  const rawUrl = input instanceof Request ? input.url : input.toString();
  let url: URL;
  try {
    url = new URL(rawUrl, window.location.origin);
  } catch {
    return false;
  }

  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return false;
  if (
    url.pathname === '/api/auth/login' ||
    url.pathname === '/api/auth/register' ||
    url.pathname === '/api/setup/status' ||
    url.pathname === '/api/setup/complete' ||
    url.pathname === '/api/health' ||
    url.pathname.startsWith('/api/invites/') ||
    url.pathname.startsWith('/api/public/') ||
    url.pathname === '/api/providers/external/proxy-image'
  ) {
    return false;
  }

  return true;
};

const getRequestToken = (input: RequestInfo | URL, init?: RequestInit): string | null => {
  const readHeaders = (headers?: HeadersInit | null): string | null => {
    if (!headers) return null;
    const authorization = new Headers(headers).get('Authorization');
    return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  };

  const headerToken = readHeaders(init?.headers) || (input instanceof Request ? readHeaders(input.headers) : null);
  if (headerToken) return headerToken;

  const rawUrl = input instanceof Request ? input.url : input.toString();
  try {
    return new URL(rawUrl, window.location.origin).searchParams.get('token');
  } catch {
    return null;
  }
};

const installAuthExpirationFetchInterceptor = () => {
  if (authExpirationFetchInterceptorInstalled || typeof window === 'undefined') return;
  authExpirationFetchInterceptorInstalled = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    const currentToken = usePlayerStore.getState().authToken;
    const requestToken = getRequestToken(input, init);
    if (
      response.status === 401 &&
      isProtectedApiRequest(input) &&
      currentToken &&
      requestToken === currentToken
    ) {
      usePlayerStore.getState().expireAuthSession();
    }
    return response;
  };
};

const App: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [dbConnected, _setDbConnected] = React.useState<boolean | null>(null);
  const dbConnectedRef = React.useRef<boolean | null>(null);
  
  const setDbConnected = React.useCallback((val: boolean | null) => {
    dbConnectedRef.current = val;
    _setDbConnected(val);
  }, []);
  const [isDatabaseStarting, setIsDatabaseStarting] = React.useState(false);
  const needsSetup = usePlayerStore(state => state.needsSetup);
  const setupAdminCreated = usePlayerStore(state => state.setupAdminCreated);
  const setupStatusError = usePlayerStore(state => state.setupStatusError);
  const checkSetupStatus = usePlayerStore(state => state.checkSetupStatus);
  const authToken = usePlayerStore(state => state.authToken);
  const sseAccessToken = usePlayerStore(state => state.sseAccessToken);
  const authExpired = usePlayerStore(state => state.authExpired);
  const authExpiredMessage = usePlayerStore(state => state.authExpiredMessage);
  const authExpiredUsername = usePlayerStore(state => state.authExpiredUsername);
  const rememberDevice = usePlayerStore(state => state.rememberDevice);
  const login = usePlayerStore(state => state.login);

  const [isScannerVisibleLocally, setIsScannerVisibleLocally] = React.useState(false);
  const isScanningGlobal = usePlayerStore(state => state.isScanning);
  const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);
  const playlist = usePlayerStore(state => state.playlist);
  const currentUser = usePlayerStore(state => state.currentUser);
  const isAdmin = currentUser?.role === 'admin';

  // Stable callbacks so the memoized headers don't re-render when App re-renders
  // for unrelated reasons (scan state, playlist changes, etc.).
  const openSettings = React.useCallback(() => setIsSettingsOpen(true), []);
  const toggleScanner = React.useCallback(() => setIsScannerVisibleLocally(v => !v), []);

  // Auto-show scanner toast when a scan starts
  React.useEffect(() => {
    if (isScanningGlobal) setIsScannerVisibleLocally(true);
  }, [isScanningGlobal]);

  // Initialize AudioContext on first user interaction (Safari requires this)
  React.useEffect(() => {
    const initAudio = () => {
      playbackManager.ensureAudioContext();
    };
    document.addEventListener('click', initAudio, { once: true });
    document.addEventListener('touchstart', initAudio, { once: true });
    return () => {
      document.removeEventListener('click', initAudio);
      document.removeEventListener('touchstart', initAudio);
    };
  }, []);

  const continuityRestoreAttemptedRef = React.useRef(false);
  React.useEffect(() => {
    if (continuityRestoreAttemptedRef.current || needsSetup !== false || !authToken || dbConnected !== true) return;
    continuityRestoreAttemptedRef.current = true;
    window.setTimeout(() => {
      void playbackManager.restoreFromContinuitySnapshot();
    }, 500);
  }, [authToken, dbConnected, needsSetup]);

  // Health check function accessible from render
  const checkHealth = React.useCallback(async () => {
    const connected = await isServerDatabaseConnected();
    setDbConnected(connected);
    return connected;
  }, []);

  // Trigger an initial library fetch, apply theme, and subscribe to scan events
  React.useEffect(() => {
    installAuthExpirationFetchInterceptor();
    usePlayerStore.getState().setTheme(usePlayerStore.getState().theme);
    usePlayerStore.getState().setReducedMotion(usePlayerStore.getState().reducedMotion);

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

  React.useEffect(() => {
    if (!authToken || needsSetup) return;

    let cancelled = false;
    const validateSession = async () => {
      const token = usePlayerStore.getState().authToken;
      if (!token) return;
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.user) {
          usePlayerStore.setState({ currentUser: data.user });
        }
      } catch {
        // Network and database health are handled separately.
      }
    };

    validateSession();
    const interval = window.setInterval(validateSession, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [authToken, needsSetup]);

  // Connect to scan status SSE only when authenticated (EventSource can't send headers)
  const onSSEMessage = React.useCallback((data: any) => {
    const d = data as {
      isScanning: boolean;
      phase: 'idle' | 'walk' | 'metadata' | 'analysis' | 'loudness';
      scannedFiles: number;
      totalFiles: number;
      activeWorkers: number;
      activeFiles: string[];
      currentFile: string;
      libraryChanged: boolean;
    };
    const wasScanning = usePlayerStore.getState().isScanning;
    usePlayerStore.getState().setIsScanning(
      d.isScanning,
      d.phase,
      d.scannedFiles,
      d.totalFiles,
      d.activeWorkers,
      d.activeFiles,
      d.currentFile
    );
    if (wasScanning && !d.isScanning && d.libraryChanged) {
      (async () => {
        await usePlayerStore.getState().fetchLibraryFromServer();
        await usePlayerStore.getState().fetchPlaylistsFromServer();
      })();
    }
  }, []);

  useSSE(
    !needsSetup && (sseAccessToken || authToken) ? `/api/library/scan/status?token=${encodeURIComponent(sseAccessToken || authToken || '')}` : null,
    { onMessage: onSSEMessage, throttleMs: 100 }
  );

  // Offline detection
  const isOnline = useOnlineStatus();
  const { addToast } = useToast();
  const prevOnlineRef = React.useRef(isOnline);
  const pendingUpdate = usePlayerStore(state => state.pendingUpdate);
  const setPendingUpdate = usePlayerStore(state => state.setPendingUpdate);
  const playbackState = usePlayerStore(state => state.playbackState);

  React.useEffect(() => {
    if (prevOnlineRef.current !== isOnline) {
      if (!isOnline) {
        addToast('You are offline. Some features may be unavailable.', 'info');
      } else {
        addToast('Back online.', 'success');
      }
      prevOnlineRef.current = isOnline;
    }
  }, [isOnline, addToast]);

  // Surface MusicBrainz OAuth callback status from the redirect back to the app.
  // Lives at App level (not MetadataTab) so the outcome is visible regardless
  // of which route the user lands on after the redirect.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('mb_connected');
    const error = params.get('mb_error');
    if (!connected && !error) return;
    if (connected) {
      addToast('MusicBrainz connected successfully', 'success');
      usePlayerStore.getState().loadSettings();
    } else if (error) {
      addToast(`MusicBrainz authorization failed: ${error}`, 'error');
    }
    params.delete('mb_connected');
    params.delete('mb_error');
    const query = params.toString();
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
  }, [addToast]);

  // Surface Last.fm OAuth callback status from the redirect back to the app.
  // This must live at App level rather than inside the settings account tab,
  // because the documented Last.fm web auth flow returns to the app root.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('lfm_connected');
    const error = params.get('lfm_error');
    if (!connected && !error) return;

    if (connected) {
      addToast('Last.fm connected successfully', 'success');
      usePlayerStore.getState().loadSettings();
    } else if (error) {
      addToast(`Last.fm authorization failed: ${error}`, 'error');
    }

    params.delete('lfm_connected');
    params.delete('lfm_error');
    const query = params.toString();
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
  }, [addToast]);

  const handleApplyPwaUpdate = React.useCallback(() => {
    // Snapshot where we are so the new build can pick up from the same track and
    // position. This works mid-playback too: restoreFromContinuitySnapshot() runs
    // on the next load and resumes (the browser may require a tap to actually
    // start audio after a reload, but nothing is lost).
    playbackManager.persistContinuitySnapshot();
    void applyPendingPwaUpdate();
  }, []);

  const isSidebarOpen = usePlayerStore((s) => s.isSidebarOpen);
  const setIsSidebarOpen = usePlayerStore((s) => s.setIsSidebarOpen);

  // Mobile bottom sheet touch handling
  const sidebarRef = React.useRef<HTMLDivElement>(null);
  const touchStartY = React.useRef<number>(0);
  const currentTranslateY = React.useRef<number>(0);
  const isDragging = React.useRef<boolean>(false);

  const handleTouchStart = React.useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    isDragging.current = true;
  }, []);

  const handleTouchMove = React.useCallback((e: React.TouchEvent) => {
    if (!isDragging.current || !sidebarRef.current) return;
    const touchY = e.touches[0].clientY;
    const deltaY = touchY - touchStartY.current;
    
    // Only allow dragging downward
    if (deltaY > 0) {
      currentTranslateY.current = deltaY;
      sidebarRef.current.style.transform = `translateY(${deltaY}px)`;
      sidebarRef.current.style.transition = 'none';
    }
  }, []);

  const handleTouchEnd = React.useCallback(() => {
    if (!sidebarRef.current) return;
    isDragging.current = false;
    
    const threshold = window.innerHeight * 0.3; // 30% of screen height
    if (currentTranslateY.current > threshold) {
      // Close the sidebar
      setIsSidebarOpen(false);
    } else {
      // Snap back to open
      sidebarRef.current.style.transform = '';
      sidebarRef.current.style.transition = '';
    }
    currentTranslateY.current = 0;
  }, [setIsSidebarOpen]);

  // Reset sidebar transform when opening/closing
  React.useEffect(() => {
    if (sidebarRef.current) {
      sidebarRef.current.style.transform = '';
      sidebarRef.current.style.transition = '';
    }
  }, [isSidebarOpen]);

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

  const handleLogin = React.useCallback(async (username: string, password: string, rememberDevice: boolean, turnstileToken?: string) => {
    const result = await login(username, password, rememberDevice, turnstileToken);
    if (!result.success) return result;

    await checkSetupStatus();
    if (!usePlayerStore.getState().needsSetup) {
      usePlayerStore.getState().loadSettings();
      usePlayerStore.getState().fetchLibraryFromServer();
      usePlayerStore.getState().fetchPlaylistsFromServer();
    }
    return result;
  }, [checkSetupStatus, login]);

  // Public shared-playlist view — accessible without auth and before any setup/DB
  // gate. Like the invite flow, a share link is always a fresh full-page load, so
  // reading window.location directly is accurate and keeps App location-subscription-free.
  if (window.location.pathname.startsWith('/share/')) {
    return (
      <React.Suspense fallback={<FullPageFallback label="Loading playlist..." />}>
        <SharedPlaylistView />
      </React.Suspense>
    );
  }

  // If the server reports the database is down (or is unreachable while we're
  // ONLINE), show the recovery control panel. When the browser is offline this
  // same dbConnected===false can just mean the health fetch couldn't leave the
  // device — that's not a DB outage, so fall through to the cached app instead
  // of trapping the user on the recovery screen.
  if (dbConnected === false && !isDatabaseStarting && isOnline) {
    return (
      <React.Suspense fallback={<FullPageFallback label="Loading database tools..." />}>
        <DatabaseControl
          onReady={handleDatabaseReady}
        />
      </React.Suspense>
    );
  }

  if (dbConnected === true && needsSetup === null && setupStatusError && isOnline) {
    return (
      <main className="setup-status-error">
        <section className="setup-status-error__panel" role="alert">
          <h1>Setup status unavailable</h1>
          <p>{setupStatusError}</p>
          <button type="button" className="btn btn-primary" onClick={() => void checkSetupStatus()}>
            Retry
          </button>
        </section>
      </main>
    );
  }

  // Loading / Initializing gate
  // Shows if:
  // 1. We are explicitly starting the database
  // 2. We don't know the connection status yet
  // 3. We are connected but don't know the setup status yet
  // Online-only: offline we can't verify health/setup at all, so spinning here
  // would hang forever. Fall through to the cached app (or login) instead.
  if ((isDatabaseStarting || dbConnected === null || (dbConnected === true && needsSetup === null)) && isOnline) {
      const showStartingLabel = isDatabaseStarting;
      const showConnectingLabel = dbConnected === null;
      const showSetupLabel = dbConnected === true && needsSetup === null;

      return (
        <div className="h-screen w-full flex flex-col items-center justify-center bg-[var(--color-bg-primary)]">
          <div className="flex flex-col items-center space-y-6">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-primary/20 border-t-[var(--color-primary)] rounded-full animate-spin" />
              <div className="absolute inset-x-0 -bottom-1 w-full h-1 bg-primary/10 blur-md" />
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

  if (needsSetup && setupAdminCreated && !authToken) {
      return (
        <React.Suspense fallback={<FullPageFallback label="Loading sign in..." />}>
          <LoginPage
            onLogin={handleLogin}
            initialRememberDevice={rememberDevice}
            sessionMessage="Sign in with the admin account to continue first-run setup."
            submitLabel="Resume setup"
          />
        </React.Suspense>
      );
  }

  if (needsSetup) {
      return <React.Suspense fallback={<FullPageFallback label="Loading setup..." />}>
        <SetupWizard onComplete={() => checkSetupStatus().then(() => {
          usePlayerStore.getState().fetchLibraryFromServer();
          usePlayerStore.getState().fetchPlaylistsFromServer();
        })} />
      </React.Suspense>;
  }

  if (!authToken) {
      // Invite registration doesn't require auth. Read window.location directly
      // (rather than useLocation) so App stays free of a location subscription —
      // an invite link is always a fresh full-page load, so this is accurate.
      if (window.location.pathname.startsWith('/invite/')) {
          return (
            <React.Suspense fallback={<FullPageFallback label="Loading invite..." />}>
              <InviteRegister />
            </React.Suspense>
          );
      }

      return (
        <React.Suspense fallback={<FullPageFallback label="Loading sign in..." />}>
          <LoginPage
            onLogin={handleLogin}
            initialUsername={authExpiredUsername}
            initialRememberDevice={rememberDevice}
            sessionMessage={authExpired ? authExpiredMessage : null}
            submitLabel={authExpired ? 'Log in again' : 'Sign in'}
          />
        </React.Suspense>
      );
  }

  return (
    <>
      <div className="app-backdrop" aria-hidden="true" />
      <React.Suspense fallback={null}>
        <TrackContextMenu />
      </React.Suspense>
      {/* Global Scanning Indicator (admin only) */}
      {isAdmin && isScanningGlobal && isScannerVisibleLocally && (
        <GlobalScanningIndicator onClose={() => setIsScannerVisibleLocally(false)} />
      )}

      <div className="flex h-screen relative z-10 overflow-hidden text-[var(--color-text-primary)]">


        <main className="flex-1 flex flex-col min-w-0 relative">
          
          <MobileHeader
            onOpenSettings={openSettings}
            isScannerVisible={isScannerVisibleLocally}
            onToggleScanner={toggleScanner}
          />

          <DesktopTabBar
            onOpenSettings={openSettings}
            isScannerVisible={isScannerVisibleLocally}
            onToggleScanner={toggleScanner}
          />

          {!isOnline && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs sm:text-sm font-medium text-amber-950 bg-amber-400/90 dark:text-amber-100 dark:bg-amber-500/20 border-b border-amber-500/30"
            >
              <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>You're offline — playing from cache. Library updates and search are paused.</span>
            </div>
          )}

          <MainContent />

          <CastHealthToasts />

          {/* Desktop Playback Surface — floats or docks based on user preference */}
          {playlist.length > 0 && (
            <div className="hidden md:block">
              <PlayerShell />
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
          <React.Suspense fallback={null}>
            <SettingsModal onClose={() => setIsSettingsOpen(false)} />
          </React.Suspense>
        )}

        <ToastContainer />

        {/* PWA Update Available Banner */}
        {pendingUpdate && (
          <div className="fixed bottom-6 left-6 z-[10001] flex items-center gap-3 px-5 py-3.5 rounded-2xl border shadow-2xl backdrop-blur-xl bg-[var(--glass-bg)] border-primary/30 max-w-[360px]">
            <div className="flex-1">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">Update Available</p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">Reload to get the latest version.</p>
            </div>
            <button
              onClick={() => setPendingUpdate(false)}
              className="btn btn-ghost btn-sm"
            >
              Later
            </button>
            <button
              onClick={handleApplyPwaUpdate}
              className="btn btn-primary btn-sm flex items-center gap-1.5"
            >
              <RefreshCw size={14} />
              Reload
            </button>
          </div>
        )}

        {/* Mobile Sidebar Overlay Backdrop */}
        {isSidebarOpen && (
           <div 
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden transition-opacity" 
              onClick={() => setIsSidebarOpen(false)} 
            />
        )}
        
        {/* Sidebar Container - Mobile Bottom Sheet / Desktop Right Panel */}
        <div 
          ref={sidebarRef}
          className={`sidebar-bottom-sheet fixed z-50 w-full ${isSidebarCollapsed ? 'md:w-24' : 'md:w-96'} transform transition-[width,transform] duration-300 ease-in-out md:relative md:translate-x-0 border-l border-[var(--glass-border)] ${isSidebarOpen ? 'translate-y-0' : 'translate-y-full md:translate-y-0'}`}
        >
          {/* Drag Handle - Mobile Only */}
          <div 
            className="sidebar-handle md:hidden"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="w-10 h-1 rounded-full bg-[var(--color-text-muted)] opacity-40" />
          </div>
          <div className="h-full overflow-hidden">
            <PlaylistSidebar />
          </div>
        </div>
      </div>
    </>
  );
};

export default App;
