import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldAlert, UserRound } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { ConfirmModal } from '../ConfirmModal';
import { PromptModal } from '../PromptModal';
import type { AccountProtection } from '../../../shared/accountProtection';

// Why this account can't be deleted, in the owner's own words.
const OWN_ACCOUNT_PROTECTION: Record<AccountProtection, string> = {
    owner: 'You own this Aurora server, so this account can\'t be deleted.',
    'last-admin': 'You\'re the only admin. Make another user an admin before deleting this account.',
};

interface AccountTabProps {
    onClose: () => void;
}

export const AccountTab: React.FC<AccountTabProps> = ({ onClose }) => {
    const currentUser = usePlayerStore(state => state.currentUser);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const clearAuthToken = usePlayerStore(state => state.clearAuthToken);

    const { addToast } = useToast();

    const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
    const [promptDialog, setPromptDialog] = useState<{ title: string; label?: string; placeholder?: string; inputType?: React.HTMLInputTypeAttribute; autoComplete?: string; confirmLabel?: string; onSubmit: (value: string) => void } | null>(null);

    // undefined while loading, so the delete button never flashes up for an
    // account that can't use it. A failed lookup shows it: the server still
    // refuses a protected deletion.
    const [protection, setProtection] = useState<AccountProtection | null | undefined>(undefined);
    useEffect(() => {
        let cancelled = false;
        fetch('/api/auth/account-protection', { headers: getAuthHeader() })
            .then(res => (res.ok ? res.json() : { protection: null }))
            .then(data => { if (!cancelled) setProtection(data?.protection ?? null); })
            .catch(() => { if (!cancelled) setProtection(null); });
        return () => { cancelled = true; };
    }, [getAuthHeader]);

    const username = currentUser?.username || 'User';
    const roleLabel = currentUser?.role || 'listener';

    const showToast = (msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type);

    const requestAccountDeletion = () => {
        setConfirmDialog({
            title: 'Delete Account',
            message: 'This will permanently delete your account. You will be signed out immediately. Type your password to confirm.',
            confirmLabel: 'Delete My Account',
            onConfirm: async () => {
                setConfirmDialog(null);
                setPromptDialog({
                    title: 'Confirm Password',
                    label: 'Enter your password to delete your account.',
                    inputType: 'password',
                    autoComplete: 'current-password',
                    confirmLabel: 'Delete Account',
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
                        } catch {
                            showToast('Network error', 'error');
                        }
                    },
                });
            },
        });
    };

    return (
        <div className="settings-section account-settings">
            <header className="account-settings__header">
                <div>
                    <p className="account-settings__eyebrow">Account</p>
                    <h3>My Account</h3>
                </div>
                <span className="account-settings__role">{roleLabel}</span>
            </header>

            <section className="account-profile" aria-label="Signed in account">
                <div className="account-profile__glow" aria-hidden="true"></div>
                <div className="account-profile__avatar" aria-hidden="true">
                    {username[0]?.toUpperCase() || 'U'}
                </div>
                <div className="account-profile__copy">
                    <div className="account-profile__label">
                        <UserRound size={15} aria-hidden="true" />
                        Signed in as
                    </div>
                    <h4>{username}</h4>
                    <p>{roleLabel} access on this Aurora server</p>
                </div>
            </section>

            <section className="account-panel account-panel--security">
                <div className="account-panel__header">
                    <div className="account-panel__title">
                        <KeyRound size={17} aria-hidden="true" />
                        <h4>Change Password</h4>
                    </div>
                    <p>Use at least 12 characters.</p>
                </div>

                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        const form = e.target as HTMLFormElement;
                        const current = (form.elements.namedItem('currentPassword') as HTMLInputElement).value;
                        const newPw = (form.elements.namedItem('newPassword') as HTMLInputElement).value;
                        const confirm = (form.elements.namedItem('confirmPassword') as HTMLInputElement).value;

                        if (!current || !newPw) return;
                        if (newPw.length < 12) { showToast('Password must be at least 12 characters', 'error'); return; }
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
                        } catch {
                            showToast('Network error', 'error');
                        }
                    }}
                    className="account-password-form"
                >
                    <label className="account-field">
                        <span>Current password</span>
                        <input name="currentPassword" type="password" required autoComplete="current-password" />
                    </label>
                    <label className="account-field">
                        <span>New password</span>
                        <input name="newPassword" type="password" required autoComplete="new-password" placeholder="12+ characters" />
                    </label>
                    <label className="account-field">
                        <span>Confirm password</span>
                        <input name="confirmPassword" type="password" required autoComplete="new-password" />
                    </label>
                    <button type="submit" className="btn btn-primary account-password-form__action">
                        Update Password
                    </button>
                </form>
            </section>

            <section className="account-panel account-panel--danger">
                <div className="account-panel__header">
                    <div className="account-panel__title">
                        <ShieldAlert size={17} aria-hidden="true" />
                        <h4>Danger Zone</h4>
                    </div>
                    <p>{protection
                        ? OWN_ACCOUNT_PROTECTION[protection]
                        : 'Permanently delete this account and all associated data.'}</p>
                </div>
                {protection === null && (
                    <button type="button" onClick={requestAccountDeletion} className="btn btn-danger account-danger__action">
                        Delete Account
                    </button>
                )}
            </section>

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
                    inputType={promptDialog.inputType}
                    autoComplete={promptDialog.autoComplete}
                    confirmLabel={promptDialog.confirmLabel}
                    onSubmit={promptDialog.onSubmit}
                    onCancel={() => setPromptDialog(null)}
                />
            )}
        </div>
    );
};
