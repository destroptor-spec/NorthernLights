import React, { useState, useMemo } from 'react';
import { usePlayerStore } from '../../store/index';
import { useNetworkInfo } from '../../hooks/useNetworkInfo';

export const PlaybackTab: React.FC = () => {
    const discoveryLevel = usePlayerStore(state => state.discoveryLevel);
    const genreStrictness = usePlayerStore(state => state.genreStrictness);
    const artistAmnesiaLimit = usePlayerStore(state => state.artistAmnesiaLimit);
    const llmPlaylistDiversity = usePlayerStore(state => state.llmPlaylistDiversity);
    const genreBlendWeight = usePlayerStore(state => state.genreBlendWeight);
    const genrePenaltyCurve = usePlayerStore(state => state.genrePenaltyCurve);
    const llmTracksPerPlaylist = usePlayerStore(state => state.llmTracksPerPlaylist);
    const llmPlaylistCount = usePlayerStore(state => state.llmPlaylistCount);
    
    const setSettings = usePlayerStore(state => state.setSettings);
    const streamingQuality = usePlayerStore(state => state.streamingQuality);
    const networkInfo = useNetworkInfo();
    
    const [playbackTab, setPlaybackTab] = useState<'streaming' | 'infinity' | 'llm'>('streaming');

    // Live penalty preview computed from current slider values
    const penaltyPreview = useMemo(() => {
        const curve = 0.5 + (genrePenaltyCurve / 100) * 1.5;
        const weight = genreBlendWeight / 100;
        const format = (hop: number) => Math.pow(1 + hop, weight * curve).toFixed(2);
        return {
            deep: format(0.05),
            cousin: format(0.20),
            shareRoot: format(0.50),
            alien: format(2.0),
        };
    }, [genrePenaltyCurve, genreBlendWeight]);

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Playback & Discovery</h3>
            </div>

            {/* Sub-tabs */}
            <div className="flex gap-2 mb-6">
                <button
                    onClick={() => setPlaybackTab('streaming')}
                    className={`btn-tab ${playbackTab === 'streaming' ? 'active' : ''}`}
                >
                    Streaming
                </button>
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

            {playbackTab === 'streaming' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        Audio is streamed using HLS (HTTP Live Streaming) for reliable seeking and offline caching. Choose a quality preset that suits your network and storage.
                    </p>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Streaming Quality</label>
                        <select
                            value={streamingQuality}
                            onChange={e => setSettings({ streamingQuality: e.target.value as any })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="auto">Auto (Normal — 128 kbps)</option>
                            <option value="64k">Low (64 kbps) — Saves data</option>
                            <option value="128k">Normal (128 kbps) — Good balance</option>
                            <option value="160k">High (160 kbps)</option>
                            <option value="320k">Very High (320 kbps) — Near-lossless</option>
                            <option value="source">Source — Original file, no conversion</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                            {streamingQuality === 'source' 
                                ? 'Streams the original file exactly as it is stored on the server without conversion. Uses zero CPU on the server but may use more bandwidth.'
                                : streamingQuality === 'auto'
                                ? 'Automatically uses Normal quality (128 kbps AAC). This provides a good balance between quality and bandwidth.'
                                : `Audio will be transcoded to AAC at ${streamingQuality}bps. Higher bitrates sound better but use more bandwidth and storage.`
                            }
                        </p>
                    </div>

                    {/* Network info indicator */}
                    <div className="p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                        <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Network Status</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                            <div className="flex justify-between">
                                <span className="text-[var(--color-text-muted)]">Connection</span>
                                <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.type === 'unknown' ? 'Unknown' : networkInfo.type}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[var(--color-text-muted)]">Effective</span>
                                <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.effectiveType === 'unknown' ? 'N/A' : networkInfo.effectiveType}</span>
                            </div>
                            {networkInfo.downlink !== null && (
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-text-muted)]">Downlink</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.downlink} Mbps</span>
                                </div>
                            )}
                            <div className="flex justify-between">
                                <span className="text-[var(--color-text-muted)]">Data Saver</span>
                                <span className="font-mono text-[var(--color-text-primary)]">{networkInfo.saveData ? 'On' : 'Off'}</span>
                            </div>
                        </div>
                        {networkInfo.type === 'unknown' && (
                            <p className="text-xs text-[var(--color-text-muted)] mt-2 italic">
                                Network info unavailable (common on iOS). Quality is fixed to your selected preset.
                            </p>
                        )}
                    </div>
                </div>
            )}

            {playbackTab === 'infinity' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        These settings control how Infinity Mode picks the next track. They're applied in order: first recent tracks are blocked, then candidates are found by sound similarity, and finally genre distance is penalized.
                    </p>
                    
                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Artist Amnesia (Anti-Repeat)</span>
                            <span>{artistAmnesiaLimit === 0 ? 'Off' : `${artistAmnesiaLimit} tracks`}</span>
                        </label>
                        <select 
                            value={artistAmnesiaLimit} 
                            onChange={e => setSettings({ artistAmnesiaLimit: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={0}>Off (no restriction)</option>
                            <option value={10}>Standard (last 10)</option>
                            <option value={50}>Strict (last 50)</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 1:</strong> Blocks recently played tracks from being picked again. "Off" means anything can repeat; "Strict" remembers the last 50 tracks you heard.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Discovery Level</span>
                            <span>{discoveryLevel}%</span>
                        </label>
                        <input type="range" min="1" max="100" value={discoveryLevel} onChange={e => setSettings({ discoveryLevel: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 2:</strong> How many similar-sounding tracks to consider. Low values pick from a small pool of near-identical matches; high values cast a wider net for more variety.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Genre Strictness</span>
                            <span>{genreStrictness}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={genreStrictness} onChange={e => setSettings({ genreStrictness: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 3:</strong> Penalizes tracks from different genres. 0% ignores genre entirely; 100% strongly prefers staying in the same genre family.</p>
                    </div>
                </div>
            )}

            {playbackTab === 'llm' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        These settings control how the AI generates Hub playlists. The engine first decides how many playlists to make, then finds tracks by sound similarity, penalizes genre jumps, and finally adds variety to the selection.
                    </p>

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
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 1:</strong> How many separate playlists the AI creates. Each has its own theme (e.g., "Evening Chill", "Morning Energy").</p>
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
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 2:</strong> The length of each generated playlist. More tracks = longer listening session per playlist.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Genre Blend Weight</span>
                            <span>{genreBlendWeight}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={genreBlendWeight} onChange={e => setSettings({ genreBlendWeight: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 3:</strong> How much genre matters when ranking tracks. Low values pick tracks that sound similar regardless of genre; high values keep playlists genre-coherent.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Genre Penalty Curve</span>
                            <span>{genrePenaltyCurve}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={genrePenaltyCurve} onChange={e => setSettings({ genrePenaltyCurve: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 4:</strong> How harshly distant genres are penalized. Low values are forgiving (cousin genres get a small penalty); high values are strict (even cousin genres get heavily penalized).</p>

                        {/* Live penalty preview */}
                        <div className="mt-3 p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Penalty Preview (how much harder it is to pick)</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-text-muted)]">Same subgenre</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.deep}&times;</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-text-muted)]">Cousin genre</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.cousin}&times;</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-text-muted)]">Same root genre</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.shareRoot}&times;</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-text-muted)]">Completely different</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{penaltyPreview.alien}&times;</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Playlist Diversity</span>
                            <span>{llmPlaylistDiversity}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmPlaylistDiversity} onChange={e => setSettings({ llmPlaylistDiversity: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 5:</strong> Adds randomness to the final pick. Low values always choose the best-matching track; high values sometimes pick lower-ranked tracks for surprise and variety.</p>
                    </div>
                </div>
            )}
        </div>
    );
};
