/*
file ini skema mongoose buat kamera cctv pengawas jalan raya di mongodb
nyimpen posisi gps, sudut hadap kamera, lebar fov, sama link live snapshot
Todo:
-> definisikan schema mongoose buat collection cctvs
*/

import mongoose, { Schema, Document } from 'mongoose';
import { ICctvCamera } from './types.js';

export interface CctvDocument extends Omit<ICctvCamera, 'id'>, Document {
  cctvId: string;
}

const CctvSchema = new Schema<CctvDocument>(
  {
    cctvId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    location: { type: String, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    angle: { type: Number, required: true },
    fov: { type: Number, required: true },
    distanceMeters: { type: Number, required: true },
    snapshotUrl: { type: String, required: true },
    lastUpdated: { type: String, default: 'Baru saja' },
    status: { type: String, enum: ['online', 'maintenance'], default: 'online' }
  },
  {
    timestamps: true
  }
);

export const CctvModel = mongoose.model<CctvDocument>('Cctv', CctvSchema);
