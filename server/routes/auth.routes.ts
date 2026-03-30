import { Router } from 'express';
import { hasUsers, createUser, getUserByUsername, updateUser, deleteUser, updateLastLogin, createInvite, getInvite, isInviteValid, incrementInviteUses } from '../database';
import { hashPassword, verifyPassword, generateToken } from '../services/auth.service';

const router = Router();

// Setup: check if initial admin needs to be created
router.get('/setup/status', async (req, res) => {
  try {
    const usersExist = await hasUsers();
    res.json({ needsSetup: !usersExist, dbConnected: true });
  } catch (error: any) {
    if (error.code === 'ECONNREFUSED') {
      return res.json({ needsSetup: null, dbConnected: false, error: 'Database unavailable' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Setup: complete initial admin creation
router.post('/setup/complete', async (req, res) => {
  const needsSetup = !(await hasUsers());
  if (!needsSetup) {
    return res.status(403).json({ error: 'Setup is already complete.' });
  }

  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 5) {
    return res.status(400).json({ error: 'Invalid username or password. Ensure they are strong.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const user = await createUser(username, passwordHash, 'admin');
    const token = await generateToken({ userId: user.id, username: user.username, role: user.role });
    res.json({ status: 'completed', token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Failed to complete setup:', error);
    res.status(500).json({ error: 'Failed to create admin user.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await updateLastLogin(user.id);
    const token = await generateToken({ userId: user.id, username: user.username, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Register via invite
router.post('/register', async (req, res) => {
  try {
    const { inviteToken, username, password } = req.body;
    if (!inviteToken || !username || !password) {
      return res.status(400).json({ error: 'Invite token, username, and password required' });
    }

    if (username.length < 3 || password.length < 5) {
      return res.status(400).json({ error: 'Username must be 3+ chars, password 5+ chars' });
    }

    const valid = await isInviteValid(inviteToken);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid or expired invite' });
    }

    const invite = await getInvite(inviteToken);
    const existingUser = await getUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(username, passwordHash, invite.role);
    await incrementInviteUses(inviteToken);
    const token = await generateToken({ userId: user.id, username: user.username, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Get current user
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

// Change password
router.post('/change-password', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (newPassword.length < 5) return res.status(400).json({ error: 'New password must be 5+ characters' });

    const user = await getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await hashPassword(newPassword);
    await updateUser(user.id, { passwordHash: newHash });
    res.json({ status: 'changed' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Delete account
router.delete('/delete-account', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to delete account' });

    const user = await getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Don't allow deleting the last admin
    if (user.role === 'admin') {
      const { listUsers } = await import('../database');
      const users = await listUsers();
      const adminCount = users.filter((u: any) => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account' });
      }
    }

    await deleteUser(user.id);
    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Account deletion error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Validate invite token
router.get('/invites/:token/validate', async (req, res) => {
  try {
    const valid = await isInviteValid(req.params.token as string);
    res.json({ valid });
  } catch (error) {
    res.json({ valid: false });
  }
});

export default router;
