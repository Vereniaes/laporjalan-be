/* Todo:
-> handle traffic speed and congestion segment queries
*/

import { Request, Response } from 'express';
import { ITrafficSegment } from '../models/types.js';
import { SEED_TRAFFIC } from '../services/seedData.js';

let memoryTraffic: ITrafficSegment[] = [...SEED_TRAFFIC];

// --- Traffic Handlers ---------------------------------------------------------
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
// --- end of Traffic Handlers --------------------------------------------------
