import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { usePlayerStore } from '../store/index';
import { Shield, Users, Link, Trash2, Plus, Copy, Check } from 'lucide-react';
export const AdminPanel = ({ onClose }) => {
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const currentUser = usePlayerStore(state => state.currentUser);
    const [users, setUsers] = useState([]);
    const [invites, setInvites] = useState([]);
    const [activeTab, setActiveTab] = useState('users');
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState('user');
    const [createError, setCreateError] = useState('');
    const [copiedToken, setCopiedToken] = useState('');
    const [inviteUrls, setInviteUrls] = useState({});
    const authHeaders = getAuthHeader();
    const fetchUsers = async () => {
        try {
            const res = await fetch('/api/admin/users', { headers: authHeaders });
            if (res.ok) {
                const data = await res.json();
                setUsers(data.users);
            }
        }
        catch (e) {
            console.error('Failed to fetch users', e);
        }
    };
    const fetchInvites = async () => {
        try {
            const res = await fetch('/api/admin/invites', { headers: authHeaders });
            if (res.ok) {
                const data = await res.json();
                setInvites(data.invites);
            }
        }
        catch (e) {
            console.error('Failed to fetch invites', e);
        }
    };
    useEffect(() => {
        fetchUsers();
        fetchInvites();
    }, []);
    const createUser = async () => {
        setCreateError('');
        if (newUsername.length < 3 || newPassword.length < 5) {
            setCreateError('Username 3+ chars, password 5+ chars');
            return;
        }
        try {
            const res = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
            });
            if (res.ok) {
                setNewUsername('');
                setNewPassword('');
                setNewRole('user');
                setShowCreateUser(false);
                fetchUsers();
            }
            else {
                const data = await res.json();
                setCreateError(data.error || 'Failed to create user');
            }
        }
        catch (e) {
            setCreateError('Network error');
        }
    };
    const deleteUser = async (id) => {
        if (id === currentUser?.id)
            return;
        if (!confirm('Delete this user? This cannot be undone.'))
            return;
        try {
            await fetch(`/api/admin/users/${id}`, { method: 'DELETE', headers: authHeaders });
            fetchUsers();
        }
        catch (e) {
            console.error('Failed to delete user', e);
        }
    };
    const createInvite = async () => {
        try {
            const res = await fetch('/api/admin/invites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ role: 'user', maxUses: 1 })
            });
            if (res.ok) {
                const data = await res.json();
                setInviteUrls(prev => ({ ...prev, [data.invite.token]: data.inviteUrl }));
                fetchInvites();
            }
        }
        catch (e) {
            console.error('Failed to create invite', e);
        }
    };
    const revokeInvite = async (token) => {
        try {
            await fetch(`/api/admin/invites/${token}`, { method: 'DELETE', headers: authHeaders });
            fetchInvites();
        }
        catch (e) {
            console.error('Failed to revoke invite', e);
        }
    };
    const copyToClipboard = (text, token) => {
        navigator.clipboard.writeText(text);
        setCopiedToken(token);
        setTimeout(() => setCopiedToken(''), 2000);
    };
    const formatDate = (ts) => {
        if (!ts)
            return 'Never';
        return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    };
    return (_jsx("div", { className: "fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4", onClick: onClose, children: _jsxs("div", { className: "relative w-full max-w-2xl max-h-[85vh] bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-2xl rounded-3xl overflow-hidden backdrop-blur-3xl", onClick: e => e.stopPropagation(), children: [_jsxs("div", { className: "p-6 pb-4 border-b border-[var(--glass-border)]", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "w-10 h-10 bg-[var(--color-primary)]/20 text-[var(--color-primary)] rounded-full flex items-center justify-center", children: _jsx(Shield, { className: "w-5 h-5" }) }), _jsxs("div", { children: [_jsx("h2", { className: "text-xl font-bold text-[var(--color-text-primary)]", children: "Admin Panel" }), _jsx("p", { className: "text-sm text-[var(--color-text-secondary)]", children: "Manage users and invitations" })] })] }), _jsx("button", { onClick: onClose, className: "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors text-xl", children: "x" })] }), _jsxs("div", { className: "flex gap-2 mt-4", children: [_jsxs("button", { onClick: () => setActiveTab('users'), className: `px-4 py-2 rounded-xl text-sm font-semibold transition-all ${activeTab === 'users' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`, children: [_jsx(Users, { className: "w-4 h-4 inline mr-1" }), " Users (", users.length, ")"] }), _jsxs("button", { onClick: () => setActiveTab('invites'), className: `px-4 py-2 rounded-xl text-sm font-semibold transition-all ${activeTab === 'invites' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`, children: [_jsx(Link, { className: "w-4 h-4 inline mr-1" }), " Invites (", invites.length, ")"] })] })] }), _jsxs("div", { className: "p-6 overflow-y-auto max-h-[60vh] hide-scrollbar", children: [activeTab === 'users' && (_jsxs("div", { className: "space-y-3", children: [!showCreateUser ? (_jsxs("button", { onClick: () => setShowCreateUser(true), className: "w-full py-3 rounded-xl border-2 border-dashed border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all flex items-center justify-center gap-2", children: [_jsx(Plus, { className: "w-4 h-4" }), " Add User"] })) : (_jsxs("div", { className: "bg-[var(--color-surface)] rounded-xl p-4 space-y-3", children: [_jsx("input", { type: "text", value: newUsername, onChange: e => setNewUsername(e.target.value), placeholder: "Username", autoFocus: true, className: "w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" }), _jsx("input", { type: "password", value: newPassword, onChange: e => setNewPassword(e.target.value), placeholder: "Password", className: "w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50" }), _jsxs("select", { value: newRole, onChange: e => setNewRole(e.target.value), className: "w-full bg-[var(--color-bg)] border border-[var(--glass-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none", children: [_jsx("option", { value: "user", children: "Regular User" }), _jsx("option", { value: "admin", children: "Admin" })] }), createError && _jsx("p", { className: "text-red-400 text-xs", children: createError }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: createUser, className: "flex-1 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-semibold hover:bg-[var(--color-primary-dark)]", children: "Create" }), _jsx("button", { onClick: () => { setShowCreateUser(false); setCreateError(''); }, className: "px-4 py-2 bg-[var(--glass-border)] text-[var(--color-text-secondary)] rounded-lg text-sm", children: "Cancel" })] })] })), users.map(user => (_jsxs("div", { className: "flex items-center justify-between p-3 bg-[var(--color-surface)] rounded-xl", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-semibold text-[var(--color-text-primary)]", children: user.username }), user.role === 'admin' && (_jsx("span", { className: "text-[0.65rem] px-2 py-0.5 rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-semibold uppercase", children: "Admin" })), user.id === currentUser?.id && (_jsx("span", { className: "text-[0.65rem] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-semibold", children: "You" }))] }), _jsxs("p", { className: "text-xs text-[var(--color-text-muted)] mt-0.5", children: ["Joined ", formatDate(user.created_at), " \u00B7 Last login ", formatDate(user.last_login_at)] })] }), user.id !== currentUser?.id && (_jsx("button", { onClick: () => deleteUser(user.id), className: "p-2 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all", title: "Delete user", children: _jsx(Trash2, { className: "w-4 h-4" }) }))] }, user.id)))] })), activeTab === 'invites' && (_jsxs("div", { className: "space-y-3", children: [_jsxs("button", { onClick: createInvite, className: "w-full py-3 rounded-xl border-2 border-dashed border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all flex items-center justify-center gap-2", children: [_jsx(Plus, { className: "w-4 h-4" }), " Generate Invite Link"] }), invites.map(invite => {
                                    const isExpired = invite.expires_at && Date.now() > invite.expires_at;
                                    const isUsedUp = invite.uses >= invite.max_uses;
                                    const inviteUrl = inviteUrls[invite.token] || `${window.location.origin}/invite/${invite.token}`;
                                    return (_jsxs("div", { className: `p-3 bg-[var(--color-surface)] rounded-xl ${isExpired || isUsedUp ? 'opacity-50' : ''}`, children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("span", { className: "text-xs font-mono text-[var(--color-text-muted)]", children: [invite.token.substring(0, 12), "..."] }), invite.role === 'admin' && (_jsx("span", { className: "text-[0.65rem] px-2 py-0.5 rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-semibold uppercase", children: "Admin" })), isExpired && _jsx("span", { className: "text-[0.65rem] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400", children: "Expired" }), isUsedUp && !isExpired && _jsx("span", { className: "text-[0.65rem] px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400", children: "Used" })] }), _jsx("button", { onClick: () => revokeInvite(invite.token), className: "p-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all", title: "Revoke", children: _jsx(Trash2, { className: "w-3.5 h-3.5" }) })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("code", { className: "flex-1 text-xs bg-[var(--color-bg)] px-3 py-2 rounded-lg text-[var(--color-text-primary)] truncate", children: inviteUrl }), _jsx("button", { onClick: () => copyToClipboard(inviteUrl, invite.token), className: "p-2 bg-[var(--color-bg)] rounded-lg hover:bg-[var(--glass-border)] transition-all", title: "Copy link", children: copiedToken === invite.token ? _jsx(Check, { className: "w-4 h-4 text-green-400" }) : _jsx(Copy, { className: "w-4 h-4 text-[var(--color-text-secondary)]" }) })] }), _jsxs("p", { className: "text-xs text-[var(--color-text-muted)] mt-2", children: ["Uses: ", invite.uses, "/", invite.max_uses, " \u00B7 Created ", formatDate(invite.created_at)] })] }, invite.token));
                                }), invites.length === 0 && (_jsx("p", { className: "text-center text-sm text-[var(--color-text-muted)] py-8", children: "No invites yet. Generate one to invite users." }))] }))] })] }) }));
};
