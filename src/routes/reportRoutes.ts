/*
file ini router express buat endpoint /api/reports
Todo:
-> daftarkan route GET, POST (dengan multer), dan PATCH
*/

import { Router } from 'express';
import { 
  getReports, 
  getReportById, 
  createReport, 
  updateReportStatus 
} from '../controllers/reportController.js';
import { uploadMiddleware } from '../services/storage.js';

const router = Router();

router.get('/', getReports);
router.get('/:id', getReportById);
router.post('/', uploadMiddleware.single('photo'), createReport);
router.patch('/:id/status', updateReportStatus);

export default router;
