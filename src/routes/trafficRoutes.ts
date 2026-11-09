/* Todo:
-> register traffic congestion overlay routes
*/

import { Router } from 'express';
import { getTrafficSegments } from '../controllers/trafficController.js';

// --- Traffic Routes -----------------------------------------------------------
const router = Router();

router.get('/', getTrafficSegments);

export default router;
// --- end of Traffic Routes ----------------------------------------------------
