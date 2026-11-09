/* Todo:
-> register damage report routes (GET, POST with upload, PATCH status)
*/

import { Router } from 'express';
import { 
  getReports, 
  getReportById, 
  createReport, 
  updateReportStatus 
} from '../controllers/reportController.js';
import { uploadMiddleware } from '../services/storage.js';

// --- Report Routes ------------------------------------------------------------
const router = Router();

router.get('/', getReports);
router.get('/:id', getReportById);
router.post('/', uploadMiddleware.single('photo'), createReport);
router.patch('/:id/status', updateReportStatus);

export default router;
// --- end of Report Routes -----------------------------------------------------
