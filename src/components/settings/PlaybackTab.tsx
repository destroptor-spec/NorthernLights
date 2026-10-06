import React, { useEffect, useState, useMemo } from 'react';
import { usePlayerStore, type PrebufferPolicy } from '../../store/index';
import { useNetworkInfo } from '../../hooks/useNetworkInfo';
import { Speaker } from 'lucide-react';
import type { StreamingQualityPreset } from '../../utils/streaming';

const formatTelemetryTime = (timestamp: number | null): string => {
    if (!timestamp) return 'No data yet';
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatLoadPath = (path: string): string => {
    switch (path) {
        case 'prepared-hls': return 'Prepared HLS';
        case 'fallback-hls': return 'Fallback HLS';
        case 'cast': return 'Cast';
        case 'direct': return 'Direct file';
        default: return 'None';
    }
};

const formatRecoveryPath = (path: string): string => {
    switch (path) {
        case 'normal-hls-after-prepare-failure': return 'Normal HLS after prepare failure';
        case 'normal-hls-after-promotion-failure': return 'Normal HLS after promotion failure';
        case 'fixed-quality-after-adaptive-failure': return 'Fixed quality after adaptive failure';
        default: return 'None';
    }
};

export const PlaybackTab: React.FC = () => {
    const discoveryLevel = usePlayerStore(state => state.discoveryLevel);
    const genreStrictness = usePlayerStore(state => state.genreStrictness);
    const artistAmnesiaLimit = usePlayerStore(state => state.artistAmnesiaLimit);
    const playedThresholdPercent = usePlayerStore(state => state.playedThresholdPercent);
    const llmPlaylistDiversity = usePlayerStore(state => state.llmPlaylistDiversity);
    const llmVetoMode = usePlayerStore(state => state.llmVetoMode);
    const llmGenreCohesion = usePlayerStore(state => state.llmGenreCohesion);
    const llmDiscoveryBias = usePlayerStore(state => state.llmDiscoveryBias);
    const llmArtistSpread = usePlayerStore(state => state.llmArtistSpread);
    const genrePenaltyCurve = usePlayerStore(state => state.genrePenaltyCurve);
    const llmRecoveryStrength = usePlayerStore(state => state.llmRecoveryStrength);
    const llmAdjacentReach = usePlayerStore(state => state.llmAdjacentReach);
    const llmTracksPerPlaylist = usePlayerStore(state => state.llmTracksPerPlaylist);
    const llmPlaylistCount = usePlayerStore(state => state.llmPlaylistCount);
    
    const setSettings = usePlayerStore(state => state.setSettings);
    const streamingQuality = usePlayerStore(state => state.streamingQuality);
    const prebufferPolicy = usePlayerStore(state => state.prebufferPolicy);
    const resumeStalenessDays = usePlayerStore(state => state.resumeStalenessDays);
    const playbackDebugLogging = usePlayerStore(state => state.playbackDebugLogging);
    const loudnessNormEnabled = usePlayerStore(state => state.loudnessNormEnabled);
    const loudnessTargetLufs = usePlayerStore(state => state.loudnessTargetLufs);
    const loudnessPreampDb = usePlayerStore(state => state.loudnessPreampDb);
    const loudnessMode = usePlayerStore(state => state.loudnessMode);
    const playbackTelemetry = usePlayerStore(state => state.playbackTelemetry);
    const sleepTimerEndsAt = usePlayerStore(state => state.sleepTimerEndsAt);
    const startSleepTimer = usePlayerStore(state => state.startSleepTimer);
    const cancelSleepTimer = usePlayerStore(state => state.cancelSleepTimer);
    const castConnected = usePlayerStore(state => state.castConnected);
    const audioOutputSupported = usePlayerStore(state => state.audioOutputSupported);
    const audioOutputPickerSupported = usePlayerStore(state => state.audioOutputPickerSupported);
    const audioOutputDevices = usePlayerStore(state => state.audioOutputDevices);
    const audioOutputDeviceId = usePlayerStore(state => state.audioOutputDeviceId);
    const audioOutputActive = usePlayerStore(state => state.audioOutputActive);
    const audioOutputDeviceLabel = usePlayerStore(state => state.audioOutputDeviceLabel);
    const audioOutputSelecting = usePlayerStore(state => state.audioOutputSelecting);
    const audioOutputError = usePlayerStore(state => state.audioOutputError);
    const audioOutputPermission = usePlayerStore(state => state.audioOutputPermission);
    const audioOutputRequestingAccess = usePlayerStore(state => state.audioOutputRequestingAccess);
    const setAudioOutputDevice = usePlayerStore(state => state.setAudioOutputDevice);
    const selectAudioOutput = usePlayerStore(state => state.selectAudioOutput);
    const ensureAudioOutputAccess = usePlayerStore(state => state.ensureAudioOutputAccess);
    const networkInfo = useNetworkInfo();
    
    const [playbackTab, setPlaybackTab] = useState<'streaming' | 'output' | 'infinity' | 'llm'>('streaming');
    const [showLlmAdvanced, setShowLlmAdvanced] = useState(false);

    // Opening the Output tab triggers the one-time device-access prompt (if
    // needed) and refreshes the device list.
    useEffect(() => {
        if (playbackTab === 'output') {
            void ensureAudioOutputAccess();
        }
    }, [playbackTab, ensureAudioOutputAccess]);

    // Tick once a second while a sleep timer is active to show the countdown.
    const [sleepNow, setSleepNow] = useState(() => Date.now());
    useEffect(() => {
        if (!sleepTimerEndsAt) return;
        setSleepNow(Date.now());
        const id = setInterval(() => setSleepNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [sleepTimerEndsAt]);
    const sleepRemainingMs = sleepTimerEndsAt ? Math.max(0, sleepTimerEndsAt - sleepNow) : 0;
    const sleepRemainingLabel = `${Math.floor(sleepRemainingMs / 60000)}:${String(Math.floor((sleepRemainingMs % 60000) / 1000)).padStart(2, '0')}`;
    const SLEEP_PRESETS = [15, 30, 45, 60];

    // Live penalty preview computed from current slider values
    const penaltyPreview = useMemo(() => {
        const curve = 0.5 + (genrePenaltyCurve / 100) * 1.5;
        const weight = llmGenreCohesion / 100;
        const format = (hop: number) => Math.pow(1 + hop, weight * curve).toFixed(2);
        return {
            deep: format(0.05),
            cousin: format(0.20),
            shareRoot: format(0.50),
            alien: format(2.0),
        };
    }, [genrePenaltyCurve, llmGenreCohesion]);

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Playback & Discovery</h3>
            </div>

            {/* Sub-tabs */}
            <div className="flex flex-wrap gap-2 mb-6">
                <button
                    onClick={() => setPlaybackTab('streaming')}
                    className={`btn-tab ${playbackTab === 'streaming' ? 'active' : ''}`}
                >
                    Streaming
                </button>
                <button
                    onClick={() => setPlaybackTab('output')}
                    className={`btn-tab ${playbackTab === 'output' ? 'active' : ''}`}
                >
                    Output
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
                            onChange={e => setSettings({ streamingQuality: e.target.value as StreamingQualityPreset })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="auto">Auto — Adaptive (64–320 kbps)</option>
                            <option value="64k">Low (64 kbps) — Saves data</option>
                            <option value="128k">Normal (128 kbps) — Good balance</option>
                            <option value="160k">High (160 kbps)</option>
                            <option value="320k">Very High (320 kbps) — Near-lossless</option>
                            <option value="source">Source — Original file, no conversion</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                            {streamingQuality === 'source'
                                ? 'Bit-perfect passthrough when the browser can play the file natively (FLAC, ALAC, WAV, MP3, AAC, Ogg, Opus) — bypasses HLS entirely and streams the raw bytes with Range seek. Falls back to high-bitrate AAC HLS for codecs the browser cannot decode (e.g. WMA). Chromecast still streams 128 kbps AAC HLS regardless of this setting.'
                                : streamingQuality === 'auto'
                                ? 'Adapts AAC quality between 64 and 320 kbps using measured bandwidth and buffer health. Lossy files do not exceed their known source bitrate, Data Saver caps Auto at 64 kbps, and Chromecast remains fixed at 128 kbps AAC.'
                                : `Audio will be transcoded to AAC at ${streamingQuality}bps. Both browser playback and Chromecast now honor this bitrate when a track starts. Higher bitrates sound better but use more bandwidth and storage.`
                            }
                        </p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Prebuffer Policy</label>
                        <select
                            value={prebufferPolicy}
                            onChange={e => setSettings({ prebufferPolicy: e.target.value as PrebufferPolicy })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="off">Off — No background preparation</option>
                            <option value="conservative">Conservative — Prepare next track</option>
                            <option value="aggressive">Aggressive — Prepare next track early</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                            {prebufferPolicy === 'off'
                                ? 'Disables HLS prewarm and local prepared audio. Use this if a browser or device behaves badly with background preparation.'
                                : prebufferPolicy === 'aggressive'
                                ? 'Keeps the next track ready for local promotion and also prewarms the following HLS session. Uses more server CPU and temporary storage.'
                                : 'Prepares only the immediate next track on the server and in the local audio pipeline.'
                            }
                        </p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Resume where you left off</label>
                        <select
                            value={resumeStalenessDays}
                            onChange={e => setSettings({ resumeStalenessDays: Number(e.target.value) })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value={0}>Always — keep my place indefinitely</option>
                            <option value={7}>Up to 7 days</option>
                            <option value={14}>Up to 14 days</option>
                            <option value={30}>Up to 30 days</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                            {resumeStalenessDays === 0
                                ? 'The Hub always offers to pick up your last queue, no matter how long ago you listened.'
                                : `The Hub stops offering to resume once it's been more than ${resumeStalenessDays} days since you last played something.`
                            }
                        </p>
                    </div>

                    <div className="mb-6 p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Count as played after</span>
                            <span>{playedThresholdPercent}%</span>
                        </label>
                        <input
                            type="range"
                            min={25}
                            max={95}
                            step={5}
                            value={playedThresholdPercent}
                            onChange={e => setSettings({ playedThresholdPercent: Number(e.target.value) })}
                            className="w-full accent-[var(--color-primary)]"
                            aria-label="Percent of a track to listen to before it is marked as played"
                        />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                            How much of a track you must listen to before it counts as played — this drives both your play counts/stats on the server and what gets scrobbled to Last.fm &amp; ListenBrainz. A 4-minute cap and a 30-second minimum track length always apply, matching standard scrobbling rules.
                        </p>
                    </div>

                    <div className="mb-6 p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                        <div className="flex items-center justify-between">
                            <div className="pr-4">
                                <p className="text-sm font-medium text-[var(--color-text-primary)]">Loudness Normalization</p>
                                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                                    Even out volume between tracks by measuring each track's loudness (EBU R128) and adjusting gain toward a target. Peaks are limited to avoid clipping.
                                </p>
                            </div>
                            <button
                                onClick={() => setSettings({ loudnessNormEnabled: !loudnessNormEnabled })}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${loudnessNormEnabled ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                                aria-pressed={loudnessNormEnabled}
                                aria-label="Toggle loudness normalization"
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${loudnessNormEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>

                        <div className={`mt-4 space-y-4 ${loudnessNormEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Normalize by</label>
                                <select
                                    value={loudnessMode}
                                    disabled={!loudnessNormEnabled}
                                    onChange={e => setSettings({ loudnessMode: e.target.value as 'track' | 'album' })}
                                    className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                                >
                                    <option value="track">Track — every track at the same loudness</option>
                                    <option value="album">Album — consistent between albums, dynamics kept within one</option>
                                </select>
                            </div>

                            <div>
                                <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                    <span>Target loudness</span>
                                    <span>{loudnessTargetLufs} LUFS</span>
                                </label>
                                <input
                                    type="range"
                                    min={-23}
                                    max={-9}
                                    step={1}
                                    value={loudnessTargetLufs}
                                    disabled={!loudnessNormEnabled}
                                    onChange={e => setSettings({ loudnessTargetLufs: Number(e.target.value) })}
                                    className="w-full accent-[var(--color-primary)]"
                                    aria-label="Target loudness in LUFS"
                                />
                                <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                                    −18 LUFS is the ReplayGain reference (recommended). −14 matches streaming services (louder, less headroom).
                                </p>
                            </div>

                            <div>
                                <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                    <span>Pre-amp</span>
                                    <span>{loudnessPreampDb > 0 ? '+' : ''}{loudnessPreampDb} dB</span>
                                </label>
                                <input
                                    type="range"
                                    min={-12}
                                    max={12}
                                    step={1}
                                    value={loudnessPreampDb}
                                    disabled={!loudnessNormEnabled}
                                    onChange={e => setSettings({ loudnessPreampDb: Number(e.target.value) })}
                                    className="w-full accent-[var(--color-primary)]"
                                    aria-label="Loudness pre-amp in dB"
                                />
                                <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                                    A constant offset applied on top of the target. Casting is not affected. First play of a new track may be unnormalized until it's measured.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="mb-6 p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                        <div className="flex items-center justify-between mb-3">
                            <div>
                                <p className="text-sm font-medium text-[var(--color-text-primary)]">Sleep Timer</p>
                                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                                    {sleepTimerEndsAt
                                        ? `Fading out and stopping in ${sleepRemainingLabel}.`
                                        : 'Gently fade out and pause after a set time.'}
                                </p>
                            </div>
                            {sleepTimerEndsAt && (
                                <button onClick={() => cancelSleepTimer()} className="btn btn-ghost btn-sm flex-shrink-0 ml-4">
                                    Cancel
                                </button>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {SLEEP_PRESETS.map((min) => {
                                const active = !!sleepTimerEndsAt && Math.round(sleepRemainingMs / 60000) <= min && Math.round(sleepRemainingMs / 60000) > min - 15;
                                return (
                                    <button
                                        key={min}
                                        onClick={() => startSleepTimer(min)}
                                        className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                                        aria-pressed={active}
                                    >
                                        {min} min
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="mb-6 flex items-center justify-between p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                        <div>
                            <p className="text-sm font-medium text-[var(--color-text-primary)]">Playback & Cast Debug Logging</p>
                            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                                Show HLS prewarm telemetry in the browser console and enable verbose Cast receiver diagnostics in the Cast log.
                            </p>
                        </div>
                        <button
                            onClick={() => setSettings({ playbackDebugLogging: !playbackDebugLogging })}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4 ${playbackDebugLogging ? 'bg-[var(--color-primary)]' : 'bg-gray-200 dark:bg-[var(--color-bg-tertiary)]'}`}
                            aria-pressed={playbackDebugLogging}
                            aria-label="Toggle playback and Cast debug logging"
                        >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${playbackDebugLogging ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    {playbackDebugLogging && (
                        <div className="mb-6 p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)]">
                            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Playback Telemetry</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Last path</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{formatLoadPath(playbackTelemetry.loadPath)}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Transition</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.lastTransitionLatencyMs !== null ? `${playbackTelemetry.lastTransitionLatencyMs}ms` : 'N/A'}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Prepared</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.prepareStatus}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Updated</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{formatTelemetryTime(playbackTelemetry.lastUpdatedAt)}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Prebuffer</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.prebufferPolicy}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Auto bitrate</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">
                                        {playbackTelemetry.adaptiveActiveBitrateKbps !== null ? `${playbackTelemetry.adaptiveActiveBitrateKbps} kbps` : 'N/A'}
                                    </span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Bandwidth</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">
                                        {playbackTelemetry.adaptiveBandwidthEstimateKbps !== null ? `${playbackTelemetry.adaptiveBandwidthEstimateKbps} kbps` : 'N/A'}
                                    </span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Renditions</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.adaptiveLevelCount || 'N/A'}</span>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <span className="text-[var(--color-text-muted)]">Auto switches</span>
                                    <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.adaptiveSwitchCount}</span>
                                </div>
                            </div>
                            {playbackTelemetry.adaptiveNativePlayback && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Native HLS is selecting Auto quality; the active rendition is not observable in this browser.
                                </p>
                            )}
                            {playbackTelemetry.adaptiveFallbackState !== 'none' && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Auto fallback: <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.adaptiveFallbackState}</span>
                                </p>
                            )}
                            {playbackTelemetry.prebufferSkippedReason && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Prebuffer skipped: <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.prebufferSkippedReason}</span>
                                </p>
                            )}
                            {playbackTelemetry.lastFallbackReason && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Fallback reason: <span className="font-mono text-[var(--color-text-primary)]">{playbackTelemetry.lastFallbackReason}</span>
                                </p>
                            )}
                            {playbackTelemetry.recoveredFromPrepareFailure && (
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Recovery path: <span className="font-mono text-[var(--color-text-primary)]">{formatRecoveryPath(playbackTelemetry.recoveryPath)}</span>
                                </p>
                            )}
                            {playbackTelemetry.recoveryError && (
                                <p className="text-xs text-amber-500 mt-2">
                                    Recovery note: <span className="font-mono">{playbackTelemetry.recoveryError}</span>
                                </p>
                            )}
                            {playbackTelemetry.prepareError && (
                                <p className="text-xs text-amber-500 mt-2">
                                    Prepare warning: <span className="font-mono">{playbackTelemetry.prepareError}</span>
                                </p>
                            )}
                            <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                Cast diagnostics: <span className="font-mono text-[var(--color-text-primary)]">logs/cast-receiver.log</span>
                            </p>
                        </div>
                    )}

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
                                Network info unavailable (common on iOS). Auto starts with a 500 kbps estimate and adapts from playback measurements.
                            </p>
                        )}
                    </div>
                </div>
            )}

            {playbackTab === 'output' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        Choose which speaker browser playback uses. Chromecast has its own route and takes priority while connected.
                    </p>

                    <div className="mb-6">
                        <label className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <Speaker
                                size={16}
                                className="flex-shrink-0"
                                style={{ color: audioOutputActive ? 'var(--color-primary)' : 'var(--color-text-muted)' }}
                            />
                            Speaker
                        </label>
                        <select
                            value={audioOutputActive ? audioOutputDeviceId : ''}
                            onChange={e => { void setAudioOutputDevice(e.target.value); }}
                            disabled={castConnected || audioOutputSelecting || !audioOutputSupported || audioOutputPermission === 'denied'}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none disabled:opacity-60"
                        >
                            <option value="">{audioOutputDevices.find(d => d.isDefault)?.label || 'System default'}</option>
                            {audioOutputDevices.filter(d => !d.isDefault).map(device => (
                                <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                            ))}
                        </select>

                        {audioOutputSupported && !castConnected && audioOutputPermission === 'denied' ? (
                            <div className="mt-3 p-4 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)]">
                                <p className="text-sm text-[var(--color-text-primary)]">
                                    Aurora needs one-time microphone permission to name your speakers and route audio to them. Audio is never recorded.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => { void ensureAudioOutputAccess(); }}
                                    className="btn btn-primary btn-sm mt-3"
                                >
                                    Allow access
                                </button>
                                <p className="text-xs text-[var(--color-text-muted)] mt-3">
                                    No prompt appearing? Enable the microphone permission for this site in your browser settings, then reopen this tab.
                                </p>
                            </div>
                        ) : audioOutputSupported && audioOutputPermission === 'unavailable' ? (
                            <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                                No microphone was found, so this browser won't reveal speaker names or allow routing. Audio follows the system default output.
                            </p>
                        ) : (
                            <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                                {castConnected
                                    ? 'Chromecast is active — disconnect to choose a local speaker.'
                                    : !audioOutputSupported
                                    ? "This browser can't route playback to a specific device. Audio follows the operating system's default output."
                                    : audioOutputRequestingAccess
                                    ? 'Requesting device access…'
                                    : audioOutputSelecting
                                    ? 'Switching…'
                                    : audioOutputActive
                                    ? `Playing on ${audioOutputDeviceLabel || 'selected output'}.`
                                    : audioOutputPickerSupported && audioOutputDevices.length <= 1
                                    ? 'This browser reveals speakers through its own picker — use "Choose speaker" below.'
                                    : 'Using the system default output.'}
                            </p>
                        )}

                        {audioOutputSupported && audioOutputPickerSupported && !castConnected && (
                            <button
                                type="button"
                                onClick={() => { void selectAudioOutput(); }}
                                disabled={audioOutputSelecting}
                                className="btn btn-ghost btn-sm mt-3 flex items-center gap-1.5 disabled:opacity-50"
                            >
                                <Speaker size={14} />
                                {audioOutputSelecting ? 'Choosing…' : 'Choose speaker…'}
                            </button>
                        )}

                        {audioOutputError && (
                            <p className="text-xs text-amber-500 mt-2">{audioOutputError}</p>
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
                            <span>Repeat Protection</span>
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
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 1:</strong> Blocks recently played tracks from being picked again, even when Infinity has to widen its search. Tracks in your queue are always skipped. "Off" means earlier tracks can come back; "Strict" remembers the last 50 tracks you heard.</p>
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
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 3:</strong> Re-ranks the closest-sounding tracks by genre distance from the end of your queue. 0% ignores genre; 100% favors the same genre family. Has no effect when that track has no genre tag.</p>
                    </div>
                </div>
            )}

            {playbackTab === 'llm' && (
                <div>
                    <p className="text-sm text-[var(--color-text-muted)] mb-6">
                        These settings control how the library-relative playlist engine compiles each AI concept, recovers when the local library is thin, and balances cohesion against discovery.
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
                            <span>Genre Cohesion</span>
                            <span>{llmGenreCohesion}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmGenreCohesion} onChange={e => setSettings({ llmGenreCohesion: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 3:</strong> How tightly playlists stay near the compiled genre path. Low values lean on sound similarity; high values stay closer to the concept's genre family.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Playlist Diversity</span>
                            <span>{llmPlaylistDiversity}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmPlaylistDiversity} onChange={e => setSettings({ llmPlaylistDiversity: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 4:</strong> How much controlled randomness the final selector allows. Low values stay close to best fit; high values let the optimizer take more interesting side roads.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Discovery Bias</span>
                            <span>{llmDiscoveryBias}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmDiscoveryBias} onChange={e => setSettings({ llmDiscoveryBias: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 5:</strong> How much the engine favors discovery and bridge pools over safest-fit picks. Higher values surface more underplayed or less obvious tracks without fully abandoning cohesion.</p>
                    </div>

                    <div className="mb-6">
                        <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                            <span>Artist Spread</span>
                            <span>{llmArtistSpread}%</span>
                        </label>
                        <input type="range" min="0" max="100" value={llmArtistSpread} onChange={e => setSettings({ llmArtistSpread: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 6:</strong> How strongly the selector avoids repeating the same artist. Higher values push harder for broad artist coverage within each playlist.</p>
                    </div>

                    <div className="mb-6">
                        <label className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Banned Genre Handling</label>
                        <select
                            value={llmVetoMode}
                            onChange={e => setSettings({ llmVetoMode: e.target.value as 'hard' | 'adaptive' })}
                            className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                        >
                            <option value="hard">Hard Veto — never include banned genres</option>
                            <option value="adaptive">Adaptive Penalty — relax only if the local pool fails</option>
                        </select>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1.5"><strong>Step 7:</strong> Controls how LLM banned genres are enforced. Hard veto keeps excluded styles out entirely; adaptive penalty can recover sparse libraries by treating banned genres as heavily penalized fallback candidates.</p>
                    </div>

                    <div className="mb-6 rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <p className="text-sm font-medium text-[var(--color-text-primary)]">Advanced Tuning</p>
                                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                                    Recovery aggressiveness, adjacent-genre expansion, and raw genre penalty behavior.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowLlmAdvanced((value) => !value)}
                                className="btn btn-ghost btn-sm"
                            >
                                {showLlmAdvanced ? 'Hide' : 'Show'}
                            </button>
                        </div>

                        {showLlmAdvanced && (
                            <div className="mt-4">
                                <div className="mb-6">
                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                        <span>Recovery Strength</span>
                                        <span>{llmRecoveryStrength}%</span>
                                    </label>
                                    <input type="range" min="0" max="100" value={llmRecoveryStrength} onChange={e => setSettings({ llmRecoveryStrength: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How aggressively the engine widens non-genre pools when the concept is weak in your local library.</p>
                                </div>

                                <div className="mb-6">
                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                        <span>Adjacent Reach</span>
                                        <span>{llmAdjacentReach}%</span>
                                    </label>
                                    <input type="range" min="0" max="100" value={llmAdjacentReach} onChange={e => setSettings({ llmAdjacentReach: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How far the concept compiler may expand into adjacent genres when the exact path is thin.</p>
                                </div>

                                <div className="mb-0">
                                    <label className="flex justify-between text-sm font-medium text-[var(--color-text-primary)] mb-2">
                                        <span>Genre Penalty Curve</span>
                                        <span>{genrePenaltyCurve}%</span>
                                    </label>
                                    <input type="range" min="0" max="100" value={genrePenaltyCurve} onChange={e => setSettings({ genrePenaltyCurve: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" />
                                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">How harshly distant genres are penalized once genre anchoring is active.</p>

                                    <div className="mt-3 p-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--glass-border)]">
                                        <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Penalty Preview</p>
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
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
