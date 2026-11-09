/* Todo:
-> handle service liveness probe for Cloud Run
-> report operational mode and database status
*/

import { Router } from 'express';
import mongoose from 'mongoose';
import { ENV } from '../config/env.js';

// --- Health Route -------------------------------------------------------------
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
// --- end of Health Route ------------------------------------------------------
