/* Todo:
-> handle multipart file upload storage
-> upload buffer to Google Cloud Storage or fallback to local disk
*/

import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { ENV } from '../config/env.js';

// --- Storage Adapter ----------------------------------------------------------
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

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Purpose : Save uploaded photo buffer to GCS bucket or local uploads directory
// Input   : file (Express.Multer.File)
// Output  : Promise<string> (public URL or relative path)
// Why/Note: Falls back to local disk if GCS bucket is unreachable or unconfigured
export async function saveUploadedFile(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = `road-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;

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

  const localFilePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(localFilePath, file.buffer);
  return `/uploads/${filename}`;
}
// --- end of Storage Adapter ---------------------------------------------------
