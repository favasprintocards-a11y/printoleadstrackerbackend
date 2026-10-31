import bcrypt from 'bcryptjs';
import { connectDB } from '../db/connection.js';
import User from '../models/User.js';
import Lead from '../models/Lead.js';

async function main() {
  await connectDB();

  const reps = [
    { name: 'Rajesh Kumar', email: 'rajesh@printo.local', phone: '+919811223344' },
    { name: 'Sarah Jenkins', email: 'sarah@printo.local', phone: '+919822334455' }
  ];
  const hash = await bcrypt.hash('Sales@123', 10);
  for (const r of reps) {
    const exists = await User.findOne({ phone: r.phone });
    if (!exists) {
      const u = await User.create({
        name: r.name,
        email: r.email,
        password: hash,
        role: 'sales',
        phone: r.phone,
        is_active: true
      });
      console.log('Added sales rep:', r.name, 'id:', u._id);
    }
  }

  const salesUsers = await User.find({ role: 'sales' });
  for (const u of salesUsers) {
    const total = await Lead.countDocuments({ assigned_to: u._id });
    const won = await Lead.countDocuments({ assigned_to: u._id, status: 'Won' });
    console.log(`Rep: ${u.name} | Total Leads: ${total} | Won: ${won}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
