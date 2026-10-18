/*
file ini inisialisasi aplikasi express
pasang middleware cors, parser json, serve folder uploads, sama mount routes
Todo:
-> konfigurasi middleware cors dan body parser
-> serve folder /uploads secara statis
-> pasang routes api dan error handler
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
import publicReportRoutes from './routes/publicReportRoutes.js';

export const app = express();

// middleware dasar
app.use(cors({ origin: ENV.CORS_ORIGIN }));
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

// global error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[App Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Terjadi kesalahan internal server'
  });
});
