import User from '../models/User.js';

/**
 * Normalize a phone number to standard format with country code if 10 digits
 */
export function normalizeUserPhone(phone) {
  if (!phone) return '';
  const clean = String(phone).trim();
  const digits = clean.replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (clean.startsWith('+')) return '+' + digits;
  return digits || clean;
}

/**
 * Find user by phone or email — handles different phone formats
 */
export async function findUserByPhoneOrEmail(identifier) {
  if (!identifier) return null;
  const clean = String(identifier).trim();
  const digits = clean.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

  // Try email first
  if (clean.includes('@')) {
    const byEmail = await User.findOne({ email: clean.toLowerCase() });
    if (byEmail) return byEmail;
  }

  // Load all users and match by phone digits
  const allUsers = await User.find({});
  for (const u of allUsers) {
    if (!u.phone) continue;
    const uDigits = String(u.phone).replace(/\D/g, '');
    const uLast10 = uDigits.length >= 10 ? uDigits.slice(-10) : uDigits;
    if (uDigits === digits || (last10.length === 10 && uLast10 === last10)) {
      return u;
    }
  }
  return null;
}

/**
 * Check if a phone number is already registered to another user
 */
export async function findUserByPhone(phone, excludeUserId = null) {
  if (!phone) return null;
  const clean = String(phone).trim();
  const digits = clean.replace(/\D/g, '');
  if (!digits || digits.length < 7) return null;
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

  const query = excludeUserId ? { _id: { $ne: excludeUserId } } : {};
  const allUsers = await User.find(query);
  for (const u of allUsers) {
    if (!u.phone) continue;
    const uDigits = String(u.phone).replace(/\D/g, '');
    const uLast10 = uDigits.length >= 10 ? uDigits.slice(-10) : uDigits;
    if (uDigits === digits || (last10.length === 10 && uLast10 === last10)) {
      return u;
    }
  }
  return null;
}
