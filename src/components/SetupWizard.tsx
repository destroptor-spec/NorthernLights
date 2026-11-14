import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle,
    BrainCircuit,
    Check,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    Download,
    FolderPlus,
    Loader2,
    Music2,
    ShieldCheck,
} from 'lucide-react';
import { type SetupStep, usePlayerStore } from '../store';
import { ServerEventStream } from '../utils/serverEvents';

interface SetupWizardProps {
    onComplete: () => void;
}

interface ModelFileStatus {
    filename: string;
    size: number;
    cached: boolean;
    downloading: boolean;
}

interface ModelStatus {
    name: string;
    files: ModelFileStatus[];
}

interface ModelProgress {
    bytes: number;
    total: number;
    status: string;
}

/**
 * The analysis models as the wizard shows them: the one network, and the
 * small classifiers that read styles, sound and moods from it (ten files).
 */
const NETWORK_FILE = /^discogs-effnet/i;
const MODEL_GROUPS = [
    { id: 'network', name: 'Discogs-EffNet', detail: 'The network that listens to every track', match: (filename: string) => NETWORK_FILE.test(filename) },
    { id: 'classifiers', name: 'Classifiers', detail: 'Styles, danceability, acoustic, vocals and moods', match: (filename: string) => !NETWORK_FILE.test(filename) },
] as const;

const SETUP_STEPS: ReadonlyArray<{ id: SetupStep; label: string }> = [
    { id: 'account', label: 'Account' },
    { id: 'analysis', label: 'Analysis' },
    { id: 'library', label: 'Library' },
];

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Waiting';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function responseError(response: Response, fallback: string): Promise<string> {
    try {
        const data = await response.json();
        if (typeof data?.error === 'string' && data.error.trim()) return data.error;
    } catch {
        // The operation-specific fallback is more useful than a JSON parse error.
    }
    return fallback;
}

export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
    const setupStep = usePlayerStore(state => state.setupStep);
    const createSetupAdmin = usePlayerStore(state => state.createSetupAdmin);
    const updateSetupProgress = usePlayerStore(state => state.updateSetupProgress);
    const finalizeSetup = usePlayerStore(state => state.finalizeSetup);
    const addLibraryFolder = usePlayerStore(state => state.addLibraryFolder);
    const rescanLibrary = usePlayerStore(state => state.rescanLibrary);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);

    const step = setupStep || 'account';
    const activeStepIndex = SETUP_STEPS.findIndex(item => item.id === step);
    const headingRef = useRef<HTMLHeadingElement>(null);
    const previousStepRef = useRef(step);

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [libraryPath, setLibraryPath] = useState('');
    const [operationError, setOperationError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const [modelStatus, setModelStatus] = useState<ModelStatus[]>([]);
    const [modelDownloading, setModelDownloading] = useState(false);
    const [modelLoading, setModelLoading] = useState(false);
    const [modelProgress, setModelProgress] = useState<Map<string, ModelProgress>>(new Map());

    useEffect(() => {
        if (previousStepRef.current !== step) {
            previousStepRef.current = step;
            headingRef.current?.focus();
        }
    }, [step]);

    const fetchModelStatus = useCallback(async () => {
        setModelLoading(true);
        try {
            const response = await fetch('/api/settings/models/status', { headers: getAuthHeader() });
            if (!response.ok) throw new Error(await responseError(response, 'Could not check analysis models.'));
            const data = await response.json();
            setModelStatus(Array.isArray(data.models) ? data.models : []);
            setModelDownloading(data.isDownloading === true);
        } catch (error) {
            setOperationError(error instanceof Error ? error.message : 'Could not check analysis models.');
        } finally {
            setModelLoading(false);
        }
    }, [getAuthHeader]);

    useEffect(() => {
        if (step === 'analysis') void fetchModelStatus();
    }, [fetchModelStatus, step]);

    useEffect(() => {
        if (step !== 'analysis' || !modelDownloading) return;
        const state = usePlayerStore.getState();
        const token = state.sseAccessToken;
        if (!token) return;

        const events = new ServerEventStream(`/api/settings/models/progress?token=${encodeURIComponent(token)}`);
        events.onmessage = event => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'status') {
                    if (Array.isArray(data.models)) setModelStatus(data.models);
                    return;
                }

                const key = `${data.model}/${data.file}`;
                setModelProgress(previous => {
                    const next = new Map(previous);
                    next.set(key, {
                        bytes: Number(data.bytesDownloaded) || 0,
                        total: Number(data.totalBytes) || 0,
                        status: String(data.status || ''),
                    });
                    return next;
                });

                if (data.status === 'error') {
                    setOperationError(data.error || `Could not download ${data.model || 'an analysis model'}.`);
                }
                if (data.status === 'done' || data.status === 'error') {
                    window.setTimeout(() => void fetchModelStatus(), 300);
                }
            } catch {
                setOperationError('Aurora received an invalid model progress update.');
            }
        };
        events.onerror = () => {
            events.close();
            void fetchModelStatus();
        };
        return () => events.close();
    }, [fetchModelStatus, modelDownloading, step]);

    const flattenedModels = useMemo(
        () => modelStatus.flatMap(model => model.files.map(file => ({ ...file, modelName: model.name }))),
        [modelStatus],
    );
    const allModelsReady = flattenedModels.length > 0 && flattenedModels.every(model => model.cached);
    const modelGroups = useMemo(() => MODEL_GROUPS.map(group => {
        const files = flattenedModels.filter(file => group.match(file.filename));
        const progress = files.map(file => modelProgress.get(`${file.modelName}/${file.filename}`));
        const downloading = progress.some(p => p?.status === 'downloading');
        const ready = files.length > 0 && files.every(file => file.cached);
        const readyFiles = files.filter((file, i) => file.cached || progress[i]?.status === 'done').length;
        const bytes = progress.reduce((sum, p) => sum + (p?.bytes || 0), 0);
        const total = progress.reduce((sum, p) => sum + (p?.total || 0), 0);
        const size = files.reduce((sum, file) => sum + (file.cached ? file.size : 0), 0);
        return { ...group, files, downloading, ready, readyFiles, bytes, total, size };
    }).filter(group => group.files.length > 0), [flattenedModels, modelProgress]);
    const accountValid = username.trim().length >= 3 && password.length >= 12;
    const libraryValid = libraryPath.trim().length > 0;

    const handleCreateAdmin = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!accountValid || isSubmitting) return;
        setOperationError('');
        setIsSubmitting(true);
        const result = await createSetupAdmin(username, password);
        if (!result.success) setOperationError(result.error);
        setIsSubmitting(false);
    };

    const handleDownloadModels = async () => {
        if (modelDownloading || isSubmitting) return;
        setOperationError('');
        setIsSubmitting(true);
        setModelProgress(new Map());
        try {
            // Only what is missing: models already here stay as they are.
            const response = await fetch('/api/settings/models/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ missingOnly: true }),
            });
            if (!response.ok) throw new Error(await responseError(response, 'Could not start the model download.'));
            setModelDownloading(true);
        } catch (error) {
            setOperationError(error instanceof Error ? error.message : 'Could not start the model download.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const goToStep = async (nextStep: Exclude<SetupStep, 'account'>) => {
        if (isSubmitting) return;
        setOperationError('');
        setIsSubmitting(true);
        const result = await updateSetupProgress(nextStep);
        if (!result.success) setOperationError(result.error);
        setIsSubmitting(false);
    };

    const handleFinish = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!libraryValid || isSubmitting) return;
        const normalizedPath = libraryPath.trim();
        setOperationError('');
        setIsSubmitting(true);

        const folderResult = await addLibraryFolder(normalizedPath, { scan: false });
        if (!folderResult.success) {
            setOperationError(folderResult.error);
            setIsSubmitting(false);
            return;
        }

        const finalizeResult = await finalizeSetup();
        if (!finalizeResult.success) {
            setOperationError(finalizeResult.error);
            setIsSubmitting(false);
            return;
        }

        void rescanLibrary(normalizedPath);
        onComplete();
    };

    return (
        <main className="setup-wizard">
            <div className="setup-wizard__atmosphere" aria-hidden="true" />
            <section className="setup-wizard__panel" aria-labelledby="setup-title">
                <header className="setup-wizard__header">
                    <span className="setup-wizard__brand-mark" aria-hidden="true">
                        <Music2 size={28} />
                    </span>
                    <div>
                        <p className="setup-wizard__eyebrow">First-run setup</p>
                        <h1 id="setup-title">Welcome to Aurora</h1>
                        <p>Create your admin account, prepare audio analysis, and point Aurora to your music.</p>
                    </div>
                </header>

                <ol className="setup-wizard__steps" aria-label="Setup progress">
                    {SETUP_STEPS.map((item, index) => {
                        const state = index < activeStepIndex ? 'complete' : index === activeStepIndex ? 'current' : 'upcoming';
                        return (
                            <li key={item.id} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                                <span className="setup-wizard__step-marker" aria-hidden="true">
                                    {state === 'complete' ? <Check size={15} /> : index + 1}
                                </span>
                                <span className="setup-wizard__step-label">{item.label}</span>
                            </li>
                        );
                    })}
                </ol>

                <div className="setup-wizard__content">
                    {step === 'account' ? (
                        <form className="setup-wizard__step" onSubmit={handleCreateAdmin} noValidate>
                            <div className="setup-wizard__step-heading">
                                <span className="setup-wizard__step-icon" aria-hidden="true"><ShieldCheck size={22} /></span>
                                <div>
                                    <p className="setup-wizard__eyebrow">Required</p>
                                    <h2 ref={headingRef} tabIndex={-1}>Secure your server</h2>
                                    <p>Create the administrator account used for library, system, and user management.</p>
                                </div>
                            </div>

                            <div className="setup-wizard__fields">
                                <div className="setup-wizard__field">
                                    <label htmlFor="setup-username">Admin username</label>
                                    <input
                                        id="setup-username"
                                        type="text"
                                        value={username}
                                        onChange={event => setUsername(event.target.value)}
                                        autoComplete="username"
                                        autoFocus
                                        aria-describedby="setup-username-help"
                                        aria-invalid={operationError ? true : undefined}
                                    />
                                    <p id="setup-username-help">Use at least 3 characters.</p>
                                </div>
                                <div className="setup-wizard__field">
                                    <label htmlFor="setup-password">Password</label>
                                    <input
                                        id="setup-password"
                                        type="password"
                                        value={password}
                                        onChange={event => setPassword(event.target.value)}
                                        autoComplete="new-password"
                                        aria-describedby="setup-password-help"
                                        aria-invalid={operationError ? true : undefined}
                                    />
                                    <p id="setup-password-help">Use at least 12 characters.</p>
                                </div>
                            </div>

                            {operationError ? (
                                <p className="setup-wizard__message" data-state="error" role="alert">
                                    <AlertCircle size={16} aria-hidden="true" /> {operationError}
                                </p>
                            ) : null}

                            <div className="setup-wizard__actions setup-wizard__actions--single">
                                <button type="submit" className="btn btn-primary btn-lg" disabled={!accountValid || isSubmitting}>
                                    {isSubmitting ? <Loader2 size={17} className="setup-wizard__spinner" aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}
                                    {isSubmitting ? 'Creating account...' : 'Create admin account'}
                                </button>
                            </div>
                        </form>
                    ) : null}

                    {step === 'analysis' ? (
                        <div className="setup-wizard__step">
                            <div className="setup-wizard__step-heading">
                                <span className="setup-wizard__step-icon" aria-hidden="true"><BrainCircuit size={22} /></span>
                                <div>
                                    <p className="setup-wizard__eyebrow">Recommended</p>
                                    <h2 ref={headingRef} tabIndex={-1}>Prepare audio analysis</h2>
                                    <p>Aurora listens to every track with Discogs-EffNet, and small classifiers read its styles, danceability, acoustic or electronic sound, vocals and moods. Genres from the sound, recommendations, radio and AI playlists all build on it.</p>
                                </div>
                            </div>

                            <div className="setup-wizard__model-panel" aria-live="polite" aria-busy={modelLoading || modelDownloading}>
                                {modelLoading && flattenedModels.length === 0 ? (
                                    <p className="setup-wizard__model-empty"><Loader2 size={17} className="setup-wizard__spinner" aria-hidden="true" /> Checking model files...</p>
                                ) : (
                                    <ul className="setup-wizard__model-list" aria-label="Audio analysis models">
                                        {modelGroups.map(group => {
                                            const several = group.files.length > 1;
                                            // One file: its bytes; several: how many of them are in.
                                            const value = several ? group.readyFiles : group.total > 0 ? Math.min(group.bytes, group.total) : undefined;
                                            const max = several ? group.files.length : group.total || undefined;
                                            const state = group.ready ? 'ready' : group.downloading ? 'downloading' : 'missing';
                                            const status = group.ready
                                                ? `${formatBytes(group.size)} ready`
                                                : group.downloading
                                                    ? several ? `${group.readyFiles} of ${group.files.length} downloaded` : `${formatBytes(group.bytes)} downloaded`
                                                    : several && group.readyFiles > 0 ? `${group.files.length - group.readyFiles} of ${group.files.length} missing` : 'Not downloaded';
                                            return (
                                                <li key={group.id} data-state={state}>
                                                    <div className="setup-wizard__model-row">
                                                        <span className="setup-wizard__model-icon" aria-hidden="true">
                                                            {group.ready ? <CheckCircle2 size={17} /> : group.downloading ? <Download size={17} /> : <AlertCircle size={17} />}
                                                        </span>
                                                        <div>
                                                            <strong>{group.name}{several ? ` (${group.files.length})` : ''}</strong>
                                                            <small>{group.detail}</small>
                                                        </div>
                                                        <span>{status}</span>
                                                    </div>
                                                    {group.downloading ? (
                                                        <progress
                                                            className="setup-wizard__progress"
                                                            value={value}
                                                            max={max}
                                                            aria-label={`Downloading ${group.name}`}
                                                        />
                                                    ) : null}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>

                            <p className="setup-wizard__note">
                                If you skip this step, Aurora still imports playable tracks and their tags. Analysis waits until the models are downloaded in Settings → Library.
                            </p>

                            {operationError ? (
                                <p className="setup-wizard__message" data-state="error" role="alert">
                                    <AlertCircle size={16} aria-hidden="true" /> {operationError}
                                </p>
                            ) : null}

                            <div className="setup-wizard__actions">
                                {allModelsReady ? (
                                    <button type="button" className="btn btn-primary btn-lg" onClick={() => void goToStep('library')} disabled={isSubmitting}>
                                        Continue <ChevronRight size={17} aria-hidden="true" />
                                    </button>
                                ) : (
                                    <button type="button" className="btn btn-primary btn-lg" onClick={() => void handleDownloadModels()} disabled={modelDownloading || isSubmitting || modelLoading}>
                                        {modelDownloading ? <Loader2 size={17} className="setup-wizard__spinner" aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}
                                        {modelDownloading ? 'Downloading models...' : 'Download models'}
                                    </button>
                                )}
                                {!allModelsReady ? (
                                    <button type="button" className="btn btn-ghost btn-lg" onClick={() => void goToStep('library')} disabled={isSubmitting}>
                                        Skip for now
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}

                    {step === 'library' ? (
                        <form className="setup-wizard__step" onSubmit={handleFinish} noValidate>
                            <div className="setup-wizard__step-heading">
                                <span className="setup-wizard__step-icon" aria-hidden="true"><FolderPlus size={22} /></span>
                                <div>
                                    <p className="setup-wizard__eyebrow">Required</p>
                                    <h2 ref={headingRef} tabIndex={-1}>Add your music library</h2>
                                    <p>Enter an absolute directory on the machine running Aurora. The first scan starts in the background after launch.</p>
                                </div>
                            </div>

                            <div className="setup-wizard__field">
                                <label htmlFor="setup-library-path">Music directory</label>
                                <input
                                    id="setup-library-path"
                                    type="text"
                                    value={libraryPath}
                                    onChange={event => setLibraryPath(event.target.value)}
                                    placeholder="/srv/music"
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-describedby="setup-library-help setup-library-example"
                                    aria-invalid={operationError ? true : undefined}
                                    autoFocus
                                />
                                <p id="setup-library-help">The directory must already exist and be readable by the Aurora server.</p>
                                <code id="setup-library-example" className="setup-wizard__path-example">Linux: /srv/music&nbsp;&nbsp; Windows: D:\Music</code>
                            </div>

                            <p className="setup-wizard__note">
                                AI playlists, Last.fm, MusicBrainz, Genius and the other optional integrations can be set up in Settings after launch.
                            </p>

                            {operationError ? (
                                <p className="setup-wizard__message" data-state="error" role="alert">
                                    <AlertCircle size={16} aria-hidden="true" /> {operationError}
                                </p>
                            ) : null}

                            <div className="setup-wizard__actions setup-wizard__actions--split">
                                <button type="button" className="btn btn-ghost btn-lg" onClick={() => void goToStep('analysis')} disabled={isSubmitting}>
                                    <ChevronLeft size={17} aria-hidden="true" /> Previous
                                </button>
                                <button type="submit" className="btn btn-primary btn-lg" disabled={!libraryValid || isSubmitting}>
                                    {isSubmitting ? <Loader2 size={17} className="setup-wizard__spinner" aria-hidden="true" /> : <FolderPlus size={17} aria-hidden="true" />}
                                    {isSubmitting ? 'Preparing Aurora...' : 'Add library and launch'}
                                </button>
                            </div>
                        </form>
                    ) : null}
                </div>
            </section>
        </main>
    );
};
