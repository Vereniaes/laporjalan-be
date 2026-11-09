/* Todo:
-> define Mongoose schema for legacy damage reports collection
-> index coordinates and report identifiers
*/

import mongoose, { Schema, Document } from 'mongoose';
import { IDamageReport } from './types.js';

// --- Report Schema ------------------------------------------------------------
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
// --- end of Report Schema -----------------------------------------------------
