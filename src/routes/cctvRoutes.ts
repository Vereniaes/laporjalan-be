/* Todo:
-> register CCTV camera stream and telemetry routes
*/

import { Router } from 'express';
import { getCctvList } from '../controllers/cctvController.js';

// --- CCTV Routes --------------------------------------------------------------
const router = Router();

router.get('/', getCctvList);

export default router;
// --- end of CCTV Routes -------------------------------------------------------
