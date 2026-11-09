/* Mount community features without enabling legacy sample routes.
Todo:
-> reject writes when database, origin or feature configuration is missing
*/
import express, { Router } from 'express';
import { ENV } from '../config/env.js';
import { appOrigin, authRoutes, originAllowed } from './auth.js';
import { communityError, database, InputError } from './db.js';
import { communityCapabilities } from './capabilities.js';
import { createReportRoutes } from './reports.js';
import { adminRoutes } from './admin.js';
import { createAnalysisRoutes, disabledAnalysis, validateAnalysisPolicy, type AnalysisPolicy } from './analyses.js';

export function createCommunityRouter(analysisPolicy: AnalysisPolicy = disabledAnalysis) {
validateAnalysisPolicy(analysisPolicy);
analysisPolicy = Object.freeze({ available: analysisPolicy.available, accountIds: Object.freeze([...analysisPolicy.accountIds]) });
const router = Router();
router.get('/capabilities', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(communityCapabilities(analysisPolicy, req.get('Origin')));
});
router.use(express.json({ limit: '16kb' }));
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!ENV.COMMUNITY_REPORTS_ENABLED) throw new InputError(503, 'Laporan warga belum diaktifkan.');
    database();
    // writes need a configured origin (else 503) and a page on an allowed address (else 403); reads stay open
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      appOrigin();
      if (!originAllowed(req.get('Origin'))) throw new InputError(403, 'Alamat halaman ini belum diizinkan server. Buka LaporJalan lewat alamat resminya.');
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (error) { next(error); }
});
router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/reports/:id/analyses', createAnalysisRoutes(analysisPolicy));
router.use('/reports', createReportRoutes(analysisPolicy));
router.use(communityError);
return router;
}
export default createCommunityRouter();
