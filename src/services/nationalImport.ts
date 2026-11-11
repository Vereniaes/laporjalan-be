/* Todo:
-> turn the public dashboard of Jalan Kita 2.0 (Ditjen Bina Marga, Kementerian PU) into LaporJalan reports (owner choice, 11 Nov: one-time grab, all of Indonesia)
    -> NOTE: the public payload also carries other users' name, email and password. We NEVER keep them.
       mapSafely() reads ONLY point, status, category and time from each row and drops everything else, so no personal field is ever stored.
    -> kept: point, status, time, and the national road-segment name (nama_ruas, not a person). Dropped: description free text, photos, and the whole `userable` object.
    -> only our categories (owner choice): the national source is road/bridge; we keep category "Jalan" as road.
*/
import { createHash } from 'node:crypto';
import { inIndonesia } from '../community/condition.js';

export const NATIONAL_ENDPOINT = 'https://api-jalankita.binamarga.pu.go.id/common/dashboard-chart?laporan=&kerusakan=&penting=&umum=1&page=1&ruas_jalan=jl_nas';

// the dashboard uses a numeric status; these labels match its own legend
const STATUS: Record<string, string> = { Baru: 'Baru', 'Proses verifikasi': 'Proses verifikasi', Terverifikasi: 'Terverifikasi', Selesai: 'Selesai' };

const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const clean = (value: unknown, limit = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
export const nationalRef = (sourceId: string) => createHash('sha256').update(`jalankita:${sourceId}`).digest('hex');

export function nationalStatus(value: unknown) {
  const text = clean(value, 40);
  return STATUS[text] ?? (text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Status belum tersedia');
}

// input param : one row of data.map from the dashboard payload
// output      : ONLY our non-personal report fields, or null when the row is unusable or not our category
//               (this function is the single gate: fields it does not read are never stored)
export function mapNational(value: unknown) {
  const row = record(value);
  // our category only: the national source labels road reports "Jalan"
  if (clean(row.cat_a_name, 40) !== 'Jalan') return null;
  const sourceId = clean(row.id_laporan, 40);
  const point = record(row.location).coordinates;
  const lng = Array.isArray(point) ? Number(point[0]) : NaN, lat = Array.isArray(point) ? Number(point[1]) : NaN;
  const created = new Date(clean(row.created_at, 40).replace(' ', 'T'));
  if (!/^[\w-]{1,40}$/.test(sourceId) || !Number.isFinite(lat) || !Number.isFinite(lng) || !inIndonesia(lng, lat) || !Number.isFinite(created.getTime())) return null;
  // nama_ruas is a national road-segment name (e.g. "Jakarta - Bekasi"), not a person
  const segment = clean(row.nama_ruas, 120);
  return {
    sourceId,
    fields: {
      source: 'jalankita', category: 'road' as const, subcategory: 'Jalan',
      description: '', address: segment, addressDetail: '',
      lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
      createdAt: created, status: nationalStatus(row.status_text), statusSlug: '',
      unit: null, area: { village: null, district: null, city: null }, reporterId: null,
    },
  };
}
