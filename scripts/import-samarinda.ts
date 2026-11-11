/* Todo:
-> import the public Jalan Peduli map (Dinas PUPR Kota Samarinda) into imported_reports (owner choice, 11 Nov: beyond Jakarta)
    -> one request for the whole public map; size and type checked; only point, status, damage level and time kept
    -> rerun-safe: matched by a hash of the source id; ids and LJ- codes stay; a changed status is added to the history
    -> --dry: read and map only, write nothing
   usage: npx tsx scripts/import-samarinda.ts [--dry]
*/
import mongoose from 'mongoose';
import { ENV } from '../src/config/env.js';
import { newId, randomCode } from '../src/services/crmImport.js';
import { mapSamarinda, samarindaRef, SAMARINDA_ENDPOINT } from '../src/services/samarindaImport.js';

const DRY = process.argv.includes('--dry');
const MAX_BYTES = 5 * 1024 * 1024;

async function readList(): Promise<unknown[]> {
  const response = await fetch(SAMARINDA_ENDPOINT, { headers: { Accept: 'application/json', 'User-Agent': 'LaporJalan-import/1.0' },
    redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(`Sumber tidak tersedia (HTTP ${response.status})`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Respons sumber terlalu besar');
  const body = JSON.parse(text);
  if (!Array.isArray(body) || body.length > 20_000) throw new Error('Format sumber berubah');
  return body;
}

// Why/Note: the backend package is CommonJS, so no top-level await
async function main() {
  const list = await readList();
  const seen = new Set<string>();
  const mapped = list.map(mapSamarinda).filter((row): row is NonNullable<ReturnType<typeof mapSamarinda>> => {
    if (!row || seen.has(row.sourceId)) return false;
    seen.add(row.sourceId); return true;
  });
  const byStatus = mapped.reduce<Record<string, number>>((all, row) => ({ ...all, [row.fields.status]: (all[row.fields.status] ?? 0) + 1 }), {});
  console.log(`Samarinda: ${list.length} laporan di peta publik, ${mapped.length} dipakai${DRY ? ' (dry run)' : ''}`, byStatus);
  if (DRY || !mapped.length) return;

  if (!ENV.MONGODB_URI) throw new Error('MONGODB_URI belum diisi');
  await mongoose.connect(ENV.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const db = mongoose.connection.db!;
    const reports = db.collection<any>('imported_reports');
    await Promise.all([reports.createIndex({ sourceRef: 1 }, { unique: true }), reports.createIndex({ code: 1 }, { unique: true }),
      reports.createIndex({ createdAt: -1 }), reports.createIndex({ category: 1 })]);
    const refs = mapped.map(row => samarindaRef(row.sourceId));
    const known = new Map((await reports.find({ sourceRef: { $in: refs } }, { projection: { sourceRef: 1, status: 1 } }).toArray())
      .map(row => [row.sourceRef as string, row.status as string]));
    const importedAt = new Date();
    let changed = 0;
    const result = await reports.bulkWrite(mapped.map(({ fields }, index) => {
      const ref = refs[index], before = known.get(ref);
      const entry = (at: Date) => ({ at, status: fields.status, unit: null, role: null, note: '' });
      if (before === undefined) return { updateOne: { filter: { sourceRef: ref }, upsert: true, update: {
        $set: { ...fields, updatedAt: fields.createdAt, history: [entry(fields.createdAt)], importedAt },
        $setOnInsert: { _id: newId(), code: randomCode(), sourceRef: ref } } } };
      if (before !== fields.status) {
        changed++;
        // newest first, like the CRM history
        return { updateOne: { filter: { sourceRef: ref }, update: { $set: { ...fields, updatedAt: importedAt, importedAt },
          $push: { history: { $each: [entry(importedAt)], $position: 0 } } } } };
      }
      return { updateOne: { filter: { sourceRef: ref }, update: { $set: { ...fields, importedAt } } } };
    }), { ordered: false });
    const dates = mapped.map(row => row.fields.createdAt.toISOString().slice(0, 10)).sort();
    await db.collection<any>('imported_meta').updateOne({ _id: 'samarinda' },
      { $set: { importedAt, dateStart: dates[0], dateEnd: dates.at(-1), total: mapped.length } }, { upsert: true });
    console.log(`Database: ${result.upsertedCount} baru, ${changed} status berubah, total laporan impor ${await reports.countDocuments()}`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
