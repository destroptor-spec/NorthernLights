import React, { useState } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { ConfirmModal } from '../ConfirmModal';
import { PromptModal } from '../PromptModal';

interface AccountTabProps {
    onClose: () => void;
}

export const AccountTab: React.FC<AccountTabProps> = ({ onClose }) => {
    const currentUser = usePlayerStore(state => state.currentUser);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const clearAuthToken = usePlayerStore(state => state.clearAuthToken);
    
    const { addToast } = useToast();
    
    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    const [promptDialog, setPromptDialog] = useState<{ title: string; label?: string; placeholder?: string; onSubmit: (value: string) => void } | null>(null);

    const username = currentUser?.username || 'User';

    const showToast = (msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type);

    return (
        <div className="settings-section">
            <div className="settings-section-header mb-6">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">My Account</h3>
            </div>

            <div className="bg-[var(--color-surface)] rounded-2xl overflow-hidden border border-[var(--glass-border)] shadow-xl">
                <div className="h-24 bg-aurora-gradient opacity-80"></div>
                <div className="px-4 pb-6 -mt-12">
                    <div className="flex items-end gap-3 mb-4">
                        <div className="w-20 h-20 rounded-full border-4 border-[var(--color-surface)] bg-[var(--color-surface-variant)] flex items-center justify-center text-3xl font-bold text-[var(--color-text-primary)] overflow-hidden shadow-lg backdrop-blur-md">
                            {username[0]?.toUpperCase() || 'U'}
                        </div>
                        <div className="mb-1">
                            <h4 className="text-xl font-bold text-white">{username}</h4>
                            <span className="text-xs text-white/60 capitalize">{currentUser?.role}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Change Password */}
            <div className="mt-6 bg-[var(--color-surface)] rounded-2xl p-5 border border-[var(--glass-border)]">
                <h4 className="font-semibold text-[var(--color-text-primary)] mb-4">Change Password</h4>
                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        const form = e.target as HTMLFormElement;
                        const current = (form.elements.namedItem('currentPassword') as HTMLInputElement).value;
                        const newPw = (form.elements.namedItem('newPassword') as HTMLInputElement).value;
                        const confirm = (form.elements.namedItem('confirmPassword') as HTMLInputElement).value;

                        if (!current || !newPw) return;
                        if (newPw.length < 5) { showToast('Password must be 5+ characters', 'error'); return; }
                        if (newPw !== confirm) { showToast('Passwords do not match', 'error'); return; }

                        try {
                            const res = await fetch('/api/auth/change-password', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                                body: JSON.stringify({ currentPassword: current, newPassword: newPw })
                            });
                            const data = await res.json();
                            if (res.ok) {
                                showToast('Password changed', 'success');
                                form.reset();
                            } else {
                                showToast(data.error || 'Failed', 'error');
                            }
                        } catch { showToast('Network error', 'error'); }
                    }}
                    className="space-y-3"
                >
                    <input name="currentPassword" type="password" placeholder="Current password" required
                        className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" />
                    <input name="newPassword" type="password" placeholder="New password (5+ chars)" required
                        className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" />
                    <input name="confirmPassword" type="password" placeholder="Confirm new password" required
                        className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" />
                    <button type="submit" className="btn btn-primary">
                        Update Password
                    </button>
                </form>
            </div>

            {/* Delete Account */}
            <div className="mt-6 bg-red-500/5 rounded-2xl p-5 border border-red-500/20">
                <h4 className="font-semibold text-red-400 mb-2">Danger Zone</h4>
                <p className="text-sm text-[var(--color-text-muted)] mb-4">Permanently delete your account and all associated data. This cannot be undone.</p>
                <button
                    onClick={() => {
                        setConfirmDialog({
                            title: 'Delete Account',
                            message: 'This will permanently delete your account. You will be signed out immediately. Type your password to confirm.',
                            confirmLabel: 'Delete My Account',
                            onConfirm: async () => {
                                setConfirmDialog(null);
                                setPromptDialog({
                                    title: 'Confirm Password',
                                    label: 'Enter your password to delete your account.',
                                    onSubmit: async (password) => {
                                        setPromptDialog(null);
                                        try {
                                            const res = await fetch('/api/auth/delete-account', {
                                                method: 'DELETE',
                                                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                                                body: JSON.stringify({ password })
                                            });
                                            if (res.ok) {
                                                showToast('Account deleted', 'success');
                                                clearAuthToken();
                                                onClose();
                                            } else {
                                                const data = await res.json();
                                                showToast(data.error || 'Failed', 'error');
                                            }
                                        } catch { showToast('Network error', 'error'); }
                                    },
                                });
                            },
                        });
                    }}
                    className="btn btn-danger"
                >
                    Delete Account
                </button>
            </div>

            {confirmDialog && (
                <ConfirmModal
                    title={confirmDialog.title}
                    message={confirmDialog.message}
                    confirmLabel={confirmDialog.confirmLabel}
                    onConfirm={confirmDialog.onConfirm}
                    onCancel={() => setConfirmDialog(null)}
                />
            )}

            {promptDialog && (
                <PromptModal
                    title={promptDialog.title}
                    label={promptDialog.label}
                    placeholder={promptDialog.placeholder}
                    onSubmit={promptDialog.onSubmit}
                    onCancel={() => setPromptDialog(null)}
                />
            )}
        </div>
    );
};
