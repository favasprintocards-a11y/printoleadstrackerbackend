import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { connectDB } from './connection.js';
import User from '../models/User.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

export async function seedDatabase() {
  console.log('--- Seeding Database ---');

  // Read admin credentials from environment variables
  const adminName = process.env.ADMIN_NAME || 'Administrator';
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPhone = process.env.ADMIN_PHONE;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPass || !adminPhone) {
    console.error(
      '❌ Seed skipped: ADMIN_EMAIL, ADMIN_PHONE, and ADMIN_PASSWORD must be set in your .env file.'
    );
    return;
  }

  await connectDB();

  const existing = await User.findOne({ email: adminEmail.toLowerCase().trim() });

  if (!existing) {
    const hashedPassword = await bcrypt.hash(adminPass, 10);
    await User.create({
      name: adminName.trim(),
      email: adminEmail.toLowerCase().trim(),
      password: hashedPassword,
      role: 'admin',
      phone: adminPhone.trim(),
      is_active: true
    });
    console.log(`✓ Created admin user: ${adminName} (${adminEmail})`);
  } else {
    console.log(`✓ Admin user already exists: ${existing.email}`);
  }

  console.log('--- Database Seeding Complete ---');
}

// Run if called directly: node seed.js
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
