/* Todo:
-> turn public CRM records into LaporJalan reports (owner choice, 10 Nov: the imported data is the map's data)
    -> only our categories (strict map), random ids, the source never named in what we store for display
    -> no personal data: reporter names become a random pseudonymous id; phone, email and NIK in text are masked
    -> no photos
*/
import { createHmac, randomBytes, randomUUID, createHash } from 'node:crypto';

export type OurCategory = 'road' | 'construction' | 'drain' | 'burning';
export interface ImportedHistory { at: Date; status: string; unit: string | null; role: string | null; note: string }
export interface ImportedReport {
  _id: string; code: string; sourceRef: string; reporterId: string | null;
  category: OurCategory; subcategory: string; description: string; address: string; addressDetail: string;
  lat: number; lng: number; createdAt: Date; updatedAt: Date; status: string; statusSlug: string;
  unit: string | null; area: { village: string | null; district: string | null; city: string | null };
  history: ImportedHistory[]; importedAt: Date;
}

// --- category label (strict, owner choice) ---
const STRICT: Record<string, OurCategory> = {
  'Jalan': 'road',
  'Keluhan Galian/Sisa Proyek': 'construction',
  'Gangguan dan/atau Sisa Proyek': 'construction',
  'Saluran Air, Kali/Sungai': 'drain',
  'Tutup Saluran': 'drain',
};
const BURNING_SOURCES = new Set(['Sampah', 'Pencemaran Lingkungan']);
const BURNING_WORDS = /\b(?:di|mem|ter)?bakar\w*|\bpembakaran\b/i;

// input param : the source category name and the report text
// output      : our category, or null when the report is not ours
export function labelCategory(sourceCategory: unknown, content: unknown): OurCategory | null {
  if (typeof sourceCategory !== 'string') return null;
  if (STRICT[sourceCategory]) return STRICT[sourceCategory];
  if (BURNING_SOURCES.has(sourceCategory) && typeof content === 'string' && BURNING_WORDS.test(content)) return 'burning';
  return null;
}
// --- end of category label ---

// --- text cleaning ---
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+62|62|0)[\s.-]?8(?:[\s.-]?\d){7,11}/g;
const NIK_OR_LONG_NUMBER = /\b\d{12,}\b/g;
const MASK = '[disamarkan]';

// input param : free text from a report or a history comment
// output      : trimmed text with personal contact numbers masked, at most `limit` characters
export function cleanText(value: unknown, limit = 4000) {
  if (typeof value !== 'string') return '';
  return value.replace(EMAIL, MASK).replace(PHONE, MASK).replace(NIK_OR_LONG_NUMBER, MASK)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, limit);
}

// the source text is usually "Permasalahan: … Kategori: … Lokasi: … Detail Alamat Laporan: …"
export function splitContent(value: unknown) {
  const text = cleanText(value);
  const part = (label: string, next: string[]) => {
    const match = new RegExp(`${label}:\\s*([\\s\\S]*?)\\s*(?=(?:${next.join('|')}):|$)`, 'i').exec(text);
    return match?.[1]?.trim() ?? '';
  };
  const labels = ['Permasalahan', 'Kategori', 'Lokasi', 'Detail Alamat Laporan'];
  const problem = part('Permasalahan', labels.slice(1));
  return {
    description: problem || text,
    address: part('Lokasi', labels.filter(label => label !== 'Lokasi')),
    addressDetail: part('Detail Alamat Laporan', labels.filter(label => label !== 'Detail Alamat Laporan')),
  };
}
// --- end of text cleaning ---

// --- ids ---
// public code: LJ- + 8 characters from an alphabet without look-alikes
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function randomCode() {
  return 'LJ-' + [...randomBytes(8)].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
}
export const sourceRef = (sourceId: string) => createHash('sha256').update(`crm:${sourceId}`).digest('hex');
// the same reporter always gets the same random-looking id; the name itself is never stored
// Why/Note: keyed with a local secret, so the id cannot be recomputed from a name without it
export function reporterId(name: unknown, salt: string) {
  // Why/Note: the public data carries a generic word (or a mask) instead of a name; that is no reporter, so no id
  if (typeof name !== 'string' || !name.trim() || /^[*xX\s]+$/.test(name) || /^(?:anonim|anonymous|warga|masyarakat|pelapor)\b/i.test(name.trim())) return null;
  const hex = createHmac('sha256', salt).update(name.trim().toLocaleLowerCase('id')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 + (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const newId = () => randomUUID();
// --- end of ids ---

// --- record mapping ---
const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const name = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

// input param : one public detail, our category, lookups (status slug -> name, zone id -> name), the reporter salt
// output      : the fields we store (ids are added by the importer so reruns keep them)
export function mapDetail(detail: unknown, category: OurCategory, lookups: { status: Map<string, string>; zone: Map<string, string> }, salt: string) {
  const row = record(detail);
  const village = record(row.village), district = record(village.district), city = record(district.city);
  const content = splitContent(row.content);
  const history: ImportedHistory[] = (Array.isArray(row.history) ? row.history : []).map((value: unknown) => {
    const entry = record(value);
    const slug = typeof entry.status === 'string' ? entry.status : '';
    return { at: new Date(entry.createdAt), status: lookups.status.get(slug) ?? slug, unit: lookups.zone.get(entry.assignedToZone) ?? null,
      role: name(entry.assignedToRole), note: cleanText(entry.comment, 1000) };
  }).filter((entry: ImportedHistory) => Number.isFinite(entry.at.getTime()) && entry.status)
    .sort((a: ImportedHistory, b: ImportedHistory) => b.at.getTime() - a.at.getTime());
  return {
    category, subcategory: name(record(row.complaintCategory).name) ?? '', ...content,
    lat: row.lat, lng: row.lng, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt ?? row.createdAt),
    status: name(record(row.tstatus).name) ?? lookups.status.get(row.status) ?? 'Status belum tersedia', statusSlug: name(row.status) ?? '',
    unit: name(record(row.zone).name), area: { village: name(village.name), district: name(district.name), city: name(city.name) },
    history, reporterId: reporterId(row.name, salt),
  };
}
// --- end of record mapping ---
