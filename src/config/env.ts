/*
file ini buat baca config env biar gampang
kalo di cloud run otomatis baca PORT 8080, kalo di lokal pake 5000
Todo:
-> parse port, mongodb uri, sama gcs bucket
-> kasih default value biar gak crash
*/

import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  PUBLIC_REPORTS_ONLY: process.env.PUBLIC_REPORTS_ONLY === 'true',
  COMMUNITY_REPORTS_ENABLED: process.env.COMMUNITY_REPORTS_ENABLED === 'true',
  APP_ORIGIN: process.env.APP_ORIGIN || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || '',
  MONGODB_URI: process.env.MONGODB_URI || '',
  GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || '',
  GCS_BUCKET_NAME: process.env.GCS_BUCKET_NAME || '',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || ''
};
