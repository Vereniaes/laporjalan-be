/*
file ini controller buat urus data kamera cctv lalu lintas
ngembaliin list kamera, sudut hadap kerucut fov, sama jarak jangkauan
Todo:
-> endpoint get list cctv
-> cari cctv terdekat dari titik gps laporan
*/

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { CctvModel } from '../models/Cctv.js';
import { ICctvCamera } from '../models/types.js';
import { SEED_CCTV } from '../services/seedData.js';

let memoryCctv: ICctvCamera[] = [...SEED_CCTV];

function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

// GET /api/cctv - ambil daftar semua kamera cctv
export async function getCctvList(req: Request, res: Response) {
  try {
    if (isDbConnected()) {
      const docs = await CctvModel.find();
      if (docs.length > 0) {
        const mapped = docs.map((d) => ({
          id: d.cctvId,
          name: d.name,
          location: d.location,
          lat: d.lat,
          lng: d.lng,
          angle: d.angle,
          fov: d.fov,
          distanceMeters: d.distanceMeters,
          snapshotUrl: d.snapshotUrl,
          lastUpdated: d.lastUpdated,
          status: d.status
        }));
        return res.json({ success: true, count: mapped.length, data: mapped });
      }
    }

    return res.json({ success: true, count: memoryCctv.length, data: memoryCctv });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal memuat CCTV' });
  }
}
