/* Todo:
-> configure Express middlewares (CORS, body parser, static uploads)
-> mount API routes, documentation index, and global error handlers
*/

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { ENV } from './config/env.js';
import healthRoutes from './routes/healthRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import cctvRoutes from './routes/cctvRoutes.js';
import trafficRoutes from './routes/trafficRoutes.js';
import placesRoutes from './routes/placesRoutes.js';
import communityRoutes from './community/index.js';
import { originAllowed } from './community/auth.js';
import publicReportRoutes from './routes/publicReportRoutes.js';

// --- Express Application ------------------------------------------------------
export const app = express();

// CORS follows the write rule: the listed origins (CORS_ORIGIN, comma-separated, or *), plus any local address in development
// Why/Note: a page on 127.0.0.1 or another dev port could not even read /capabilities, so sign-in looked disabled
const corsOrigins = ENV.CORS_ORIGIN.split(',').map(value => value.trim()).filter(Boolean);
const corsAllowed = (origin: string) => { try { return originAllowed(origin); } catch { return false; } };
app.use(cors({ origin: corsOrigins.includes('*') ? '*' : (origin, done) => done(null, !origin || corsOrigins.includes(origin) || corsAllowed(origin)) }));
app.use('/api/community', communityRoutes);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// serve folder uploads lokal
if (!ENV.PUBLIC_REPORTS_ONLY) app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// routes
app.use('/health', healthRoutes);
app.use('/api/public-reports', publicReportRoutes);
if (!ENV.PUBLIC_REPORTS_ONLY) {
  app.use('/api/reports', reportRoutes);
  app.use('/api/cctv', cctvRoutes);
  app.use('/api/traffic', trafficRoutes);
  app.use('/api/places', placesRoutes);
}

// root route info
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'LaporJalan API',
    mode: ENV.PUBLIC_REPORTS_ONLY ? 'public-reports' : 'legacy',
    docs: ENV.PUBLIC_REPORTS_ONLY ? { health: '/health', publicReports: '/api/public-reports' } : {
      health: '/health',
      publicReports: '/api/public-reports',
      reports: '/api/reports',
      cctv: '/api/cctv',
      traffic: '/api/traffic'
    }
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan' });
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[App Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Terjadi kesalahan internal server'
  });
});
// --- end of Express Application -----------------------------------------------
