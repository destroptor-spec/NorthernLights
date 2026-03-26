import React, { useEffect, useState } from 'react';
import { usePlayerStore } from '../store';
import { Play, Pin, PinOff, Disc3 } from 'lucide-react';
import type { TrackInfo } from '../utils/fileSystem';
import type { Playlist } from '../store';
import { useDominantColor } from '../hooks/useDominantColor';

type HubCollection = Partial<Playlist> & { tracks: TrackInfo[] };

// Inner component to handle color extraction per playlist card
const PlaylistCard: React.FC<{ collection: HubCollection; onPlay: () => void; onPinToggle?: () => void }> = ({ collection, onPlay, onPinToggle }) => {
  const { theme } = usePlayerStore();
  const { artUrls, primaryArt, bgColor } = useDominantColor(collection.tracks);

  return (
    <div className="relative group overflow-hidden rounded-[2rem] p-8 w-[28rem] h-80 flex-none snap-start flex flex-col justify-between transition-transform duration-300 hover:scale-[1.02]">
      {/* Matte Glass Background */}
      <div 
        className="absolute inset-0 z-0 transition-all duration-300"
        style={{
          backgroundImage: `
            linear-gradient(135deg, ${bgColor}dd 0%, ${bgColor}44 100%),
            url("${primaryArt}")
          `,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: theme === 'dark' ? 'brightness(0.7) blur(16px)' : 'brightness(1.1) blur(16px)',
          transform: 'scale(1.1)' // Prevent blurred edges from leaking
        }}
      />
      
      {/* Additional Glow on Hover */}
      <div 
        className="absolute inset-0 z-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 Mix-blend-overlay"
        style={{
          backgroundImage: `radial-gradient(circle at 50% 50%, ${bgColor} 0%, transparent 70%)`,
          filter: 'blur(32px)'
        }}
      />

      {/* Content - Z-Index 10 */}
      <div className="relative z-10 space-y-3 drop-shadow-md">
        <div className="flex items-start justify-between">
          <h3 className="text-3xl font-bold text-white tracking-tight leading-tight">
            {collection.title || 'Untitled Playlist'}
          </h3>
          {onPinToggle && (
            <button
              onClick={(e) => { e.stopPropagation(); onPinToggle(); }}
              className={`p-2 rounded-full transition-all duration-200 ${collection.pinned ? 'bg-white/30 text-white' : 'bg-white/10 text-white/50 opacity-0 group-hover:opacity-100'} hover:bg-white/30 hover:text-white`}
              title={collection.pinned ? 'Unpin' : 'Pin'}
            >
              {collection.pinned ? <Pin className="w-4 h-4" /> : <PinOff className="w-4 h-4" />}
            </button>
          )}
        </div>
        {collection.description && (
          <p className="text-white/80 text-sm line-clamp-3 leading-relaxed max-w-[85%]">
            {collection.description}
          </p>
        )}
      </div>

      <div className="relative z-10 mt-auto pt-6 flex items-end justify-between">
        <button 
          onClick={onPlay}
          className="px-6 py-3 rounded-full bg-white/20 hover:bg-white/30 border border-white/30 backdrop-blur-md text-white font-medium flex items-center space-x-2 transition-all duration-300 hover:shadow-[0_0_20px_rgba(255,255,255,0.3)] group/btn"
        >
          <span>Start Listening</span>
        </button>
        
        {/* Collage of covers */}
        <div className="flex -space-x-3 drop-shadow-lg">
          {artUrls.map((url, i) => (
             <img 
               key={i} 
               src={url} 
               alt="" 
               className={`w-12 h-12 rounded-full border-2 border-white/20 object-cover ${i === 0 ? 'z-40' : i === 1 ? 'z-30' : i === 2 ? 'z-20' : 'z-10'}`} 
             />
          ))}
        </div>
      </div>
    </div>
  );
};

// Inner component for Non-LLM Collections (Cascading Cover-Flow)
const NonLlmPlaylistCard: React.FC<{ collection: HubCollection; onPlay: () => void }> = ({ collection, onPlay }) => {
  const { theme } = usePlayerStore();
  const { artUrls, primaryArt, bgColor } = useDominantColor(collection.tracks);

  return (
    <div className="relative group overflow-hidden rounded-[2rem] p-8 w-[28rem] h-80 flex-none snap-start flex flex-col transition-transform duration-300 hover:scale-[1.02] bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-[var(--shadow-md)]">
      
      {/* Background Soft Glow */}
      <div 
        className="absolute inset-0 z-0 opacity-10 pointer-events-none transition-opacity duration-500 group-hover:opacity-20 mix-blend-screen"
        style={{
          background: `radial-gradient(circle at 0% 50%, ${bgColor}, transparent 80%)`,
        }}
      />

      {/* Cascading Covers (Left aligned) */}
      <div className="relative z-10 flex items-center h-[140px] w-full mb-4">
        {artUrls.map((url, i) => {
           const scale = 1 - (i * 0.15);
           const leftOffset = i * 45;
           return (
             <div 
               key={i} 
               className="absolute rounded-2xl overflow-hidden shadow-2xl border border-white/20 transition-all duration-500 ease-out group-hover:translate-x-3 group-hover:rotate-1"
               style={{
                 width: '120px',
                 height: '120px',
                 left: `${leftOffset}px`,
                 zIndex: 10 - i,
                 transform: `scale(${scale})`,
                 transformOrigin: 'left center',
                 filter: `brightness(${1 - i*0.15})`,
               }}
             >
                <img src={url} alt="" className="w-full h-full object-cover" />
             </div>
           );
        })}
        {artUrls.length === 0 && (
          <div className="w-[120px] h-[120px] rounded-2xl bg-[var(--color-surface)] border border-[var(--glass-border)] flex items-center justify-center absolute z-10">
            <Disc3 size={48} className="text-[var(--color-text-muted)] opacity-30" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="relative z-10 flex flex-col items-start gap-1 flex-1 justify-end pb-2">
        <h3 className="text-2xl font-bold tracking-tight text-[var(--color-primary)] drop-shadow-sm">
          {collection.title || 'Untitled Playlist'}
        </h3>
        {collection.description && (
          <p className="text-[var(--color-text-secondary)] text-sm line-clamp-2 mb-2 font-medium">
            {collection.description}
          </p>
        )}
      </div>

      <div className="relative z-10 pt-2 flex items-center mt-auto border-t border-[var(--glass-border)]">
        <button 
          onClick={onPlay}
          className="mt-4 px-6 py-2.5 rounded-full bg-[var(--color-primary)] hover:brightness-110 text-white font-semibold shadow-lg shadow-[var(--color-primary)]/30 transition-all duration-300 transform active:scale-95 inline-flex items-center gap-2"
        >
          <Play className="w-4 h-4" />
          <span>{collection.title === 'Up next' || collection.title === 'Jump back in' ? 'Resume' : 'Play'}</span>
        </button>
      </div>
    </div>
  );
};

export const Hub: React.FC = () => {
  const { library, setPlaylist, getAuthHeader, togglePin } = usePlayerStore();
  const [collections, setCollections] = useState<HubCollection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  const fetchHubData = async () => {
    setIsLoading(true);
    try {
      // GET-only: reads engine-driven + cached LLM playlists from the server.
      // LLM generation is triggered separately after scans and on a 4h schedule.
      const res = await fetch('/api/hub', { headers: getAuthHeader() });
      
      if (res.ok) {
        const data = await res.json();
        const mappedCollections = data.collections.map((col: any) => ({
           ...col,
           tracks: col.tracks.map((t: any) => {
             // For LLM playlists, fall back to the raw server track data
             // so they still render even if library lookup fails
             const libTrack = library.find(lt => lt.id === t.id);
             return libTrack || (col.isLlmGenerated ? t : null);
           }).filter(Boolean)
        })).filter((col: any) => col.tracks.length > 0);
        
        setCollections(mappedCollections);
      }
    } catch (e) {
      console.error('Failed to load hub data', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (library.length > 0) {
      fetchHubData();
    }
  }, [library]);

  const handleGeneratePlaylists = async () => {
    setIsGenerating(true);
    try {
      const authHeaders = getAuthHeader();
      await fetch('/api/hub/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ force: true })
      });
      await fetchHubData();
    } catch (e) {
      console.error('Failed to generate playlists', e);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTogglePin = (collectionId: string, pinned: boolean) => {
    togglePin(collectionId, pinned);
    setCollections(prev => prev.map(c => c.id === collectionId ? { ...c, pinned } : c));
  };

  const handlePlayCollection = (tracks: TrackInfo[]) => {
    setPlaylist(tracks, 0);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[var(--color-primary)]"></div>
      </div>
    );
  }

  // Separate AI Playlists from User Playlists (or Up Next queues)
  const aiPlaylists = collections.filter(c => c.isLlmGenerated);
  const otherCollections = collections.filter(c => !c.isLlmGenerated);

  return (
    <div className="page-container space-y-12">
      <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text-primary)]">Home</h1>
      
      {aiPlaylists.length > 0 && (
        <section className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">For You</h2>
            <p className="text-[var(--color-text-secondary)]">Curated intelligently for your current vibe.</p>
          </div>
          <div className="flex overflow-x-auto pb-6 space-x-6 hide-scrollbar snap-x snap-mandatory">
            {aiPlaylists.map((collection, idx) => (
               <PlaylistCard 
                 key={collection.id || idx} 
                 collection={collection} 
                 onPlay={() => handlePlayCollection(collection.tracks)} 
                 onPinToggle={() => collection.id && handleTogglePin(collection.id, !collection.pinned)}
               />
            ))}
          </div>
        </section>
      )}

      {otherCollections.length > 0 && (
         <section className="space-y-6">
           <div>
             <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">Discover</h2>
           </div>
           <div className="flex overflow-x-auto pb-6 space-x-6 hide-scrollbar snap-x snap-mandatory">
             {otherCollections.map((collection, idx) => (
                <NonLlmPlaylistCard 
                  key={collection.id || idx} 
                  collection={collection} 
                  onPlay={() => handlePlayCollection(collection.tracks)} 
                />
             ))}
           </div>
         </section>
      )}

      {aiPlaylists.length === 0 && (
         <div className="flex flex-col items-center justify-center text-[var(--color-text-secondary)] py-16">
           <p className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">No AI Playlists Yet</p>
           <p className="text-sm mb-8 text-center max-w-md">
             Connect an LLM (e.g. LM Studio) in <strong>Settings → Providers</strong>, then generate your first personalised playlists.
           </p>
           
           <button 
             onClick={handleGeneratePlaylists}
             disabled={isGenerating || library.length === 0}
             className="px-8 py-3 rounded-full bg-[var(--color-primary)] hover:brightness-110 text-white font-semibold shadow-lg shadow-[var(--color-primary)]/30 transition-all duration-300 transform active:scale-95 inline-flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
           >
             {isGenerating ? (
               <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
             ) : (
               <span className="text-xl leading-none -mt-1">✨</span>
             )}
             <span>{isGenerating ? 'Generating Playlists...' : 'Generate AI Playlists Now'}</span>
           </button>
           
           {library.length === 0 && (
             <p className="text-xs text-[var(--color-error)] mt-4 font-medium backdrop-blur-md bg-[var(--color-surface)] px-4 py-2 rounded-full border border-[var(--glass-border)]">
               You must scan music into your library first
             </p>
           )}
         </div>
      )}
    </div>
  );
};
