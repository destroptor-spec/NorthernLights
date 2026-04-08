import React, { useState } from 'react';
import { usePlayerStore } from '../../store/index';

export const PlaybackTab: React.FC = () => {
    const discoveryLevel = usePlayerStore(state => state.discoveryLevel);
    const genreStrictness = usePlayerStore(state => state.genreStrictness);
    const artistAmnesiaLimit = usePlayerStore(state => state.artistAmnesiaLimit);
    const llmPlaylistDiversity = usePlayerStore(state => state.llmPlaylistDiversity);
    const genreBlendWeight = usePlayerStore(state => state.genreBlendWeight);
    const llmTracksPerPlaylist = usePlayerStore(state => state.llmTracksPerPlaylist);
    const llmPlaylistCount = usePlayerStore(state => state.llmPlaylistCount);
    
    const setSettings = usePlayerStore(state => state.setSettings);
    
    const [playbackTab, setPlaybackTab] = useState<'infinity' | 'llm'>('infinity');

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Playback & Discovery</h3>
            </div>

            {/* Sub-tabs */}
            <div className="flex gap-2 mb-6">
                <button
                    onClick={() => setPlaybackTab('infinity')}
                    className={`btn-tab ${playbackTab === 'infinity' ? 'active' : ''}`}
                >
                    Infinity Mode
                </button>
                <button
                    onClick={() => setPlaybackTab('llm')}
                    className={`btn-tab ${playbackTab === 'llm' ? 'active' : ''}`}
                >
                    LLM Playlists
                </button>
            </div>

            {playbackTab === 'infinity' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        Tune how the engine selects the next track organically.
                    </p>
                    
                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Discovery Level (Wander Factor)</span>
                            <span>{discoveryLevel}%</span>
                        </label>
                        <input type="range" min="1" max="100" value={discoveryLevel} onChange={e => setSettings({ discoveryLevel: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Controls how adventurous the engine is when picking the next track. Low values stay close to your current vibe; high values explore further from your listening center of gravity.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Genre Strictness</span>
                            <span>{genreStrictness}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={genreStrictness} onChange={e => setSettings({ genreStrictness: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How much the engine penalizes genre jumps. 0% lets any genre play; 100% keeps you tightly within the current genre.</p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Artist Amnesia (Anti-Repeat)</label>
                        <select 
                            value={artistAmnesiaLimit} 
                            onChange={e => setSettings({ artistAmnesiaLimit: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={0}>Allow Defaults</option>
                            <option value={10}>Standard (10 tracks)</option>
                            <option value={50}>Strict (50 tracks)</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How many recent tracks to exclude from the next pick. Prevents the same artist or song from repeating too soon.</p>
                    </div>
                </div>
            )}

            {playbackTab === 'llm' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        Control how AI-generated Hub playlists are created and diversified.
                    </p>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Playlist Diversity</span>
                            <span>{llmPlaylistDiversity}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmPlaylistDiversity} onChange={e => setSettings({ llmPlaylistDiversity: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Higher values introduce more randomness into track selection, making playlists less predictable. Lower values pick the acoustically closest matches every time.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Genre Blend Weight</span>
                            <span>{genreBlendWeight}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={genreBlendWeight} onChange={e => setSettings({ genreBlendWeight: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How strongly genre similarity influences playlist track selection. Higher values keep playlists genre-coherent; lower values let tracks from different genres mix freely based on acoustic similarity alone.</p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Tracks per Playlist</label>
                        <select 
                            value={llmTracksPerPlaylist} 
                            onChange={e => setSettings({ llmTracksPerPlaylist: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={5}>5 tracks</option>
                            <option value={10}>10 tracks</option>
                            <option value={15}>15 tracks</option>
                            <option value={20}>20 tracks</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">Number of tracks included in each AI-generated playlist.</p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Number of Playlists</label>
                        <select 
                            value={llmPlaylistCount} 
                            onChange={e => setSettings({ llmPlaylistCount: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={2}>2 playlists</option>
                            <option value={3}>3 playlists</option>
                            <option value={5}>5 playlists</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How many distinct playlist concepts the AI generates per cycle. Each playlist gets a unique mood and acoustic profile.</p>
                    </div>
                </div>
            )}
        </div>
    );
};
