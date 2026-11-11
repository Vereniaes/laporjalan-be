/* Todo:
-> turn the public map data of Jalan Peduli (Dinas PUPR Kota Samarinda) into LaporJalan reports (owner choice, 11 Nov: beyond Jakarta)
    -> checked 11 Nov: robots.txt allows all; the public map JSON has no name, phone or email fields
    -> kept: point, status, damage level, time. Not kept: the free-text description (may hold personal data) and the photos
    -> the source is not shown on the card (owner choice, 11 Nov); it stays only in `source` for the admin and the importer
*/
import { createHash } from 'node:crypto';
import { inIndonesia } from '../community/condition.js';

export const SAMARINDA_ENDPOINT = 'https://pupr.samarindakota.go.id/jalan-peduli/get-public-map-data';

const STATUS: Record<string, string> = {
  belum_dikerjakan: 'Belum dikerjakan',
  sedang_dikerjakan: 'Sedang dikerjakan',
  telah_dikerjakan: 'Selesai dikerjakan',
  telah_disurvei: 'Telah disurvei',
  disposisi: 'Disposisi',
};
const LEVEL: Record<string, string> = { ringan: 'ringan', sedang: 'sedang', berat: 'berat' };

const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const samarindaRef = (sourceId: string) => createHash('sha256').update(`samarinda:${sourceId}`).digest('hex');

// input param : a status slug from the source, e.g. "belum_dikerjakan"
// output      : a readable label; unknown slugs are spelled out instead of dropped
export function samarindaStatus(slug: unknown) {
  if (typeof slug !== 'string' || !/^[a-z_]{1,40}$/.test(slug)) return 'Status belum tersedia';
  return STATUS[slug] ?? slug.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
}

// input param : one row of the public map JSON
// output      : the fields we store (ids and codes are added by the importer so reruns keep them), or null when the row is unusable
export function mapSamarinda(value: unknown) {
  const row = record(value);
  const sourceId = typeof row.id_laporan === 'string' || typeof row.id_laporan === 'number' ? String(row.id_laporan).trim() : '';
  const lat = Number(row.latitude), lng = Number(row.longitude);
  const created = new Date(row.created_at);
  if (!/^[\w-]{1,40}$/.test(sourceId) || !Number.isFinite(lat) || !Number.isFinite(lng) || !inIndonesia(lng, lat) || !Number.isFinite(created.getTime())) return null;
  const slug = record(row.status).nama_status;
  const level = typeof row.tingkat_kerusakan === 'string' ? LEVEL[row.tingkat_kerusakan.trim().toLowerCase()] : undefined;
  return {
    sourceId,
    fields: {
      source: 'samarinda', category: 'road' as const, subcategory: 'Jalan',
      // our own sentence from a structured field, never the reporter's free text
      description: level ? `Tingkat kerusakan ${level}.` : '', address: '', addressDetail: '',
      lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
      createdAt: created, status: samarindaStatus(slug), statusSlug: typeof slug === 'string' ? slug : '',
      unit: null, area: { village: null, district: null, city: 'Samarinda' }, reporterId: null,
    },
  };
}
