/*
file ini controller buat urus api laporan kerusakan jalan
bisa get list, submit laporan baru + upload foto, sama update status perbaikan dinas
Todo:
-> dual-mode: baca dari mongodb kalo ada, kalo belum ada pake in-memory
-> hitung skor up bina marga otomatis
-> routing yuridis jalan nasional vs provinsi vs kota
*/

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { ReportModel } from '../models/Report.js';
import { IDamageReport, JurisdictionType } from '../models/types.js';
import { SEED_REPORTS } from '../services/seedData.js';
import { saveUploadedFile } from '../services/storage.js';

// data fallback in-memory jika mongodb belum tersambung
let memoryReports: IDamageReport[] = [...SEED_REPORTS];

// helper cek apakah mongodb aktif --------------------------------------------------------------------------
function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
// end of helper ------------------------------------------------------------------

// helper hitung skor urutan prioritas bina marga --------------------------------------------------------------------------
// input param : kedalaman cm, tingkat keparahan, jenis kerusakan
// output : skor angka 1 - 10
function calculateUpScore(depthCm: number, severity: string, type: string): number {
  let score = 4.0;
  if (severity === 'berat') score += 4.0;
  else if (severity === 'sedang') score += 2.0;

  if (depthCm > 5) score += 1.0;
  if (type === 'pothole' || type === 'trench') score += 0.5;

  return Math.min(10.0, Math.round(score * 10) / 10);
}
// end of helper ------------------------------------------------------------------

// GET /api/reports - ambil semua laporan jalan
export async function getReports(req: Request, res: Response) {
  try {
    const { type, severity, jurisdiction } = req.query;

    if (isDbConnected()) {
      const query: any = {};
      if (type) query.type = type;
      if (severity) query.severity = severity;
      if (jurisdiction) query.jurisdiction = jurisdiction;

      const docs = await ReportModel.find(query).sort({ createdAt: -1 });
      const mapped = docs.map((d) => ({
        id: d.reportId,
        type: d.type,
        title: d.title,
        severity: d.severity,
        depthCm: d.depthCm,
        widthCm: d.widthCm,
        lat: d.lat,
        lng: d.lng,
        address: d.address,
        jurisdiction: d.jurisdiction,
        status: d.status,
        photoUrl: d.photoUrl,
        createdAt: (d as any).createdAt ? new Date((d as any).createdAt).toLocaleTimeString() : 'Baru saja',
        upScore: d.upScore,
        trafficImpact: d.trafficImpact,
        cctvMatchId: d.cctvMatchId,
        description: d.description
      }));
      return res.json({ success: true, count: mapped.length, data: mapped });
    }

    // fallback memory
    let filtered = [...memoryReports];
    if (type) filtered = filtered.filter((r) => r.type === type);
    if (severity) filtered = filtered.filter((r) => r.severity === severity);
    if (jurisdiction) filtered = filtered.filter((r) => r.jurisdiction === jurisdiction);

    return res.json({ success: true, count: filtered.length, data: filtered });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal memuat laporan' });
  }
}

// GET /api/reports/:id - ambil satu detail laporan
export async function getReportById(req: Request, res: Response) {
  try {
    const { id } = req.params;

    if (isDbConnected()) {
      const doc = await ReportModel.findOne({ reportId: id });
      if (!doc) {
        return res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
      }
      return res.json({ success: true, data: doc });
    }

    const found = memoryReports.find((r) => r.id === id);
    if (!found) {
      return res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
    }
    return res.json({ success: true, data: found });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal memuat laporan' });
  }
}

// POST /api/reports - submit laporan kerusakan jalan baru
export async function createReport(req: Request, res: Response) {
  try {
    const {
      type = 'pothole',
      title,
      severity = 'sedang',
      depthCm = 4.0,
      widthCm = 35.0,
      lat = -6.1965,
      lng = 106.8232,
      address = 'Jl. Jend. Sudirman, Jakarta',
      jurisdiction,
      description = ''
    } = req.body;

    // handle foto upload atau url string
    let photoUrl = req.body.photoUrl || 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80';
    if (req.file) {
      photoUrl = await saveUploadedFile(req.file);
    }

    const numDepth = parseFloat(depthCm);
    const numWidth = parseFloat(widthCm);
    const numLat = parseFloat(lat);
    const numLng = parseFloat(lng);

    // auto-routing wewenang jalan jika tidak diberikan
    let autoJurisdiction: JurisdictionType = jurisdiction;
    if (!autoJurisdiction) {
      autoJurisdiction = numDepth > 5
        ? 'Jalan Nasional (BBPJN PUPR)'
        : 'Jalan Provinsi (Bina Marga DKI)';
    }

    const upScore = calculateUpScore(numDepth, severity, type);
    const newId = `rep-${Date.now()}`;

    const reportData: IDamageReport = {
      id: newId,
      type,
      title: title || `${type.toUpperCase()} Terdeteksi AI`,
      severity,
      depthCm: numDepth,
      widthCm: numWidth,
      lat: numLat,
      lng: numLng,
      address,
      jurisdiction: autoJurisdiction,
      status: 'review',
      photoUrl,
      createdAt: 'Baru saja',
      upScore,
      trafficImpact: numDepth > 5 ? 'padat' : 'lancar',
      description
    };

    if (isDbConnected()) {
      await ReportModel.create({
        reportId: newId,
        type: reportData.type,
        title: reportData.title,
        severity: reportData.severity,
        depthCm: reportData.depthCm,
        widthCm: reportData.widthCm,
        lat: reportData.lat,
        lng: reportData.lng,
        address: reportData.address,
        jurisdiction: reportData.jurisdiction,
        status: reportData.status,
        photoUrl: reportData.photoUrl,
        upScore: reportData.upScore,
        trafficImpact: reportData.trafficImpact,
        description: reportData.description
      });
    } else {
      memoryReports.unshift(reportData);
    }

    return res.status(201).json({
      success: true,
      message: 'Laporan kerusakan jalan berhasil diterima',
      data: reportData
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal menyimpan laporan' });
  }
}

// PATCH /api/reports/:id/status - update status penanganan dinas
export async function updateReportStatus(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['review', 'verified', 'scheduled', 'fixed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status tidak valid' });
    }

    if (isDbConnected()) {
      const updated = await ReportModel.findOneAndUpdate(
        { reportId: id },
        { status },
        { new: true }
      );
      if (!updated) {
        return res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
      }
      return res.json({ success: true, message: 'Status diperbarui', data: updated });
    }

    const idx = memoryReports.findIndex((r) => r.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
    }

    memoryReports[idx].status = status;
    return res.json({ success: true, message: 'Status diperbarui', data: memoryReports[idx] });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal memperbarui status' });
  }
}
