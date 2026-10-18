/*
file ini entry point server backend laporjalan-be
konek mongodb kalo ada uri-nya, kalo gak ada tetep jalan pake in-memory
Todo:
-> coba konek mongodb dengan timeout pendek
-> listen ke port env (0.0.0.0) buat cloud run
-> handle graceful shutdown
*/

import { initCommunity } from './community/db.js';
import { appOrigin } from './community/auth.js';
import mongoose from 'mongoose';
import { app } from './app.js';
import { ENV } from './config/env.js';
import { ReportModel } from './models/Report.js';
import { CctvModel } from './models/Cctv.js';
import { SEED_REPORTS, SEED_CCTV } from './services/seedData.js';

// helper coba konek mongodb dengan timeout cepat --------------------------------------------------------------------------
async function initDatabase() {
  if (!ENV.MONGODB_URI) {
    console.log('[Database] MONGODB_URI tidak diset. Backend berjalan dalam mode in-memory fallback.');
    return;
  }

  try {
    console.log('[Database] Mencoba menghubungkan ke MongoDB...');
    await mongoose.connect(ENV.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('[Database] Berhasil terhubung ke MongoDB!');

    // seed data awal jika collection masih kosong
    const countReports = await ReportModel.countDocuments();
    if (countReports === 0) {
      console.log('[Database] Melakukan seed data awal laporan jalan...');
      const seedDocs = SEED_REPORTS.map((r) => ({
        reportId: r.id,
        type: r.type,
        title: r.title,
        severity: r.severity,
        depthCm: r.depthCm,
        widthCm: r.widthCm,
        lat: r.lat,
        lng: r.lng,
        address: r.address,
        jurisdiction: r.jurisdiction,
        status: r.status,
        photoUrl: r.photoUrl,
        upScore: r.upScore,
        trafficImpact: r.trafficImpact,
        cctvMatchId: r.cctvMatchId,
        description: r.description
      }));
      await ReportModel.insertMany(seedDocs);
    }

    const countCctv = await CctvModel.countDocuments();
    if (countCctv === 0) {
      console.log('[Database] Melakukan seed data awal kamera CCTV...');
      const seedCctvDocs = SEED_CCTV.map((c) => ({
        cctvId: c.id,
        name: c.name,
        location: c.location,
        lat: c.lat,
        lng: c.lng,
        angle: c.angle,
        fov: c.fov,
        distanceMeters: c.distanceMeters,
        snapshotUrl: c.snapshotUrl,
        lastUpdated: c.lastUpdated,
        status: c.status
      }));
      await CctvModel.insertMany(seedCctvDocs);
    }
  } catch (err: any) {
    console.warn('[Database] Koneksi MongoDB gagal:', err.message);
    console.log('[Database] Berjalan dengan in-memory fallback untuk pengetesan lokal.');
  }
}
// end of helper ------------------------------------------------------------------

// mulai server
async function startServer() {
  if (ENV.COMMUNITY_REPORTS_ENABLED) {
    if (!ENV.PUBLIC_REPORTS_ONLY || !ENV.MONGODB_URI) throw new Error('Community configuration missing');
    appOrigin();
    await mongoose.connect(ENV.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await initCommunity();
  } else if (!ENV.PUBLIC_REPORTS_ONLY) await initDatabase();

  const server = app.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`[LaporJalan Backend] Berjalan aktif di http://0.0.0.0:${ENV.PORT}`);
    console.log(`[LaporJalan Backend] Endpoint Health: http://localhost:${ENV.PORT}/health`);
    console.log(`[LaporJalan Backend] Endpoint Laporan: http://localhost:${ENV.PORT}/api/${ENV.PUBLIC_REPORTS_ONLY ? 'public-reports' : 'reports'}`);
  });

  // graceful shutdown buat container cloud run
  const shutdown = async () => {
    console.log('[LaporJalan Backend] Menerima sinyal shutdown, mematikan server...');
    server.close(async () => {
      if (mongoose.connection.readyState === 1) {
        await mongoose.disconnect();
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch(() => { console.error('[Server] Configuration or database unavailable'); process.exit(1); });
