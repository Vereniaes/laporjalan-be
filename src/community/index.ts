/* Mount community features without enabling legacy sample routes.
Todo:
-> reject writes when database, origin or feature configuration is missing
*/
import express, { Router } from 'express';
import { ENV } from '../config/env.js';
import { appOrigin, authRoutes } from './auth.js';
import { communityError, database, InputError } from './db.js';
import { reportRoutes } from './reports.js';

const router = Router();
router.use(express.json({ limit: '16kb' }));
router.use((req, res, next) => {
  try {
    if (!ENV.COMMUNITY_REPORTS_ENABLED) throw new InputError(503, 'Laporan warga belum diaktifkan.');
    database();
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('Origin') !== appOrigin()) throw new InputError(403, 'Asal permintaan tidak diizinkan.');
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (error) { next(error); }
});
router.use('/auth', authRoutes);
router.use('/reports', reportRoutes);
router.use(communityError);
export default router;
