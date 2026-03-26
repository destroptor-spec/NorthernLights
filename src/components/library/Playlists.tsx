import React, { useState } from 'react';
import { usePlayerStore } from '../../store';
import { Play, Plus, Sparkles, X, Loader2, Trash2, Pin, PinOff } from 'lucide-react';
import { useDominantColor } from '../../hooks/useDominantColor';
import type { Playlist } from '../../store';

const PlaylistListItem: React.FC<{ playlist: Playlist; onPlay: () => void; onDelete: () => void; onPinToggle?: () => void }> = ({ playlist, onPlay, onDelete, onPinToggle }) => {
  const { theme } = usePlayerStore();
  const { artUrls, primaryArt, bgColor } = useDominantColor(playlist.tracks);

  return (
    <div 
      className="group relative flex flex-col justify-end overflow-hidden rounded-2xl p-6 h-64 cursor-pointer transition-transform hover:-translate-y-1 hover:shadow-xl"
      onClick={onPlay}
    >
      <div 
        className="absolute inset-0 z-0 transition-all duration-300"
        style={{
          backgroundImage: `
            linear-gradient(180deg, transparent 0%, ${bgColor}ea 100%),
            url("${primaryArt}")
          `,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: theme === 'dark' ? 'brightness(0.8)' : 'brightness(1.1)',
        }}
      />
      
      <div className="relative z-10 flex flex-col items-start gap-2">
        <h3 className="text-2xl font-bold text-white tracking-tight drop-shadow-md">{playlist.title}</h3>
        <p className="text-white/80 text-sm font-medium drop-shadow-sm flex items-center gap-2">
          {playlist.tracks.length} tracks
          {playlist.isLlmGenerated && (
            <span className="px-2 py-0.5 rounded-full bg-indigo-500/50 border border-indigo-400/50 text-xs">AI</span>
          )}
        </p>
        {playlist.pinned && (
          <span className="px-2 py-0.5 rounded-full bg-amber-500/50 border border-amber-400/50 text-xs flex items-center gap-1">
            <Pin className="w-3 h-3" /> Pinned
          </span>
        )}
      </div>
      
      <div className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2">
        {onPinToggle && playlist.isLlmGenerated && (
          <button
            onClick={(e) => { e.stopPropagation(); onPinToggle(); }}
            className={`w-10 h-10 rounded-full backdrop-blur-md flex items-center justify-center text-white shadow-lg border transition-colors ${playlist.pinned ? 'bg-amber-500/30 border-amber-400/30 hover:bg-amber-500/50' : 'bg-white/20 border-white/30 hover:bg-white/30'}`}
            title={playlist.pinned ? 'Unpin' : 'Pin'}
          >
            {playlist.pinned ? <Pin className="w-5 h-5" /> : <PinOff className="w-5 h-5" />}
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="w-10 h-10 rounded-full bg-red-500/30 backdrop-blur-md flex items-center justify-center text-white shadow-lg border border-red-400/30 hover:bg-red-500/50 transition-colors"
          title="Delete playlist"
        >
          <Trash2 className="w-5 h-5" />
        </button>
        <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white shadow-lg border border-white/30">
          <Play className="w-5 h-5 ml-0.5" />
        </div>
      </div>
    </div>
  );
};

// --- Generate Playlist Modal ---
const GeneratePlaylistModal: React.FC<{ onClose: () => void; onGenerated: () => void }> = ({ onClose, onGenerated }) => {
  const { getAuthHeader, fetchPlaylistsFromServer } = usePlayerStore();
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const examples = [
    'Late night rainy drive through the city',
    'Energetic workout, heavy beats, no vocals',
    'Sunday morning coffee and jazz vibes',
    'Focus music for deep work, minimal and ambient',
  ];

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setError('');
    setSuccess('');
    try {
      const authHeaders = getAuthHeader();
      const res = await fetch('/api/hub/generate-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Generation failed. Check your LLM configuration in Settings.');
        return;
      }
      const title = data.playlist?.title || 'Your new playlist';
      setSuccess(`✓ "${title}" has been created!`);
      await fetchPlaylistsFromServer();
      setTimeout(() => { onGenerated(); onClose(); }, 1500);
    } catch (e) {
      setError('Network error. Is the server running?');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-lg bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-3xl p-8 shadow-2xl backdrop-blur-2xl space-y-6"
        onClick={e => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors">
          <X size={20} />
        </button>

        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-full bg-indigo-500/20 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-indigo-400" />
            </div>
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Generate a Playlist</h2>
          </div>
          <p className="text-sm text-[var(--color-text-secondary)] ml-12">Describe the vibe — the AI will pick the tracks.</p>
        </div>

        <div className="space-y-3">
          <textarea
            autoFocus
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
            placeholder="e.g. Late night coding session, lo-fi and focused…"
            rows={3}
            className="w-full px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-colors resize-none text-sm"
          />

          <div className="flex flex-wrap gap-2">
            {examples.map(ex => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text-primary)] transition-all"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>}
        {success && <p className="text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-2">{success}</p>}

        <div className="flex gap-3">
          <button
            onClick={handleGenerate}
            disabled={!prompt.trim() || isGenerating}
            className="flex-1 py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold shadow-lg transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
            ) : (
              <><Sparkles className="w-4 h-4" /> Generate Playlist</>
            )}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-center text-[var(--color-text-muted)]">Tip: You can press ⌘ Enter to generate</p>
      </div>
    </div>
  );
};

export const Playlists: React.FC = () => {
  const { playlists, setPlaylist, createPlaylist, deletePlaylist, togglePin } = usePlayerStore();
  const [isCreating, setIsCreating] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    await createPlaylist(newTitle.trim(), '');
    setIsCreating(false);
    setNewTitle('');
  };

  return (
    <div className="page-container space-y-8">
      {isGenerating && (
        <GeneratePlaylistModal
          onClose={() => setIsGenerating(false)}
          onGenerated={() => setIsGenerating(false)}
        />
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text-primary)]">Your Playlists</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsGenerating(true)}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 text-indigo-400 font-medium flex items-center gap-2 hover:from-indigo-500/30 hover:to-purple-500/30 transition-all"
          >
            <Sparkles size={16} />
            Generate a Playlist
          </button>
          <button 
            onClick={() => setIsCreating(true)}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-medium flex items-center gap-2 hover:bg-opacity-90 transition-colors"
          >
            <Plus size={20} />
            New Playlist
          </button>
        </div>
      </div>

      {isCreating && (
        <form onSubmit={handleCreate} className="bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-2xl p-6 flex flex-col gap-4 max-w-md">
          <h3 className="text-xl font-semibold text-[var(--color-text-primary)]">Create Playlist</h3>
          <input 
            type="text" 
            autoFocus
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="Playlist Title" 
            className="w-full px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)]"
          />
          <div className="flex justify-end gap-3 mt-2">
            <button 
              type="button" 
              onClick={() => setIsCreating(false)}
              className="px-4 py-2 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
            >
              Cancel
            </button>
            <button 
              type="submit"
              disabled={!newTitle.trim()}
              className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-medium disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
      )}

      {playlists.length === 0 && !isCreating ? (
        <div className="text-center py-20 text-[var(--color-text-secondary)] border-2 border-dashed border-[var(--glass-border)] rounded-3xl">
          <p className="text-lg">No playlists yet.</p>
          <p className="text-sm mt-2">Create one manually, or hit <strong>Generate a Playlist</strong> to let the AI do the work.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {playlists.map(pl => (
            <PlaylistListItem 
              key={pl.id} 
              playlist={pl} 
              onPlay={() => {
                if(pl.tracks.length > 0) setPlaylist(pl.tracks, 0);
              }}
              onDelete={() => deletePlaylist(pl.id)}
              onPinToggle={() => togglePin(pl.id, !pl.pinned)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
