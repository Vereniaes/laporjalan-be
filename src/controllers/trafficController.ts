/*
file ini controller buat arus kemacetan jalan real-time
ngembaliin segmen koordinat jalan thamrin sudirman sama status kecepatan kmh
Todo:
-> endpoint get list segmen arus lalu lintas
*/

import { Request, Response } from 'express';
import { ITrafficSegment } from '../models/types.js';
import { SEED_TRAFFIC } from '../services/seedData.js';

let memoryTraffic: ITrafficSegment[] = [...SEED_TRAFFIC];

// GET /api/traffic - ambil data segmen arus kemacetan
export async function getTrafficSegments(req: Request, res: Response) {
  try {
    return res.json({
      success: true,
      count: memoryTraffic.length,
      data: memoryTraffic
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal memuat data macet' });
  }
}
