/*
file ini router express buat health check cloud run
google cloud run butuh status 200 ok biar container dianggap sehat
Todo:
-> endpoint GET /health
*/

import { Router } from 'express';
import mongoose from 'mongoose';
import { ENV } from '../config/env.js';

const router = Router();

router.get('/', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected/memory-fallback';
  res.json({
    status: 'ok',
    service: 'laporjalan-be',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mode: ENV.PUBLIC_REPORTS_ONLY ? 'public-reports' : 'legacy',
    community: ENV.COMMUNITY_REPORTS_ENABLED,
    database: ENV.COMMUNITY_REPORTS_ENABLED ? (mongoose.connection.readyState === 1 ? 'connected' : 'disconnected') : ENV.PUBLIC_REPORTS_ONLY ? 'not-used' : dbStatus
  });
});

export default router;
