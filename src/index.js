import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import leadRoutes from './routes/lead.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import { connectDB } from './db/connection.js';

const app = express();
const PORT = process.env.PORT || 5000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enable CORS for frontend development
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsers
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Request Logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.originalUrl.startsWith('/api')) {
      console.log(`[${req.method}] ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// API Routes (Mounted on both /api/* and root /* for seamless compatibility)
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Support direct calls without /api prefix
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/leads', leadRoutes);
app.use('/dashboard', dashboardRoutes);

// Health check endpoint
app.get(['/api/health', '/health'], (req, res) => {
  res.json({
    status: 'ok',
    system: 'Lead Management System API',
    timestamp: new Date().toISOString()
  });
});

// ── Serve React frontend (production build) ──────────────────────────────────
const candidatePaths = [
  path.resolve(__dirname, '../../client/dist'),
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(process.cwd(), '../client/dist')
];

const clientDist = candidatePaths.find(p => fs.existsSync(path.join(p, 'index.html')));

if (clientDist) {
  console.log(`📦 Serving React frontend from: ${clientDist}`);
  app.use(express.static(clientDist));
  // SPA fallback — all non-API GET routes return index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  console.log('ℹ️ No frontend client/dist found — running in API-only mode');

  // Friendly API root endpoint
  app.get('/', (req, res) => {
    res.json({
      name: 'Printo Meta Leads Tracker API',
      status: 'online',
      timestamp: new Date().toISOString(),
      health: '/api/health',
      endpoints: {
        auth: '/api/auth/login',
        leads: '/api/leads',
        dashboard: '/api/dashboard/stats',
        users: '/api/users'
      }
    });
  });

  // Catch-all for other unmatched routes
  app.use((req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// Connect to Database and start server
async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Lead Management API Server running`);
    console.log(`   Port: ${PORT}`);
    console.log(`   URL:  http://localhost:${PORT}`);
    console.log(`=========================================`);
  });
}

startServer();
