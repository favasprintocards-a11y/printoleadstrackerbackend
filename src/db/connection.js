import mongoose from 'mongoose';
import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Ensure .env is loaded regardless of working directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // fallback

// Set public DNS servers for MongoDB Atlas SRV query resolution
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {
  // Ignore if not permitted
}

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error('MONGODB_URI is not defined in environment variables.');
}

export async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: 'printo_leads',
      serverSelectionTimeoutMS: 15000,
    });
    console.log('✅ MongoDB connected successfully to database: printo_leads');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

export default mongoose;

