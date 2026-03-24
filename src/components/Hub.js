import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store';
import { Play } from 'lucide-react';
import { useDominantColor } from '../hooks/useDominantColor';
// Inner component to handle color extraction per playlist card
const PlaylistCard = ({ collection, onPlay }) => {
    const { theme } = usePlayerStore();
    const { artUrls, primaryArt, bgColor } = useDominantColor(collection.tracks);
    return (_jsxs("div", { className: "relative group overflow-hidden rounded-[2rem] p-8 w-[28rem] h-80 flex-none snap-start flex flex-col justify-between transition-transform duration-300 hover:scale-[1.02]", children: [_jsx("div", { className: "absolute inset-0 z-0 transition-all duration-300", style: {
                    backgroundImage: `
            linear-gradient(135deg, ${bgColor}dd 0%, ${bgColor}44 100%),
            url("${primaryArt}")
          `,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    filter: theme === 'dark' ? 'brightness(0.7) blur(16px)' : 'brightness(1.1) blur(16px)',
                    transform: 'scale(1.1)' // Prevent blurred edges from leaking
                } }), _jsx("div", { className: "absolute inset-0 z-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 Mix-blend-overlay", style: {
                    backgroundImage: `radial-gradient(circle at 50% 50%, ${bgColor} 0%, transparent 70%)`,
                    filter: 'blur(32px)'
                } }), _jsxs("div", { className: "relative z-10 space-y-3 drop-shadow-md", children: [_jsx("h3", { className: "text-3xl font-bold text-white tracking-tight leading-tight", children: collection.title || 'Untitled Playlist' }), collection.description && (_jsx("p", { className: "text-white/80 text-sm line-clamp-3 leading-relaxed max-w-[85%]", children: collection.description }))] }), _jsxs("div", { className: "relative z-10 mt-auto pt-6 flex items-end justify-between", children: [_jsx("button", { onClick: onPlay, className: "px-6 py-3 rounded-full bg-white/20 hover:bg-white/30 border border-white/30 backdrop-blur-md text-white font-medium flex items-center space-x-2 transition-all duration-300 hover:shadow-[0_0_20px_rgba(255,255,255,0.3)] group/btn", children: _jsx("span", { children: "Start Listening" }) }), _jsx("div", { className: "flex -space-x-3 drop-shadow-lg", children: artUrls.map((url, i) => (_jsx("img", { src: url, alt: "", className: `w-12 h-12 rounded-full border-2 border-white/20 object-cover ${i === 0 ? 'z-40' : i === 1 ? 'z-30' : i === 2 ? 'z-20' : 'z-10'}` }, i))) })] })] }));
};
// Inner component for Non-LLM Collections (Cascading Cover-Flow)
const NonLlmPlaylistCard = ({ collection, onPlay }) => {
    const { theme } = usePlayerStore();
    const { artUrls, primaryArt, bgColor } = useDominantColor(collection.tracks);
    return (_jsxs("div", { className: "relative group overflow-hidden rounded-[2rem] p-8 w-[28rem] h-80 flex-none snap-start flex flex-col transition-transform duration-300 hover:scale-[1.02] bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-[var(--shadow-md)]", children: [_jsx("div", { className: "absolute inset-0 z-0 opacity-10 pointer-events-none transition-opacity duration-500 group-hover:opacity-20 mix-blend-screen", style: {
                    background: `radial-gradient(circle at 0% 50%, ${bgColor}, transparent 80%)`,
                } }), _jsxs("div", { className: "relative z-10 flex items-center h-[140px] w-full mb-4", children: [artUrls.map((url, i) => {
                        const scale = 1 - (i * 0.15);
                        const leftOffset = i * 45;
                        return (_jsx("div", { className: "absolute rounded-2xl overflow-hidden shadow-2xl border border-white/20 transition-all duration-500 ease-out group-hover:translate-x-3 group-hover:rotate-1", style: {
                                width: '120px',
                                height: '120px',
                                left: `${leftOffset}px`,
                                zIndex: 10 - i,
                                transform: `scale(${scale})`,
                                transformOrigin: 'left center',
                                filter: `brightness(${1 - i * 0.15})`,
                            }, children: _jsx("img", { src: url, alt: "", className: "w-full h-full object-cover" }) }, i));
                    }), artUrls.length === 0 && (_jsx("div", { className: "w-[120px] h-[120px] rounded-2xl bg-black/10 border border-white/10 flex items-center justify-center text-white/30 absolute z-10", children: "No Art" }))] }), _jsxs("div", { className: "relative z-10 flex flex-col items-start gap-1 flex-1 justify-end pb-2", children: [_jsx("h3", { className: "text-2xl font-bold tracking-tight text-[var(--color-primary)] drop-shadow-sm", children: collection.title || 'Untitled Playlist' }), collection.description && (_jsx("p", { className: "text-[var(--color-text-secondary)] text-sm line-clamp-2 mb-2 font-medium", children: collection.description }))] }), _jsx("div", { className: "relative z-10 pt-2 flex items-center mt-auto border-t border-[var(--glass-border)]", children: _jsxs("button", { onClick: onPlay, className: "mt-4 px-6 py-2.5 rounded-full bg-[var(--color-primary)] hover:brightness-110 text-white font-semibold shadow-lg shadow-[var(--color-primary)]/30 transition-all duration-300 transform active:scale-95 inline-flex items-center gap-2", children: [_jsx(Play, { className: "w-4 h-4" }), _jsx("span", { children: collection.title === 'Up next' || collection.title === 'Jump back in' ? 'Resume' : 'Play' })] }) })] }));
};
export const Hub = () => {
    const { library, setPlaylist, getAuthHeader } = usePlayerStore();
    const [collections, setCollections] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isGenerating, setIsGenerating] = useState(false);
    const fetchHubData = async () => {
        setIsLoading(true);
        try {
            // GET-only: reads engine-driven + cached LLM playlists from the server.
            // LLM generation is triggered separately after scans and on a 4h schedule.
            const res = await fetch('/api/hub');
            if (res.ok) {
                const data = await res.json();
                const mappedCollections = data.collections.map((col) => ({
                    ...col,
                    tracks: col.tracks.map((t) => {
                        // For LLM playlists, fall back to the raw server track data
                        // so they still render even if library lookup fails
                        const libTrack = library.find(lt => lt.id === t.id);
                        return libTrack || (col.isLlmGenerated ? t : null);
                    }).filter(Boolean)
                })).filter((col) => col.tracks.length > 0);
                setCollections(mappedCollections);
            }
        }
        catch (e) {
            console.error('Failed to load hub data', e);
        }
        finally {
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
        }
        catch (e) {
            console.error('Failed to generate playlists', e);
        }
        finally {
            setIsGenerating(false);
        }
    };
    const handlePlayCollection = (tracks) => {
        setPlaylist(tracks, 0);
    };
    if (isLoading) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsx("div", { className: "animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[var(--color-primary)]" }) }));
    }
    // Separate AI Playlists from User Playlists (or Up Next queues)
    const aiPlaylists = collections.filter(c => c.isLlmGenerated);
    const otherCollections = collections.filter(c => !c.isLlmGenerated);
    return (_jsxs("div", { className: "page-container space-y-12", children: [_jsx("h1", { className: "text-4xl font-bold tracking-tight text-[var(--color-text-primary)]", children: "Home" }), aiPlaylists.length > 0 && (_jsxs("section", { className: "space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-2xl font-bold text-[var(--color-text-primary)]", children: "For You" }), _jsx("p", { className: "text-[var(--color-text-secondary)]", children: "Curated intelligently for your current vibe." })] }), _jsx("div", { className: "flex overflow-x-auto pb-6 space-x-6 hide-scrollbar snap-x snap-mandatory", children: aiPlaylists.map((collection, idx) => (_jsx(PlaylistCard, { collection: collection, onPlay: () => handlePlayCollection(collection.tracks) }, collection.id || idx))) })] })), otherCollections.length > 0 && (_jsxs("section", { className: "space-y-6", children: [_jsx("div", { children: _jsx("h2", { className: "text-2xl font-bold text-[var(--color-text-primary)]", children: "Discover" }) }), _jsx("div", { className: "flex overflow-x-auto pb-6 space-x-6 hide-scrollbar snap-x snap-mandatory", children: otherCollections.map((collection, idx) => (_jsx(NonLlmPlaylistCard, { collection: collection, onPlay: () => handlePlayCollection(collection.tracks) }, collection.id || idx))) })] })), aiPlaylists.length === 0 && (_jsxs("div", { className: "flex flex-col items-center justify-center text-[var(--color-text-secondary)] py-16", children: [_jsx("p", { className: "mb-4 text-lg font-semibold text-[var(--color-text-primary)]", children: "No AI Playlists Yet" }), _jsxs("p", { className: "text-sm mb-8 text-center max-w-md", children: ["Connect an LLM (e.g. LM Studio) in ", _jsx("strong", { children: "Settings \u2192 Providers" }), ", then generate your first personalised playlists."] }), _jsxs("button", { onClick: handleGeneratePlaylists, disabled: isGenerating || library.length === 0, className: "px-8 py-3 rounded-full bg-[var(--color-primary)] hover:brightness-110 text-white font-semibold shadow-lg shadow-[var(--color-primary)]/30 transition-all duration-300 transform active:scale-95 inline-flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed", children: [isGenerating ? (_jsx("div", { className: "w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" })) : (_jsx("span", { className: "text-xl leading-none -mt-1", children: "\u2728" })), _jsx("span", { children: isGenerating ? 'Generating Playlists...' : 'Generate AI Playlists Now' })] }), library.length === 0 && (_jsx("p", { className: "text-xs text-[var(--color-error)] mt-4 font-medium backdrop-blur-md bg-[var(--color-surface)] px-4 py-2 rounded-full border border-[var(--glass-border)]", children: "You must scan music into your library first" }))] }))] }));
};
