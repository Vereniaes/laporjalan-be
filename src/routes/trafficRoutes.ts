/*
file ini router express buat endpoint /api/traffic
Todo:
-> daftarkan route GET /
*/

import { Router } from 'express';
import { getTrafficSegments } from '../controllers/trafficController.js';

const router = Router();

router.get('/', getTrafficSegments);

export default router;
