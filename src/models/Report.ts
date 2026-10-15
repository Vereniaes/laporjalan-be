/*
file ini skema mongoose buat tabel laporan kerusakan jalan di mongodb
nyimpen id laporan, jenis jalan, kedalaman cm, foto, sama status penanganan dinas
Todo:
-> definisikan schema mongoose buat collection reports
-> kasih index geospatial di lat dan lng biar query spasial cepet
*/

import mongoose, { Schema, Document } from 'mongoose';
import { IDamageReport } from './types.js';

export interface ReportDocument extends Omit<IDamageReport, 'id'>, Document {
  reportId: string;
}

const ReportSchema = new Schema<ReportDocument>(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    type: { 
      type: String, 
      enum: ['pothole', 'crack', 'trench', 'subsidence'], 
      required: true 
    },
    title: { type: String, required: true },
    severity: { 
      type: String, 
      enum: ['ringan', 'sedang', 'berat'], 
      required: true 
    },
    depthCm: { type: Number, required: true },
    widthCm: { type: Number, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String, required: true },
    jurisdiction: { 
      type: String, 
      enum: [
        'Jalan Nasional (BBPJN PUPR)', 
        'Jalan Provinsi (Bina Marga DKI)', 
        'Jalan Kota (Dinas PU Kota)'
      ], 
      required: true 
    },
    status: { 
      type: String, 
      enum: ['review', 'verified', 'scheduled', 'fixed'], 
      default: 'review' 
    },
    photoUrl: { type: String, required: true },
    upScore: { type: Number, default: 5.0 },
    trafficImpact: { 
      type: String, 
      enum: ['lancar', 'padat', 'macet'], 
      default: 'lancar' 
    },
    cctvMatchId: { type: String },
    description: { type: String, default: '' }
  },
  {
    timestamps: true
  }
);

export const ReportModel = mongoose.model<ReportDocument>('Report', ReportSchema);
