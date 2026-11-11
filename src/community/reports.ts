/* Save citizen reports and append owner observations, tanpa status petugas.
Todo:
-> validate locations, retry safely and publish only report fields
*/
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { displayName, field, InputError, limit, route, uuid } from './db.js';
import { conditionInput, inIndonesia, publicCondition } from './condition.js';
import { currentAccount } from './auth.js';
import { removeMedia, saveMedia, serveMedia, upload, validateMedia } from './media.js';
import { categories, statuses, reports, published, visibleMedia, type CitizenReport, type PublicationChange, type Status } from './reportStore.js';
import { analysisReview, analysisError } from './analysisContract.js';
import { disabledAnalysis, reviewReceipt, validateAnalysisPolicy, type AnalysisPolicy } from './analyses.js';

const digest = (body: unknown, files: Express.Multer.File[]) => {
  const h = createHash('sha256').update(JSON.stringify(body));
  for (const f of files) h.update(f.mimetype).update(String(f.size)).update(f.buffer);
  return h.digest('hex');
};
function publicReport(row: CitizenReport, detail = false, ownerId?: string) {
  const owner = ownerId === row.ownerId;
  const reporterName = row.nameConsent ? row.reporterName : undefined;
  return { id: row._id, code: 'LJ-' + row._id, origin: 'community', category: row.category,
    sourceCategory: categories[row.category], title: row.title, description: row.description, address: row.address,
    lat: row.lat, lng: row.lng, createdAt: row.createdAt, updatedAt: row.updatedAt,
    status: row.status, sourceStatus: statuses[row.status], media: visibleMedia(row, row.updates[0].media),
    ...(row.condition !== undefined ? { condition: publicCondition(row.condition) } : {}),
    ...(reporterName ? { reporterName } : {}),
    ...(owner || detail ? { visibility: row.visibility ?? 'public', canManage: owner, canUpdate: owner && published(row) } : {}),
    ...(detail ? { revision: row.revision,
      updates: row.updates.map(entry => ({ id: entry.id, note: entry.note, status: entry.status, createdAt: entry.createdAt,
        ...(entry.condition !== undefined ? { condition: publicCondition(entry.condition) } : {}), media: visibleMedia(row, entry.media), actor: reporterName || 'Pelapor' })) } : {}) };
}
export function reportInput(body: Record<string, unknown>) {
  if (body.analysisReview !== undefined) analysisError(400, 'invalid_review', 'Tinjauan hanya tersedia pada pembaruan laporan tersimpan.');
  if (!uuid(body.requestId)) throw new InputError(400, 'ID pengiriman tidak valid.');
  if (typeof body.category !== 'string' || !Object.hasOwn(categories, body.category)) throw new InputError(400, 'Kategori tidak valid.');
  const lng = Number(body.lng), lat = Number(body.lat);
  // Service envelope only, not an official administrative boundary.
  if (body.lng === '' || body.lat === '' || !Number.isFinite(lng) || !Number.isFinite(lat) || !inIndonesia(lng, lat)) {
    throw new InputError(400, 'Pilih lokasi di wilayah Indonesia.');
  }
  if (body.publicConsent !== 'true') throw new InputError(400, 'Konfirmasi publikasi laporan diperlukan.');
  if (body.nameConsent !== undefined && !['true', 'false'].includes(String(body.nameConsent))) throw new InputError(400, 'Persetujuan nama tidak valid.');
  const name = body.nameConsent === 'true' ? displayName(body.reporterName) : '';
  if (body.nameConsent === 'true' && !name) throw new InputError(400, 'Nama diperlukan untuk publikasi.');
  const condition = conditionInput(body.condition, body.category as keyof typeof categories, [lng, lat]);
  // every new report is complete (owner, 10 Nov): condition, landmark and at least one photo/video; dimensions stay optional
  if (!condition) throw new InputError(400, 'Jenis kondisi, waktu pengamatan, dan bentuk lokasi diperlukan.');
  return { ...(condition !== undefined ? { condition } : {}), ...(name ? { reporterName: name, nameConsent: true } : {}), category: body.category as keyof typeof categories, title: field(body.title, 5, 120, 'Judul'),
    description: field(body.description, 10, 4000, 'Uraian'), address: field(body.address ?? '', 3, 300, 'Patokan'), lng, lat };
}
export function createReportRoutes(analysisPolicy: AnalysisPolicy = disabledAnalysis) {
validateAnalysisPolicy(analysisPolicy);
analysisPolicy = Object.freeze({ available: analysisPolicy.available, accountIds: Object.freeze([...analysisPolicy.accountIds]) });
const reportRoutes = Router();
reportRoutes.get('/', route(async (req, res) => {
  const owner = req.query.mine === 'true' ? await currentAccount(req) : null;
  const filters: any[] = owner ? [{ ownerId: owner._id }] : [{ visibility: { $in: [null, 'public'] } }];
  if (req.query.cursor !== undefined) {
    const [date, id] = String(req.query.cursor).split('|');
    if (!uuid(id) || !date || !Number.isFinite(Date.parse(date))) throw new InputError(400, 'Halaman tidak valid.');
    filters.push({ $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: id } }] });
  }
  const rows = await reports().find(filters.length ? { $and: filters } : {}).sort({ createdAt: -1, _id: -1 }).limit(101).toArray();
  const visible = rows.slice(0, 100), last = visible.at(-1);
  res.json({ reports: visible.map(row => publicReport(row, false, owner?._id)), nextCursor: rows.length > 100 && last ? `${last.createdAt}|${last._id}` : null });
}));
reportRoutes.get('/:id', route(async (req, res) => {
  const row = uuid(req.params.id) ? await reports().findOne({ _id: String(req.params.id) }) : null;
  if (!row) throw new InputError(404, 'Laporan tidak ditemukan.');
  const owner = req.get('Authorization') ? await currentAccount(req) : null;
  if (!published(row) && owner?._id !== row.ownerId) throw new InputError(404, 'Laporan tidak ditemukan.');
  res.json(publicReport(row, true, owner?._id));
}));
reportRoutes.get('/:id/media/:mediaId', route(async (req, res) => {
  const row = uuid(req.params.id) ? await reports().findOne({ _id: String(req.params.id) }) : null;
  const owner = req.get('Authorization') ? await currentAccount(req) : null;
  if (!row || (!published(row) && owner?._id !== row.ownerId)) throw new InputError(404, 'Lampiran tidak ditemukan.');
  const file = row.updates.flatMap(entry => entry.media).find(item => item.id === req.params.mediaId);
  if (!file || row.withdrawnMediaIds?.includes(file.id)) throw new InputError(404, 'Lampiran tidak ditemukan.');
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
    if (!req.is('multipart/form-data')) { next(); return; }
    upload(req, res, error => next(error ? error instanceof InputError ? error : new InputError(400, 'Maksimum 3 lampiran, masing-masing 10 MB. Periksa isian dan berkas.') : undefined));
  })().catch(next);
});

reportRoutes.post('/', route(async (req, res) => {
  const input = reportInput(req.body), files = req.files as Express.Multer.File[] ?? [];
  if (!files.length) throw new InputError(400, 'Tambahkan minimal satu foto atau video.');
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
    consentAudit: { granted: input.nameConsent === true, createdAt: now },
    status: 'reported', revision: 0, updates: [{ id, note: input.description, status: 'reported', createdAt: now, media, fingerprint, ...(input.condition !== undefined ? { condition: input.condition } : {}) }] };
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
  if (!published(row)) throw new InputError(409, 'Laporan tidak sedang dipublikasikan.');
  if (!['unchanged', 'work_observed', 'resolved_observed'].includes(req.body.status)) throw new InputError(400, 'Kondisi pengamatan tidak valid.');
  if (req.body.publicConsent !== 'true') throw new InputError(400, 'Konfirmasi publikasi diperlukan.');
  const note = field(req.body.note, 10, 4000, 'Catatan'), status = req.body.status as Status;
  const revision = Number(req.body.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new InputError(400, 'Versi laporan tidak valid.');
  const files = req.files as Express.Multer.File[] ?? [];
  validateMedia(files);
  const condition = conditionInput(req.body.condition, row.category, [row.lng, row.lat]);
  const review = analysisReview(req.body.analysisReview);
  const observation = { note, status, ...(condition !== undefined ? { condition } : {}) };
  const fingerprint = digest({ ...observation, ...(review ? { analysisReview: review } : {}) }, files), entryId = String(req.body.requestId);
  const previous = row.updates.find(entry => entry.id === entryId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new InputError(409, 'ID pembaruan sudah digunakan untuk isi lain.');
    res.json(publicReport(row, true, ownerId)); return;
  }
  if (row.revision !== revision) throw new InputError(409, 'Ada pembaruan lain. Muat ulang riwayat sebelum mengirim.');
  if (row.analysisReceipts?.some(item => item.requestId === entryId)) analysisError(409, 'request_conflict', 'ID pengiriman sudah digunakan.');
  if (row.updates.length >= 100) throw new InputError(400, 'Batas 100 pembaruan laporan tercapai.');
  const receipt = review ? await reviewReceipt(row, review, revision, entryId, fingerprint, condition, analysisPolicy) : undefined;
  const media = await saveMedia(files), now = new Date().toISOString();
  let updated;
  try {
    updated = await reports().findOneAndUpdate({ _id: id, ownerId, revision, visibility: { $in: [null, 'public'] }, 'updates.id': { $ne: entryId },
      ...(receipt ? { withdrawnMediaIds: { $ne: receipt.mediaId }, 'analysisReceipts.analysisId': { $ne: receipt.analysisId },
        'analysisReceipts.requestId': { $ne: entryId } } : {}) },
      { $push: { updates: { id: entryId, ...observation, media, createdAt: now, fingerprint }, ...(receipt ? { analysisReceipts: receipt } : {}) },
        $set: { status, updatedAt: now, ...(condition !== undefined ? { condition } : {}) }, $inc: { revision: 1 } }, { returnDocument: 'after' });
  } catch (error) { await removeMedia(media); throw error; }
  if (!updated) {
    await removeMedia(media);
    const current = await reports().findOne({ _id: id, ownerId });
    if (current?.updates.some(entry => entry.id === entryId && entry.fingerprint === fingerprint)) { res.json(publicReport(current, true, ownerId)); return; }
    throw new InputError(409, 'Ada pembaruan lain. Muat ulang riwayat sebelum mengirim.');
  }
  res.status(201).json(publicReport(updated, true, ownerId));
}));

// Publication shares observation revisions to prevent concurrent privacy changes being overwritten.
// input param : owner, request ID, revision and explicit publication choices
// output : owner report; private audit and original media stay in storage
reportRoutes.patch('/:id/publication', route(async (req, res) => {
  const id = String(req.params.id), ownerId = res.locals.accountId;
  if (!uuid(id) || !uuid(req.body.requestId)) throw new InputError(400, 'ID laporan atau pengiriman tidak valid.');
  const revision = req.body.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new InputError(400, 'Versi laporan tidak valid.');
  const row = await reports().findOne({ _id: id });
  if (!row) throw new InputError(404, 'Laporan tidak ditemukan.');
  if (row.ownerId !== ownerId) throw new InputError(403, 'Hanya pelapor yang dapat mengelola laporan.');
  const change: PublicationChange = {};
  if (req.body.nameConsent !== undefined || req.body.reporterName !== undefined) {
    if (typeof req.body.nameConsent !== 'boolean') throw new InputError(400, 'Persetujuan nama diperlukan.');
    const name = req.body.nameConsent ? displayName(req.body.reporterName) : '';
    if (req.body.nameConsent && !name) throw new InputError(400, 'Nama diperlukan untuk publikasi.');
    change.nameConsent = req.body.nameConsent;
    change.reporterName = name;
  }
  if (req.body.visibility !== undefined) {
    if (!['public', 'withdrawn'].includes(req.body.visibility)) throw new InputError(400, 'Publikasi tidak valid.');
    if (row.visibility === 'hidden') throw new InputError(403, 'Publikasi dibatasi oleh pengelola.');
    change.visibility = req.body.visibility;
  }
  if (req.body.withdrawMediaIds !== undefined) {
    const ids = req.body.withdrawMediaIds;
    if (!Array.isArray(ids) || ids.length > 300 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))) {
      throw new InputError(400, 'Lampiran tidak valid.');
    }
    const available = row.updates.flatMap(entry => entry.media).map(file => file.id);
    if (ids.some(id => !available.includes(id))) throw new InputError(400, 'Lampiran tidak ditemukan dalam laporan.');
    change.withdrawMediaIds = [...new Set<string>(ids)].sort();
  }
  if (!Object.keys(change).length) throw new InputError(400, 'Pilih perubahan publikasi.');
  const fingerprint = digest(change, []), entryId = String(req.body.requestId);
  const previous = row.publicationAudit?.find(entry => entry.id === entryId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new InputError(409, 'ID pengiriman sudah digunakan untuk isi lain.');
    res.json(publicReport(row, true, ownerId)); return;
  }
  if (row.revision !== revision) throw new InputError(409, 'Ada perubahan lain. Muat ulang laporan sebelum mengirim.');
  const now = new Date().toISOString();
  const { withdrawMediaIds, ...publication } = change;
  const updated = await reports().findOneAndUpdate({ _id: id, ownerId, revision,
    ...(change.visibility ? { visibility: { $ne: 'hidden' as const } } : {}), 'publicationAudit.id': { $ne: entryId } },
    { $set: { ...publication, updatedAt: now }, $inc: { revision: 1 },
      ...(withdrawMediaIds?.length ? { $addToSet: { withdrawnMediaIds: { $each: withdrawMediaIds } } } : {}),
      $push: { publicationAudit: { $each: [{ id: entryId, fingerprint, createdAt: now, change }], $slice: -100 } } }, { returnDocument: 'after' });
  if (!updated) {
    const current = await reports().findOne({ _id: id, ownerId });
    if (current?.publicationAudit?.some(entry => entry.id === entryId && entry.fingerprint === fingerprint)) {
      res.json(publicReport(current, true, ownerId)); return;
    }
    throw new InputError(409, 'Ada perubahan lain. Muat ulang laporan sebelum mengirim.');
  }
  res.json(publicReport(updated, true, ownerId));
}));
// end of helper ---------------------------------------------------------------------------------------
return reportRoutes;
}
export const reportRoutes = createReportRoutes();
