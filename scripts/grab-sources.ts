/* Todo:
-> ONE-TIME grab of every reachable public road-report source outside Jakarta, cleaned and labelled, into imported_reports
   (owner choice, 11 Nov: "ambil semua, sekali aja, preprocessing dulu, nama user dll dihapus, kita pake laporannya aja, labeling sesuai kategori kita dan masukin database")
    -> preprocessing: each source's map() reads ONLY our non-personal report fields (point, status, category, time).
       Names, emails, passwords, free-text descriptions and photos are never read, so they are never written.
    -> labelling: only our categories are kept (road for these sources); each report carries a `source` tag.
    -> rerun-safe: matched by a per-source hash of the source id; ids and LJ- codes stay; a changed status is added to the history.
    -> --dry: fetch, clean and label only; write nothing. --only <name>: one source.
   usage: npx tsx scripts/grab-sources.ts [--dry] [--only samarinda|jalankita]

   Not grabbed (checked 11 Nov, see knowledge/prd-v2-2026-11-09/SOURCES-INDONESIA.md):
   Jawa Barat (403 / login), Demak (needs written permission), Bekasi/Depok/Tangerang/Bogor (report via WhatsApp/IG/app, no public per-report map).
   Their national roads are covered by the Jalan Kita source.
*/
import mongoose from 'mongoose';
import { ENV } from '../src/config/env.js';
import { newId, randomCode } from '../src/services/crmImport.js';
import { mapSamarinda, samarindaRef, SAMARINDA_ENDPOINT } from '../src/services/samarindaImport.js';
import { mapNational, nationalRef, NATIONAL_ENDPOINT } from '../src/services/nationalImport.js';

type Mapped = { sourceId: string; fields: Record<string, any> };
interface Source { name: string; fetchRows: () => Promise<unknown[]>; map: (row: unknown) => Mapped | null; ref: (id: string) => string }

const DRY = process.argv.includes('--dry');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const MAX_BYTES = 20 * 1024 * 1024;

// one request, size- and type-checked; the body is parsed in memory and discarded after mapping
async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'LaporJalan-import/1.0' }, redirect: 'error', signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(`Sumber tidak tersedia (HTTP ${response.status})`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Respons sumber terlalu besar');
  return JSON.parse(text);
}
const findArray = (value: any): unknown[] => Array.isArray(value) ? value : value && typeof value === 'object' ? (Object.values(value).map(findArray).find(a => a.length) ?? []) : [];

const SOURCES: Source[] = [
  { name: 'samarinda', ref: samarindaRef, map: mapSamarinda, fetchRows: async () => findArray(await fetchJson(SAMARINDA_ENDPOINT)) },
  { name: 'jalankita', ref: nationalRef, map: mapNational, fetchRows: async () => {
    const body = await fetchJson(NATIONAL_ENDPOINT);
    // the dashboard carries every report point under data.map; we read only that array
    const rows = Array.isArray(body?.data?.map) ? body.data.map : findArray(body?.data ?? body);
    return rows;
  } },
];

async function grab(source: Source) {
  const rows = await source.fetchRows();
  const seen = new Set<string>();
  const mapped = rows.map(source.map).filter((row): row is Mapped => {
    if (!row || seen.has(row.sourceId)) return false;
    seen.add(row.sourceId); return true;
  });
  const byStatus = mapped.reduce<Record<string, number>>((all, row) => ({ ...all, [row.fields.status]: (all[row.fields.status] ?? 0) + 1 }), {});
  console.log(`${source.name}: ${rows.length} baris mentah -> ${mapped.length} laporan kategori kita`, byStatus);
  return mapped;
}

async function main() {
  const chosen = SOURCES.filter(source => !ONLY || source.name === ONLY);
  if (!chosen.length) throw new Error(`Sumber tidak dikenal: ${ONLY}`);
  const grabbed = await Promise.all(chosen.map(async source => ({ source, mapped: await grab(source) })));
  const total = grabbed.reduce((sum, item) => sum + item.mapped.length, 0);
  console.log(`Total ${total} laporan siap${DRY ? ' (dry run, tidak ditulis)' : ''}.`);
  if (DRY || !total) return;

  if (!ENV.MONGODB_URI) throw new Error('MONGODB_URI belum diisi');
  await mongoose.connect(ENV.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const db = mongoose.connection.db!;
    const reports = db.collection<any>('imported_reports');
    await Promise.all([reports.createIndex({ sourceRef: 1 }, { unique: true }), reports.createIndex({ code: 1 }, { unique: true }),
      reports.createIndex({ createdAt: -1 }), reports.createIndex({ category: 1 })]);
    const importedAt = new Date();
    for (const { source, mapped } of grabbed) {
      if (!mapped.length) continue;
      const refs = mapped.map(row => source.ref(row.sourceId));
      const known = new Map((await reports.find({ sourceRef: { $in: refs } }, { projection: { sourceRef: 1, status: 1 } }).toArray()).map(row => [row.sourceRef as string, row.status as string]));
      let changed = 0;
      const result = await reports.bulkWrite(mapped.map(({ fields }, index) => {
        const ref = refs[index], before = known.get(ref);
        const entry = (at: Date) => ({ at, status: fields.status, unit: null, role: null, note: '' });
        if (before === undefined) return { updateOne: { filter: { sourceRef: ref }, upsert: true, update: {
          $set: { ...fields, updatedAt: fields.createdAt, history: [entry(fields.createdAt)], importedAt }, $setOnInsert: { _id: newId(), code: randomCode(), sourceRef: ref } } } };
        if (before !== fields.status) { changed++; return { updateOne: { filter: { sourceRef: ref }, update: { $set: { ...fields, updatedAt: importedAt, importedAt }, $push: { history: { $each: [entry(importedAt)], $position: 0 } } } } }; }
        return { updateOne: { filter: { sourceRef: ref }, update: { $set: { ...fields, importedAt } } } };
      }), { ordered: false });
      const dates = mapped.map(row => row.fields.createdAt.toISOString().slice(0, 10)).sort();
      await db.collection<any>('imported_meta').updateOne({ _id: source.name }, { $set: { importedAt, dateStart: dates[0], dateEnd: dates.at(-1), total: mapped.length } }, { upsert: true });
      console.log(`  ${source.name}: ${result.upsertedCount} baru, ${changed} status berubah`);
    }
    console.log(`Database: total laporan impor ${await reports.countDocuments()}`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
