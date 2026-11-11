/* Validate reporter conditions and keep missing measurements unknown.
Todo:
-> normalize safe geometry, dimensions and observation time
*/
import { field, InputError } from './db.js';
// reports anywhere in Indonesia (owner, 10 Nov: not only Jakarta); a box around the archipelago, land and sea
export const inIndonesia = (lng: number, lat: number) => lng >= 94.5 && lng <= 141.5 && lat >= -11.5 && lat <= 6.5;

const kinds = {
  road: ['pothole', 'subsidence', 'crack', 'excavation', 'closure', 'other'],
  construction: ['construction', 'excavation', 'closure', 'other'],
  drain: ['blocked_drain', 'other'],
  burning: ['burning', 'other'],
} as const;
export type Category = keyof typeof kinds;
export const conditionKindAllowed = (kind: string, category: Category) => (kinds[category] as readonly string[]).includes(kind);
export type Position = [number, number];
export type Geometry = { type: 'Point'; coordinates: Position } |
  { type: 'LineString'; coordinates: Position[] } |
  { type: 'Polygon'; coordinates: Position[][] };
type Dimensions = { method: 'measured' | 'estimated'; tool?: string; widthM?: number; depthM?: number; lengthM?: number };
export type Condition = {
  kind: typeof kinds[Category][number]; observedAt: string; locationConfirmed: true; source: 'reporter';
  geometry: Geometry; dimensions?: Dimensions; access?: 'unknown' | 'partial' | 'closed';
};
function invalid(message = 'Kondisi tidak valid.'): never { throw new InputError(400, message); }
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
const cross = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const epsilon = 1e-14;

function position(value: unknown): Position {
  if (!Array.isArray(value) || value.length !== 2 ||
    value.some(n => typeof n !== 'number' || !Number.isFinite(n)) ||
    !inIndonesia(value[0], value[1])) invalid('Lokasi kondisi tidak valid.');
  return [value[0], value[1]];
}
function onSegment(a: Position, b: Position, p: Position) {
  return Math.abs(cross(a, b, p)) <= epsilon &&
    p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}
function intersects(a: Position, b: Position, c: Position, d: Position) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0) ||
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function geometry(value: unknown, anchor: Position): Geometry {
  if (value === undefined) return { type: 'Point', coordinates: position(anchor) };
  const input = object(value);
  if (input.type === 'Point') return { type: 'Point', coordinates: position(input.coordinates) };
  const polygon = input.type === 'Polygon';
  if (!polygon && input.type !== 'LineString') invalid('Bentuk kondisi tidak didukung.');
  if (polygon && (!Array.isArray(input.coordinates) || input.coordinates.length !== 1)) invalid('Area hanya boleh memiliki satu batas.');
  const raw = polygon ? (input.coordinates as unknown[])[0] : input.coordinates;
  if (!Array.isArray(raw) || raw.length < (polygon ? 4 : 2) || raw.length > (polygon ? 65 : 64)) invalid('Jumlah titik tidak valid.');
  const points = raw.map(position);
  if (polygon && !same(points[0], points.at(-1)!)) invalid('Batas area harus tertutup.');
  const vertices = polygon ? points.slice(0, -1) : points;
  if (new Set(vertices.map(p => p.join(','))).size !== vertices.length) invalid('Titik kondisi tidak boleh berulang.');
  if (!polygon) return { type: 'LineString', coordinates: points };
  const count = vertices.length;
  const area = vertices.reduce((sum, current, i) => sum + cross(vertices[0], current, vertices[(i + 1) % count]), 0);
  if (Math.abs(area) <= epsilon) invalid('Area tidak boleh memiliki luas nol.');
  for (let i = 0; i < count; i++) {
    const a = vertices[i], b = vertices[(i + 1) % count], before = vertices[(i + count - 1) % count];
    if (onSegment(before, a, b) || onSegment(a, b, before)) invalid('Batas area tidak boleh bertumpuk.');
    for (let j = i + 2; j < count; j++) {
      if (i === 0 && j === count - 1) continue;
      if (intersects(a, b, vertices[j], vertices[(j + 1) % count])) invalid('Batas area tidak boleh berpotongan.');
    }
  }
  return { type: 'Polygon', coordinates: [points] };
}
function dimensions(value: unknown): Dimensions | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (input.method !== 'measured' && input.method !== 'estimated') invalid('Metode ukuran diperlukan.');
  const tool = input.tool === undefined ? '' : field(input.tool, 0, 80, 'Alat ukur').normalize('NFC');
  if (/[\p{Cc}\p{Cf}]/u.test(tool) || (input.method === 'measured' && !tool)) invalid('Alat ukur diperlukan.');
  const result: Dimensions = { method: input.method, ...(tool ? { tool } : {}) };
  let count = 0;
  for (const key of ['widthM', 'depthM', 'lengthM'] as const) {
    const number = input[key];
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || number > 1000 || (key === 'depthM' ? number < 0 : number <= 0)) invalid('Ukuran tidak valid.');
    result[key] = number; count++;
  }
  if (!count) invalid('Isi setidaknya satu ukuran.');
  return result;
}
function observedAt(value: unknown) {
  if (typeof value !== 'string') invalid('Waktu pengamatan tidak valid.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const timestamp = Date.parse(value);
  if (!match || !Number.isFinite(timestamp) || timestamp > Date.now() + 5 * 60_000) invalid('Waktu pengamatan tidak valid.');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) invalid('Waktu pengamatan tidak valid.');
  return new Date(timestamp).toISOString();
}

// Missing means preserve; null explicitly removes the current condition.
// input param : multipart JSON, report category and report point
// output : canonical reporter snapshot, null, or undefined
export function conditionInput(value: unknown, category: Category, anchor: Position): Condition | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { invalid(); }
  if (parsed === null) return null;
  const input = object(parsed);
  if (typeof input.kind !== 'string' || !conditionKindAllowed(input.kind, category)) invalid('Kondisi tidak sesuai kategori.');
  if (input.locationConfirmed !== true) invalid('Konfirmasi lokasi diperlukan.');
  if (input.kind !== 'closure' && input.access !== undefined) invalid('Akses hanya berlaku untuk penutupan.');
  if (input.kind === 'closure' && input.access !== undefined && (typeof input.access !== 'string' || !['unknown', 'partial', 'closed'].includes(input.access))) invalid('Akses jalan tidak valid.');
  const size = dimensions(input.dimensions);
  return { kind: input.kind as Condition['kind'], observedAt: observedAt(input.observedAt), locationConfirmed: true, source: 'reporter',
    geometry: geometry(input.geometry, anchor), ...(size ? { dimensions: size } : {}),
    ...(input.kind === 'closure' ? { access: (input.access ?? 'unknown') as Condition['access'] } : {}) };
}
export function publicCondition(value: Condition | null): Condition | null {
  if (value === null) return null;
  const size = value.dimensions;
  const copyPoint = (point: Position): Position => [point[0], point[1]];
  const shape: Geometry = value.geometry.type === 'Point' ? { type: 'Point', coordinates: copyPoint(value.geometry.coordinates) } :
    value.geometry.type === 'LineString' ? { type: 'LineString', coordinates: value.geometry.coordinates.map(copyPoint) } :
      { type: 'Polygon', coordinates: value.geometry.coordinates.map(ring => ring.map(copyPoint)) };
  return { kind: value.kind, observedAt: value.observedAt, locationConfirmed: true, source: 'reporter', geometry: shape,
    ...(size ? { dimensions: { method: size.method, ...(size.tool ? { tool: size.tool } : {}),
      ...(size.widthM !== undefined ? { widthM: size.widthM } : {}), ...(size.depthM !== undefined ? { depthM: size.depthM } : {}),
      ...(size.lengthM !== undefined ? { lengthM: size.lengthM } : {}) } } : {}),
    ...(value.kind === 'closure' ? { access: value.access ?? 'unknown' } : {}) };
}
// end of helper ---------------------------------------------------------------------------------------

