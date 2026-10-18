/* Save citizen reports and append owner observations, tanpa status petugas.
Todo:
-> validate locations, retry safely and publish only report fields
*/
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { database, field, InputError, limit, route, uuid } from './db.js';
import { currentAccount } from './auth.js';
import { Attachment, removeMedia, saveMedia, serveMedia, upload, validateMedia } from './media.js';

const categories = { road: 'Jalan', construction: 'Pembangunan', drain: 'Saluran', burning: 'Pembakaran' };
const statuses = { reported: 'Dilaporkan', unchanged: 'Belum berubah', work_observed: 'Terlihat dikerjakan', resolved_observed: 'Terlihat selesai' };
type Status = keyof typeof statuses;
type Entry = { id: string; note: string; status: Status; createdAt: string; media: Attachment[]; fingerprint: string };
interface CitizenReport {
  _id: string; ownerId: string; category: keyof typeof categories; title: string; description: string;
  address: string; lat: number; lng: number; createdAt: string; updatedAt: string;
  status: Status; revision: number; updates: Entry[];
}
const reports = () => database().collection<CitizenReport>('citizen_reports');
const digest = (body: unknown, files: Express.Multer.File[]) => {
  const h = createHash('sha256').update(JSON.stringify(body));
  for (const f of files) h.update(f.mimetype).update(String(f.size)).update(f.buffer);
  return h.digest('hex');
};
function publicReport(row: CitizenReport, detail = false, ownerId?: string) {
  return { id: row._id, code: `LJ-${row._id}`, origin: 'community', category: row.category,
    sourceCategory: categories[row.category], title: row.title, description: row.description, address: row.address,
    lat: row.lat, lng: row.lng, createdAt: row.createdAt, updatedAt: row.updatedAt,
    status: row.status, sourceStatus: statuses[row.status], media: row.updates[0].media,
    ...(detail ? { revision: row.revision, canUpdate: ownerId === row.ownerId,
      updates: row.updates.map(({ fingerprint: _, ...entry }) => ({ ...entry, actor: 'Pelapor' })) } : {}) };
}
export function reportInput(body: Record<string, unknown>) {
  if (!uuid(body.requestId)) throw new InputError(400, 'ID pengiriman tidak valid.');
  if (typeof body.category !== 'string' || !Object.hasOwn(categories, body.category)) throw new InputError(400, 'Kategori tidak valid.');
  const lng = Number(body.lng), lat = Number(body.lat);
  // Service envelope only, not an official administrative boundary.
  if (body.lng === '' || body.lat === '' || !Number.isFinite(lng) || !Number.isFinite(lat) || lng < 106.3 || lng > 107.1 || lat < -6.5 || lat > -5.2) {
    throw new InputError(400, 'Pilih lokasi di sekitar Jakarta.');
  }
  if (body.publicConsent !== 'true') throw new InputError(400, 'Konfirmasi publikasi laporan diperlukan.');
  return { category: body.category as keyof typeof categories, title: field(body.title, 5, 120, 'Judul'),
    description: field(body.description, 10, 4000, 'Uraian'), address: field(body.address ?? '', 0, 300, 'Patokan'), lng, lat };
}
export const reportRoutes = Router();
reportRoutes.get('/', route(async (req, res) => {
  const owner = req.query.mine === 'true' ? await currentAccount(req) : null;
  const filters: any[] = owner ? [{ ownerId: owner._id }] : [];
  if (req.query.cursor !== undefined) {
    const [date, id] = String(req.query.cursor).split('|');
    if (!uuid(id) || !date || !Number.isFinite(Date.parse(date))) throw new InputError(400, 'Halaman tidak valid.');
    filters.push({ $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: id } }] });
  }
  const rows = await reports().find(filters.length ? { $and: filters } : {}).sort({ createdAt: -1, _id: -1 }).limit(101).toArray();
  const visible = rows.slice(0, 100), last = visible.at(-1);
  res.json({ reports: visible.map(row => publicReport(row)), nextCursor: rows.length > 100 && last ? `${last.createdAt}|${last._id}` : null });
}));
reportRoutes.get('/:id', route(async (req, res) => {
  const row = uuid(req.params.id) ? await reports().findOne({ _id: String(req.params.id) }) : null;
  if (!row) throw new InputError(404, 'Laporan tidak ditemukan.');
  const owner = req.get('Authorization') ? await currentAccount(req) : null;
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicReport(row, true, owner?._id));
}));
reportRoutes.get('/:id/media/:mediaId', route(async (req, res) => {
  const row = uuid(req.params.id) ? await reports().findOne({ _id: String(req.params.id) }) : null;
  const file = row?.updates.flatMap(entry => entry.media).find(item => item.id === req.params.mediaId);
  if (!file) throw new InputError(404, 'Lampiran tidak ditemukan.');
  await serveMedia(req, res, file);
}));

// Authenticate before reading multipart buffers; bound concurrent memory use per instance.
let inflight = 0;
reportRoutes.use((req, res, next) => {
  void (async () => {
    const account = await currentAccount(req);
    await limit('write', account._id, 40, 60 * 60_000);
    if (inflight >= 4) throw new InputError(429, 'Pengiriman sedang penuh. Silakan coba kembali.');
    res.locals.accountId = account._id;
    inflight++;
    let released = false;
    const release = () => { if (!released) { released = true; inflight--; } };
    res.once('finish', release); res.once('close', release);
    upload(req, res, error => next(error ? error instanceof InputError ? error : new InputError(400, 'Maksimum 3 lampiran, masing-masing 10 MB. Periksa isian dan berkas.') : undefined));
  })().catch(next);
});

reportRoutes.post('/', route(async (req, res) => {
  const input = reportInput(req.body), files = req.files as Express.Multer.File[] ?? [];
  validateMedia(files);
  const fingerprint = digest(input, files), id = String(req.body.requestId), ownerId = res.locals.accountId;
  const previous = await reports().findOne({ _id: id });
  if (previous) {
    if (previous.ownerId !== ownerId || previous.updates[0].fingerprint !== fingerprint) throw new InputError(409, 'ID pengiriman sudah digunakan untuk isi lain.');
    res.json(publicReport(previous, true, ownerId)); return;
  }
  await limit('create', ownerId, 10, 60 * 60_000);
  const media = await saveMedia(files), now = new Date().toISOString();
  const row: CitizenReport = { _id: id, ownerId, ...input, createdAt: now, updatedAt: now,
    status: 'reported', revision: 0, updates: [{ id, note: input.description, status: 'reported', createdAt: now, media, fingerprint }] };
  try { await reports().insertOne(row); }
  catch (error: any) {
    await removeMedia(media);
    if (error.code === 11000) {
      const existing = await reports().findOne({ _id: id, ownerId });
      if (existing?.updates[0].fingerprint === fingerprint) { res.json(publicReport(existing, true, ownerId)); return; }
      throw new InputError(409, 'ID pengiriman sudah digunakan.');
    }
    throw error;
  }
  res.status(201).json(publicReport(row, true, ownerId));
}));
reportRoutes.post('/:id/updates', route(async (req, res) => {
  const id = String(req.params.id), ownerId = res.locals.accountId;
  if (!uuid(id) || !uuid(req.body.requestId)) throw new InputError(400, 'ID laporan atau pembaruan tidak valid.');
  const row = await reports().findOne({ _id: id });
  if (!row) throw new InputError(404, 'Laporan tidak ditemukan.');
  if (row.ownerId !== ownerId) throw new InputError(403, 'Hanya pelapor yang dapat memperbarui laporan.');
  if (!['unchanged', 'work_observed', 'resolved_observed'].includes(req.body.status)) throw new InputError(400, 'Kondisi pengamatan tidak valid.');
  if (req.body.publicConsent !== 'true') throw new InputError(400, 'Konfirmasi publikasi diperlukan.');
  const note = field(req.body.note, 10, 4000, 'Catatan'), status = req.body.status as Status;
  const revision = Number(req.body.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new InputError(400, 'Versi laporan tidak valid.');
  const files = req.files as Express.Multer.File[] ?? [];
  validateMedia(files);
  const fingerprint = digest({ note, status }, files), entryId = String(req.body.requestId);
  const previous = row.updates.find(entry => entry.id === entryId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new InputError(409, 'ID pembaruan sudah digunakan untuk isi lain.');
    res.json(publicReport(row, true, ownerId)); return;
  }
  if (row.revision !== revision) throw new InputError(409, 'Ada pembaruan lain. Muat ulang riwayat sebelum mengirim.');
  if (row.updates.length >= 100) throw new InputError(400, 'Batas 100 pembaruan laporan tercapai.');
  const media = await saveMedia(files), now = new Date().toISOString();
  let updated;
  try {
    updated = await reports().findOneAndUpdate({ _id: id, ownerId, revision, 'updates.id': { $ne: entryId } },
      { $push: { updates: { id: entryId, note, status, media, createdAt: now, fingerprint } },
        $set: { status, updatedAt: now }, $inc: { revision: 1 } }, { returnDocument: 'after' });
  } catch (error) { await removeMedia(media); throw error; }
  if (!updated) {
    await removeMedia(media);
    const current = await reports().findOne({ _id: id, ownerId });
    if (current?.updates.some(entry => entry.id === entryId && entry.fingerprint === fingerprint)) { res.json(publicReport(current, true, ownerId)); return; }
    throw new InputError(409, 'Ada pembaruan lain. Muat ulang riwayat sebelum mengirim.');
  }
  res.status(201).json(publicReport(updated, true, ownerId));
}));
