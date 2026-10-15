/*
file ini router express buat endpoint /api/cctv
Todo:
-> daftarkan route GET /
*/

import { Router } from 'express';
import { getCctvList } from '../controllers/cctvController.js';

const router = Router();

router.get('/', getCctvList);

export default router;
