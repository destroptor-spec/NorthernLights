import React, { useState, useEffect } from 'react';
import { usePlayerStore } from '../../store/index';
import { useToast } from '../../hooks/useToast';
import { User, Shield, Clock, Link, Check, Trash2, Plus, Copy, AlertCircle } from 'lucide-react';

interface UserType {
    id: string;
    username: string;
    role: string;
    created_at: number;
    last_login_at: number;
}
  
interface Invite {
    token: string;
    created_by: string;
    role: string;
    max_uses: number;
    uses: number;
    expires_at: number | null;
    created_at: number;
}

export const AdminDashboard: React.FC = () => {
    const currentUser = usePlayerStore(state => state.currentUser);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const { addToast } = useToast();
    const showToast = (msg: string, type: 'success' | 'error' | 'info') => addToast(msg, type);

    const [users, setUsers] = useState<UserType[]>([]);
    const [invites, setInvites] = useState<Invite[]>([]);
    const [adminTab, setAdminTab] = useState<'users' | 'invites'>('users');
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState('user');
    const [createError, setCreateError] = useState('');
    const [copiedToken, setCopiedToken] = useState('');
    const [inviteUrls, setInviteUrls] = useState<Record<string, string>>({});
  
    const authHeaders = getAuthHeader();
  
    const fetchUsers = async () => {
        try {
            const res = await fetch('/api/admin/users', { headers: authHeaders });
            if (res.ok) {
                const data = await res.json();
                setUsers(data.users);
            }
        } catch (e) { console.error('Failed to fetch users', e); }
    };
  
    const fetchInvites = async () => {
        try {
            const res = await fetch('/api/admin/invites', { headers: authHeaders });
            if (res.ok) {
                const data = await res.json();
                setInvites(data.invites);
            }
        } catch (e) { console.error('Failed to fetch invites', e); }
    };
  
    useEffect(() => {
        fetchUsers();
        fetchInvites();
    }, []);
  
    const handleCreateUser = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreateError('');
        try {
            const res = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
            });
            const data = await res.json();
            if (res.ok) {
                showToast(`Created user ${newUsername}`, 'success');
                setNewUsername('');
                setNewPassword('');
                setShowCreateUser(false);
                fetchUsers();
            } else {
                setCreateError(data.error || 'Failed to create user');
            }
        } catch (e) {
            setCreateError('Network error');
        }
    };
  
    const handleCreateInvite = async () => {
        try {
            const res = await fetch('/api/admin/invites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ role: 'user', maxUses: 1, expiresInDays: 7 })
            });
            if (res.ok) {
                showToast('Invite link generated', 'success');
                fetchInvites();
            } else {
                const data = await res.json();
                showToast(data.error || 'Failed to create invite', 'error');
            }
        } catch (e) {
            showToast('Network error', 'error');
        }
    };
  
    const revokeInvite = async (token: string) => {
        try {
            const res = await fetch(`/api/admin/invites/${token}`, {
                method: 'DELETE',
                headers: authHeaders
            });
            if (res.ok) {
                showToast('Invite revoked', 'success');
                fetchInvites();
            }
        } catch (e) {
            showToast('Failed to revoke invite', 'error');
        }
    };
  
    const deleteUser = async (id: string, username: string) => {
        if (!confirm(`Are you sure you want to delete ${username}? This cannot be undone.`)) return;
        try {
            const res = await fetch(`/api/admin/users/${id}`, {
                method: 'DELETE',
                headers: authHeaders
            });
            if (res.ok) {
                showToast(`Deleted user ${username}`, 'success');
                fetchUsers();
            } else {
                showToast('Failed to delete user', 'error');
            }
        } catch (e) {
            showToast('Network error', 'error');
        }
    };

    const copyInviteLink = (token: string) => {
        const url = `${window.location.origin}/invite/${token}`;
        navigator.clipboard.writeText(url);
        setCopiedToken(token);
        setInviteUrls(prev => ({ ...prev, [token]: url }));
        setTimeout(() => setCopiedToken(''), 2000);
    };

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-6">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">User Management</h3>
            </div>
    
            <div className="flex gap-2 mb-6 border-b border-[var(--glass-border)] pb-4">
                <button 
                    onClick={() => setAdminTab('users')}
                    className={`btn-tab ${adminTab === 'users' ? 'active' : ''}`}
                >
                    <User size={16} className="inline mr-1 relative -top-[1px]" />
                    Users ({users.length})
                </button>
                <button 
                    onClick={() => setAdminTab('invites')}
                    className={`btn-tab ${adminTab === 'invites' ? 'active' : ''}`}
                >
                    <Link size={16} className="inline mr-1 relative -top-[1px]" />
                    Invites ({invites.length})
                </button>
            </div>
    
            {adminTab === 'users' && (
                <div className="space-y-4">
                    <div className="flex justify-between items-center">
                        <p className="text-sm text-[var(--color-text-muted)]">Active accounts on this server.</p>
                        <button 
                            onClick={() => setShowCreateUser(!showCreateUser)}
                            className="btn btn-sm btn-primary"
                        >
                            <Plus size={14} className="mr-1 inline" /> New User
                        </button>
                    </div>
    
                    {showCreateUser && (
                        <div className="bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl p-4 shadow-sm">
                            <h4 className="font-medium text-[var(--color-text-primary)] mb-3 text-sm">Create New User Account</h4>
                            <form onSubmit={handleCreateUser} className="space-y-3">
                                {createError && <div className="text-xs text-red-400 bg-red-400/10 p-2 rounded">{createError}</div>}
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <input 
                                        type="text" 
                                        placeholder="Username" 
                                        required
                                        value={newUsername}
                                        onChange={e => setNewUsername(e.target.value)}
                                        className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                                    />
                                    <input 
                                        type="password" 
                                        placeholder="Password" 
                                        required
                                        value={newPassword}
                                        onChange={e => setNewPassword(e.target.value)}
                                        className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                                    />
                                    <select 
                                        value={newRole}
                                        onChange={e => setNewRole(e.target.value)}
                                        className="w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)]"
                                    >
                                        <option value="user">User</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                </div>
                                <div className="flex justify-end gap-2 pt-1">
                                    <button type="button" onClick={() => setShowCreateUser(false)} className="btn btn-sm btn-ghost">Cancel</button>
                                    <button type="submit" className="btn btn-sm btn-primary">Create Account</button>
                                </div>
                            </form>
                        </div>
                    )}
    
                    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--glass-border)] overflow-hidden">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-[var(--glass-bg)] border-b border-[var(--glass-border)]">
                                <tr>
                                    <th className="px-4 py-3 font-medium text-[var(--color-text-secondary)]">User</th>
                                    <th className="px-4 py-3 font-medium text-[var(--color-text-secondary)]">Role</th>
                                    <th className="px-4 py-3 font-medium text-[var(--color-text-secondary)] hidden md:table-cell">Created</th>
                                    <th className="px-4 py-3 font-medium text-[var(--color-text-secondary)] hidden md:table-cell">Last Login</th>
                                    <th className="px-4 py-3"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--glass-border)]">
                                {users.map(u => (
                                    <tr key={u.id} className="hover:bg-[var(--glass-bg)] transition-colors">
                                        <td className="px-4 py-3 font-medium text-[var(--color-text-primary)]">{u.username}</td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${u.role === 'admin' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'}`}>
                                                {u.role === 'admin' ? <Shield size={10} className="mr-1" /> : <User size={10} className="mr-1" />}
                                                {u.role.toUpperCase()}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-[var(--color-text-muted)] text-xs hidden md:table-cell">
                                            {new Date(u.created_at).toLocaleDateString()}
                                        </td>
                                        <td className="px-4 py-3 text-[var(--color-text-muted)] text-xs hidden md:table-cell">
                                            {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            {u.id !== currentUser?.id && (
                                                <button onClick={() => deleteUser(u.id, u.username)} className="p-1.5 text-red-400 hover:bg-red-400/10 rounded transition-colors" title="Delete User">
                                                    <Trash2 size={16} />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
    
            {adminTab === 'invites' && (
                <div className="space-y-4">
                    <div className="flex justify-between items-center">
                        <p className="text-sm text-[var(--color-text-muted)]">Generate magic links to let friends create accounts.</p>
                        <button onClick={handleCreateInvite} className="btn btn-sm btn-primary">
                            <Plus size={14} className="mr-1 inline" /> Generate Link
                        </button>
                    </div>
    
                    {invites.length === 0 ? (
                        <div className="p-8 text-center border border-dashed border-[var(--glass-border)] rounded-xl text-sm text-[var(--color-text-muted)]">
                            No active invitations.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {invites.map(inv => {
                                const isExpired = inv.expires_at && inv.expires_at < Date.now();
                                const isUsedUp = inv.uses >= inv.max_uses;
                                const invalid = isExpired || isUsedUp;
                                
                                return (
                                    <div key={inv.token} className={`bg-[var(--color-surface)] border border-[var(--glass-border)] rounded-xl p-4 ${invalid ? 'opacity-60' : ''}`}>
                                        <div className="flex justify-between mb-3">
                                            <span className={`text-xs font-medium px-2 py-0.5 rounded ${invalid ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-500'}`}>
                                                {isExpired ? 'Expired' : isUsedUp ? 'Used up' : 'Active'}
                                            </span>
                                            <button onClick={() => revokeInvite(inv.token)} className="text-[var(--color-text-muted)] hover:text-red-400">
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                        
                                        <div className="flex flex-col gap-1.5 mb-4">
                                            <div className="text-xs text-[var(--color-text-secondary)] flex items-center justify-between">
                                                <span>Uses</span>
                                                <span className="font-mono">{inv.uses} / {inv.max_uses}</span>
                                            </div>
                                            <div className="text-xs text-[var(--color-text-secondary)] flex items-center justify-between">
                                                <span>Expires</span>
                                                <span>{inv.expires_at ? new Date(inv.expires_at).toLocaleDateString() : 'Never'}</span>
                                            </div>
                                        </div>
                                        
                                        {!invalid && (
                                            <button 
                                                onClick={() => copyInviteLink(inv.token)}
                                                className="w-full btn btn-sm btn-ghost border border-[var(--glass-border)] hover:border-[var(--color-primary)] transition-colors flex justify-center items-center gap-2"
                                            >
                                                {copiedToken === inv.token ? (
                                                    <><Check size={14} className="text-green-500" /> <span className="text-green-500">Copied!</span></>
                                                ) : (
                                                    <><Copy size={14} /> Copy Invite Link</>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
