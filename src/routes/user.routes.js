import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { findUserByPhone, normalizeUserPhone } from '../utils/authHelper.js';

const router = express.Router();
router.use(authenticate, requireAdmin);

/**
 * GET /api/users
 */
router.get('/', async (req, res) => {
  try {
    const users = await User.find().sort({ role: 1, name: 1 }).select('-password');

    const usersWithCounts = await Promise.all(users.map(async (u) => {
      const uid = u._id;
      const assigned_leads_count = await Lead.countDocuments({ assigned_to: uid });
      const won_leads_count = await Lead.countDocuments({ assigned_to: uid, status: 'Won' });
      return {
        ...u.toJSON(),
        assigned_leads_count,
        won_leads_count
      };
    }));

    return res.json({ users: usersWithCounts });
  } catch (err) {
    console.error('Fetch users error:', err);
    return res.status(500).json({ error: 'Failed to retrieve users.' });
  }
});

/**
 * POST /api/users
 */
router.post('/', async (req, res) => {
  try {
    const { name, email, password, role = 'sales', phone } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Name, mobile number, and password are required.' });
    }

    if (!['admin', 'sales'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role specified.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existingPhone = await findUserByPhone(phone.trim());
    if (existingPhone) {
      return res.status(400).json({ error: 'A user with this mobile number already exists.' });
    }

    const normalizedPhone = normalizeUserPhone(phone.trim());

    let cleanEmail = email && email.trim() ? email.trim().toLowerCase() : null;
    if (cleanEmail) {
      const existing = await User.findOne({ email: cleanEmail });
      if (existing) {
        return res.status(400).json({ error: 'A user with this email address already exists.' });
      }
    } else {
      cleanEmail = `${normalizedPhone.replace(/\D/g, '') || Date.now()}@printo.local`;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      name: name.trim(),
      email: cleanEmail,
      password: hashedPassword,
      role,
      phone: normalizedPhone,
      is_active: true
    });

    const { password: _, ...userOut } = newUser.toJSON();
    return res.status(201).json({ message: 'User created successfully.', user: userOut });
  } catch (err) {
    console.error('Create user error:', err);
    return res.status(500).json({ error: 'Failed to create user.' });
  }
});

/**
 * PUT /api/users/:id
 */
router.put('/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, email, role, phone } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (role && !['admin', 'sales'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role specified.' });
    }

    if (phone !== undefined && phone && phone.trim()) {
      const duplicate = await findUserByPhone(phone.trim(), userId);
      if (duplicate) {
        return res.status(400).json({ error: 'Mobile number is already used by another user.' });
      }
      user.phone = normalizeUserPhone(phone.trim());
    }

    if (email && email.trim()) {
      const cleanEmail = email.trim().toLowerCase();
      const existing = await User.findOne({ email: cleanEmail, _id: { $ne: userId } });
      if (existing) {
        return res.status(400).json({ error: 'Email is already used by another user.' });
      }
      user.email = cleanEmail;
    }

    if (name) user.name = name.trim();
    if (role) user.role = role;

    await user.save();
    const { password: _, ...userOut } = user.toJSON();
    return res.json({ message: 'User updated successfully.', user: userOut });
  } catch (err) {
    console.error('Update user error:', err);
    return res.status(500).json({ error: 'Failed to update user.' });
  }
});

/**
 * PATCH /api/users/:id/toggle-status
 */
router.patch('/:id/toggle-status', async (req, res) => {
  try {
    const userId = req.params.id;

    if (userId === req.user._id.toString()) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    user.is_active = !user.is_active;
    await user.save();

    return res.json({
      message: `User ${user.is_active ? 'activated' : 'deactivated'} successfully.`,
      is_active: user.is_active
    });
  } catch (err) {
    console.error('Toggle user status error:', err);
    return res.status(500).json({ error: 'Failed to change user status.' });
  }
});

/**
 * POST /api/users/:id/reset-password
 */
router.post('/:id/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.json({ message: 'User password reset successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
});

/**
 * DELETE /api/users/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { reassign_to } = req.body || {};

    if (userId === req.user._id.toString()) {
      return res.status(400).json({ error: 'You cannot delete your own administrator account.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const leadCount = await Lead.countDocuments({ assigned_to: userId });

    if (reassign_to) {
      const targetUser = await User.findById(reassign_to);
      if (!targetUser) return res.status(400).json({ error: 'Reassignment target user does not exist.' });

      await Lead.updateMany(
        { assigned_to: userId },
        { $addToSet: { assigned_to: reassign_to }, $pull: { assigned_to: userId } }
      );
    } else {
      await Lead.updateMany(
        { assigned_to: userId },
        { $pull: { assigned_to: userId } }
      );
    }

    await LeadActivity.updateMany({ user_id: userId }, { $set: { user_id: null } });
    await User.findByIdAndDelete(userId);

    return res.json({
      message: `User "${user.name}" has been deleted successfully.${leadCount > 0 ? (reassign_to ? ' Assigned leads have been reassigned.' : ' Assigned leads are now unassigned.') : ''}`
    });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});

export default router;
