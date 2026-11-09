/* Todo:
-> serve the imported reports (scripts/import-crm.ts) as the map's data when the database has them
    -> list: the same snapshot shape the map already reads; detail: report + history for the card tabs
    -> no database, or nothing imported: the caller falls back to the live source
*/
import mongoose from 'mongoose';
import { handlingFor, publicHandling, suppressedIds } from '../community/handling.js';

type Row = Record<string, any> & { _id: string }; // our ids are UUID strings, not ObjectId
const collection = () => mongoose.connection.readyState === 1 && mongoose.connection.db ? mongoose.connection.db.collection<Row>('imported_reports') : null;
const iso = (value: unknown) => new Date(value as string).toISOString();

// --- list (short cache; the importer refreshes the data) ---
let cache: { at: number; value: unknown } | undefined;
// admin actions change what is public: drop the cached list at once
export const invalidateImported = () => { cache = undefined; };
export async function importedSnapshot() {
  const reports = collection();
  if (!reports) return null;
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const meta = await mongoose.connection.db!.collection<Row>('imported_meta').findOne({ _id: 'crm' });
  const rows = await reports.find({}, { projection: { code: 1, lat: 1, lng: 1, category: 1, subcategory: 1, status: 1, createdAt: 1 } })
    .sort({ createdAt: -1 }).limit(20_000).toArray();
  if (!meta || !rows.length) return null;
  const suppressed = await suppressedIds('impor'); // hidden by an admin or marked as a duplicate
  const value = {
    reports: rows.filter(row => !suppressed.has(row._id)).map(row => ({ id: row._id, code: row.code, lat: row.lat, lng: row.lng, category: row.category,
      sourceCategory: row.subcategory || 'Jalan', createdAt: iso(row.createdAt), sourceStatus: row.status ?? null })),
    source: { name: 'LaporJalan', url: '', retrievedAt: iso(meta.importedAt), dateStart: meta.dateStart, dateEnd: meta.dateEnd },
  };
  cache = { at: Date.now(), value };
  return value;
}
// --- end of list ---

// --- detail (Laporan + Riwayat tabs) ---
export async function importedDetail(id: string) {
  const reports = collection();
  if (!reports || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await reports.findOne({ _id: id });
  if (!row) return null;
  const handling = await handlingFor(id);
  if (handling?.hidden || handling?.duplicateOf) return null;
  return { handling: publicHandling(handling), id: row._id, code: row.code, category: row.category, subcategory: row.subcategory, status: row.status,
    unit: handling?.unit ?? row.unit ?? null, area: row.area ?? null, description: row.description ?? '', address: row.address ?? '', addressDetail: row.addressDetail ?? '',
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    history: (row.history ?? []).map((entry: Row) => ({ at: iso(entry.at), status: entry.status, unit: entry.unit ?? null, role: entry.role ?? null, note: entry.note ?? '' })) };
}
// --- end of detail ---
