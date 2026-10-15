/*
file ini isinya definisi types buat data backend
biar format laporan kerusakan sama kamera cctv konsisten sama frontend
Todo:
-> bikin types jenis kerusakan, tingkat keparahan, status dinas
-> samain tipe data koordinat lat lng
*/

export type DamageType = 'pothole' | 'crack' | 'trench' | 'subsidence';
export type DamageSeverity = 'ringan' | 'sedang' | 'berat';
export type JurisdictionType = 
  | 'Jalan Nasional (BBPJN PUPR)'
  | 'Jalan Provinsi (Bina Marga DKI)'
  | 'Jalan Kota (Dinas PU Kota)';

export type ReportStatus = 'review' | 'verified' | 'scheduled' | 'fixed';

export interface IDamageReport {
  id: string;
  type: DamageType;
  title: string;
  severity: DamageSeverity;
  depthCm: number;
  widthCm: number;
  lat: number;
  lng: number;
  address: string;
  jurisdiction: JurisdictionType;
  status: ReportStatus;
  photoUrl: string;
  createdAt: string;
  upScore: number;
  trafficImpact: 'lancar' | 'padat' | 'macet';
  cctvMatchId?: string;
  description: string;
}

export interface ICctvCamera {
  id: string;
  name: string;
  location: string;
  lat: number;
  lng: number;
  angle: number;
  fov: number;
  distanceMeters: number;
  snapshotUrl: string;
  lastUpdated: string;
  status: 'online' | 'maintenance';
}

export interface ITrafficSegment {
  id: string;
  roadName: string;
  status: 'lancar' | 'padat' | 'macet';
  speedKmh: number;
  coordinates: [number, number][];
}
