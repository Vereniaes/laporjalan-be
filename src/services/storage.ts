/*
file ini buat adapter upload foto jalan ke google cloud storage (gcs)
kalo gcs bucket belum diisi di env, otomatis fallback simpen ke folder /uploads lokal
Todo:
-> handle upload file via multer
-> kirim stream ke gcs kalo ada kredensial gcp
-> fallback tulis berkas ke disk lokal kalo testing offline
*/

import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { ENV } from '../config/env.js';

// inisialisasi storage client gcp jika bucket diset
let gcsStorage: Storage | null = null;
if (ENV.GCS_BUCKET_NAME) {
  try {
    gcsStorage = new Storage({
      projectId: ENV.GCP_PROJECT_ID || undefined
    });
  } catch (err) {
    console.warn('[Storage] GCS client init warning, fallback ke local storage');
  }
}

// pastikan folder uploads lokal ada
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// multer pake memory storage biar buffer gampang dipindah ke gcs atau disk
export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // limit 10MB
});

// helper simpan buffer foto ke storage --------------------------------------------------------------------------
// input param : buffer file, nama file asli, mimetype
// output : public url string buat disimpan di database
export async function saveUploadedFile(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = `road-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;

  // 1. jika ada gcs bucket, upload ke gcs
  if (gcsStorage && ENV.GCS_BUCKET_NAME) {
    try {
      const bucket = gcsStorage.bucket(ENV.GCS_BUCKET_NAME);
      const gcsFile = bucket.file(filename);

      await gcsFile.save(file.buffer, {
        metadata: { contentType: file.mimetype }
      });

      return `https://storage.googleapis.com/${ENV.GCS_BUCKET_NAME}/${filename}`;
    } catch (gcsErr) {
      console.warn('[Storage] Upload ke GCS gagal, beralih ke simpan lokal:', gcsErr);
    }
  }

  // 2. fallback simpan ke disk lokal
  const localFilePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(localFilePath, file.buffer);
  return `/uploads/${filename}`;
}
// end of helper ------------------------------------------------------------------
