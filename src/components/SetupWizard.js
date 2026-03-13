import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { usePlayerStore } from '../store/index';
import { Settings, FolderPlus, Key, Database, ChevronRight, CheckCircle2 } from 'lucide-react';
export const SetupWizard = ({ onComplete }) => {
    const { addLibraryFolder, setLastFmApiKey, setGeniusApiKey } = usePlayerStore();
    const [step, setStep] = useState(1);
    // Step 1 State
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [authError, setAuthError] = useState('');
    // Step 2 State
    const [libraryPath, setLibraryPath] = useState('');
    // Step 3 State
    const [lastFmKey, setLastFmKeyState] = useState('');
    const [geniusKey, setGeniusKeyState] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const handleCreateAdmin = async () => {
        setAuthError('');
        if (username.length < 3 || password.length < 5) {
            setAuthError('Username > 3 chars, Password > 5 chars required.');
            return;
        }
        setIsSaving(true);
        try {
            const res = await fetch('/api/setup/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!res.ok) {
                const data = await res.json();
                setAuthError(data.error || 'Failed to securely configure server.');
                setIsSaving(false);
                return;
            }
            // Immediately persist these locally so subsequent API calls this session work implicitly
            usePlayerStore.getState().setAuthToken(btoa(`${username}:${password}`));
            setStep(2);
        }
        catch (e) {
            setAuthError('Network error connecting to setup API.');
        }
        setIsSaving(false);
    };
    const handleAddLibrary = async () => {
        if (libraryPath) {
            await addLibraryFolder(libraryPath);
        }
        setStep(3);
    };
    const handleFinish = async () => {
        if (lastFmKey)
            setLastFmApiKey(lastFmKey);
        if (geniusKey)
            setGeniusApiKey(geniusKey);
        onComplete();
    };
    return (_jsxs("div", { className: "fixed inset-0 z-[100] bg-[var(--color-bg)] flex items-center justify-center p-4", children: [_jsx("div", { className: "absolute inset-0 z-0 opacity-30 bg-gradient-to-br from-[var(--color-primary-dark)] via-[var(--color-bg)] to-purple-900 pointer-events-none" }), _jsxs("div", { className: "relative z-10 w-full max-w-2xl bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl p-8 md:p-12 backdrop-blur-3xl overflow-hidden", children: [_jsxs("div", { className: "flex flex-col items-center mb-10", children: [_jsx("div", { className: "w-16 h-16 bg-[var(--color-primary)]/20 text-[var(--color-primary)] rounded-full flex items-center justify-center mb-4", children: _jsx(Settings, { className: "w-8 h-8" }) }), _jsx("h1", { className: "text-3xl md:text-4xl font-extrabold tracking-tight text-[var(--color-text-primary)]", children: "Welcome to NorthernLights" }), _jsx("p", { className: "text-[var(--color-text-secondary)] mt-2 text-center", children: "Let's get your personal media server set up in a few simple steps." })] }), _jsx("div", { className: "flex items-center justify-center gap-2 mb-10", children: [1, 2, 3].map(i => (_jsxs("div", { className: "flex items-center", children: [_jsx("div", { className: `w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-300 ${step === i ? 'bg-[var(--color-primary)] text-white scale-110 shadow-[var(--shadow-md)]' : step > i ? 'bg-[var(--color-primary-dark)] text-white' : 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]'}`, children: step > i ? _jsx(CheckCircle2, { className: "w-4 h-4" }) : i }), i < 3 && _jsx("div", { className: `w-12 h-1 mx-2 rounded ${step > i ? 'bg-[var(--color-primary)]' : 'bg-[var(--glass-border)]'}` })] }, i))) }), step === 1 && (_jsxs("div", { className: "space-y-6 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both", children: [_jsxs("div", { className: "text-center mb-6", children: [_jsxs("h2", { className: "text-xl font-bold flex justify-center items-center gap-2", children: [_jsx(Key, { className: "w-5 h-5 text-[var(--color-primary)]" }), " Secure Your Server"] }), _jsx("p", { className: "text-sm text-[var(--color-text-secondary)] mt-1", children: "Create an admin username and password. This protects your library from public access over the internet." })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-secondary)] mb-1", children: "Username" }), _jsx("input", { type: "text", value: username, onChange: e => setUsername(e.target.value), placeholder: "admin", className: "w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-secondary)] mb-1", children: "Password" }), _jsx("input", { type: "password", value: password, onChange: e => setPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", className: "w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" })] }), authError && _jsx("p", { className: "text-red-400 text-sm opacity-90", children: authError })] }), _jsxs("button", { onClick: handleCreateAdmin, disabled: isSaving, className: "w-full mt-6 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50", children: [isSaving ? 'Securing Server...' : 'Next Step', " ", _jsx(ChevronRight, { className: "w-5 h-5" })] })] })), step === 2 && (_jsxs("div", { className: "space-y-6 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both", children: [_jsxs("div", { className: "text-center mb-6", children: [_jsxs("h2", { className: "text-xl font-bold flex justify-center items-center gap-2", children: [_jsx(Database, { className: "w-5 h-5 text-[var(--color-primary)]" }), " Map Your Music"] }), _jsx("p", { className: "text-sm text-[var(--color-text-secondary)] mt-1", children: "Provide the absolute path to your music folder on this server to begin importing tracks." })] }), _jsxs("div", { className: "bg-[var(--color-surface)]/50 border border-[var(--glass-border)] rounded-xl p-4 text-sm text-[var(--color-text-secondary)] mb-4", children: ["Example: ", _jsx("code", { className: "bg-black/30 px-1 py-0.5 rounded text-[var(--color-text-primary)]", children: "/mnt/storage/music" }), " or ", _jsx("code", { className: "bg-black/30 px-1 py-0.5 rounded text-[var(--color-text-primary)]", children: "C:\\Users\\Andreas\\Music" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-secondary)] mb-1", children: "Absolute Directory Path" }), _jsx("input", { type: "text", value: libraryPath, onChange: e => setLibraryPath(e.target.value), placeholder: "/path/to/music", className: "w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" })] }), _jsxs("div", { className: "flex gap-4 mt-6", children: [_jsxs("button", { onClick: handleAddLibrary, className: "flex-1 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-semibold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2", children: [_jsx(FolderPlus, { className: "w-5 h-5" }), " Import Library"] }), _jsx("button", { onClick: () => setStep(3), className: "px-6 bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--glass-border)] text-[var(--color-text-primary)] font-semibold rounded-xl transition-all", children: "Skip" })] })] })), step === 3 && (_jsxs("div", { className: "space-y-6 animate-in slide-in-from-right-8 fade-in duration-500 fill-mode-both", children: [_jsxs("div", { className: "text-center mb-6", children: [_jsxs("h2", { className: "text-xl font-bold flex justify-center items-center gap-2", children: [_jsx(Settings, { className: "w-5 h-5 text-[var(--color-primary)]" }), " External Enablers"] }), _jsx("p", { className: "text-sm text-[var(--color-text-secondary)] mt-1", children: "Optionally add API keys to fetch rich artist imagery, bios, and fallback album art directly in the frontend." })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-secondary)] mb-1", children: "Last.fm API Key" }), _jsx("input", { type: "password", value: lastFmKey, onChange: e => setLastFmKeyState(e.target.value), placeholder: "32-character API key", className: "w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-[var(--color-text-secondary)] mb-1", children: "Genius Access Token" }), _jsx("input", { type: "password", value: geniusKey, onChange: e => setGeniusKeyState(e.target.value), placeholder: "64-character Bearer Token", className: "w-full bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 transition-all font-mono text-[var(--color-text-primary)]" })] })] }), _jsxs("button", { onClick: handleFinish, className: "w-full mt-6 bg-gradient-to-r from-[var(--color-primary)] to-purple-600 hover:from-[var(--color-primary-dark)] hover:to-purple-700 text-white font-bold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2", children: [_jsx(CheckCircle2, { className: "w-5 h-5" }), " Finish Setup & Launch"] })] }))] })] }));
};
