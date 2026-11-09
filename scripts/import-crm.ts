/* Todo:
-> import the last N days of public CRM reports into imported_reports (owner choice, 10 Nov)
    -> list once, keep only our categories, then read each detail politely (3 at a time, short pause, retries)
    -> rerun-safe: matched by a hash of the source id; ids and public codes stay, status and history refresh
    -> --dry: read and map only, write nothing
   usage: npx tsx scripts/import-crm.ts [--days 30] [--dry]
*/
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { ENV } from '../src/config/env.js';
import { labelCategory, mapDetail, newId, randomCode, sourceRef, type OurCategory } from '../src/services/crmImport.js';

const BASE = 'https://crm.jakarta.go.id/api/public';
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) || 30;
const DRY = args.includes('--dry');
const SALT_FILE = '.env.import-salt'; // ignored by git (.env.*)

// --- helpers ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const jakartaDate = (time: number) => new Date(time + 7 * 3600_000).toISOString().slice(0, 10);
async function getJson(path: string, attempt = 0): Promise<any> {
  try {
    const response = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 2) throw error;
    await sleep(1000 * (attempt + 1));
    return getJson(path, attempt + 1);
  }
}
function salt() {
  if (process.env.IMPORT_REPORTER_SALT) return process.env.IMPORT_REPORTER_SALT;
  if (!existsSync(SALT_FILE)) writeFileSync(SALT_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
  return readFileSync(SALT_FILE, 'utf8').trim();
}
// --- end of helpers ---

// --- import ---
// Why/Note: the backend package is CommonJS, so no top-level await
async function main() {
  const dateEnd = jakartaDate(Date.now()), dateStart = jakartaDate(Date.now() - (DAYS - 1) * 86_400_000);
  console.log(`Rentang ${dateStart} - ${dateEnd}${DRY ? ' (dry run)' : ''}`);
  const list: any[] = await getJson(`/dashboard/distribution-map?${new URLSearchParams({ dateStart, dateEnd, isPrivacy: '0' })}`);
  const rawStatuses = await getJson('/list-status');
  const statuses: any[] = Array.isArray(rawStatuses) ? rawStatuses : rawStatuses?.data ?? []; // the endpoint answers with a bare array
  const lookups = { status: new Map(statuses.map(row => [row.slug, row.name])), zone: new Map<string, string>() };
  for (const row of list) if (row?.zone?.id && row.zone.name) lookups.zone.set(row.zone.id, row.zone.name);

  const candidates = list.filter(row => row?.isPrivacy === false && typeof row.id === 'string' && Number.isFinite(row.lat) && Number.isFinite(row.lng)
    && Math.abs(row.lat) <= 85 && Math.abs(row.lng) <= 180)
    .map(row => ({ row, category: labelCategory(row.complaintCategory?.name, row.content) }))
    .filter((item): item is { row: any; category: OurCategory } => item.category !== null);
  console.log(`Daftar: ${list.length} laporan, ${candidates.length} sesuai kategori LaporJalan`);

  const reporterSalt = salt();
  const mapped: ReturnType<typeof mapDetail>[] = [], refs: string[] = [], failed: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const { row, category } = candidates[cursor++];
      try {
        const detail = await getJson(`/dashboard/detail?id=${encodeURIComponent(row.id)}`);
        const body = detail?.data ?? detail;
        if (body?.id !== row.id) throw new Error('mismatch');
        mapped.push(mapDetail(body, category, lookups, reporterSalt)); refs.push(sourceRef(row.id));
      } catch { failed.push(row.code ?? row.id); }
      if ((mapped.length + failed.length) % 100 === 0) console.log(`  detail ${mapped.length + failed.length}/${candidates.length}`);
      await sleep(120);
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  const byCategory = mapped.reduce<Record<string, number>>((all, row) => ({ ...all, [row.category]: (all[row.category] ?? 0) + 1 }), {});
  const reporters = new Set(mapped.map(row => row.reporterId).filter(Boolean));
  console.log(`Detail: ${mapped.length} berhasil, ${failed.length} gagal`, byCategory, `pelapor (ID acak): ${reporters.size}`,
    `riwayat: ${mapped.reduce((sum, row) => sum + row.history.length, 0)} entri`);

  if (!DRY) {
    if (!ENV.MONGODB_URI) throw new Error('MONGODB_URI belum diisi');
    await mongoose.connect(ENV.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    const db = mongoose.connection.db!;
    const reports = db.collection<any>('imported_reports');
    await Promise.all([reports.createIndex({ sourceRef: 1 }, { unique: true }), reports.createIndex({ code: 1 }, { unique: true }),
      reports.createIndex({ createdAt: -1 }), reports.createIndex({ category: 1 })]);
    const importedAt = new Date();
    const result = await reports.bulkWrite(mapped.map((row, index) => ({ updateOne: {
      filter: { sourceRef: refs[index] },
      update: { $set: { ...row, importedAt }, $setOnInsert: { _id: newId(), code: randomCode(), sourceRef: refs[index] } },
      upsert: true } })), { ordered: false });
    await db.collection<any>('imported_meta').updateOne({ _id: 'crm' }, { $set: { importedAt, dateStart, dateEnd, total: await reports.countDocuments(), byCategory } }, { upsert: true });
    console.log(`Database: ${result.upsertedCount} baru, ${result.modifiedCount} diperbarui, total ${await reports.countDocuments()}`);
    await mongoose.disconnect();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
// --- end of import ---
