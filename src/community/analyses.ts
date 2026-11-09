/* Keep photo analysis private and durable, with the model disabled by default.
Todo:
-> owner access, bounded admission and reporter receipts
-> no inference client or background worker in this phase
*/
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { currentAccount } from './auth.js';
import { database, hash, limit, route, uuid } from './db.js';
import { analysisMediaIdentity } from './media.js';
import { reports, published, type CitizenReport } from './reportStore.js';
import { conditionKindAllowed, type Condition } from './condition.js';
import { analysisError, analysisOutput, exactObject, positiveSuggestion, version,
  type AnalysisOutput, type AnalysisReceipt, type AnalysisReview } from './analysisContract.js';

export type AnalysisPolicy = { available: boolean; accountIds: readonly string[] };
export const disabledAnalysis: AnalysisPolicy = Object.freeze({ available: false, accountIds: Object.freeze([]) });
export const analysisCapability = (policy: AnalysisPolicy = disabledAnalysis) => ({ available: policy.available, reason: policy.available ? null : 'model_disabled' });
type Execution = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface AnalysisJob {
  _id: string; ownerId: string; reportId: string; requestId: string; requestFingerprint: string;
  mediaId: string; sourceEntryId: string; baseReportRevision: number; storedMediaSha256: string; mediaProcessedVersion: number;
  execution: Execution; active: boolean; attempt: number; jobVersion: number; createdAt: string; queuedUntil: Date;
  expiresAt: Date; startedAt?: string; completedAt?: string; leaseToken?: string; leaseUntil?: Date; executionDeadline?: Date;
  failureCode?: string; modelOutput?: AnalysisOutput; outputDigest?: string; modelDigest?: string;
  promptHash?: string; schemaHash?: string; preprocessingVersion?: string; derivativeSha256?: string;
  cancellation?: { requestId: string; fingerprint: string };
}
export const analyses = () => database().collection<AnalysisJob>('citizen_analyses');
const week = 7 * 24 * 60 * 60_000;
const unavailable = () => analysisError(503, 'model_disabled', 'Bantuan foto belum tersedia.');
export function validateAnalysisPolicy(policy: AnalysisPolicy) {
  if (policy.accountIds.length > 5 || new Set(policy.accountIds).size !== policy.accountIds.length || policy.accountIds.some(id => !uuid(id))) {
    throw new Error('Analysis pilot requires at most five unique account IDs');
  }
}
function available(policy: AnalysisPolicy, ownerId: string) { if (!policy.available || !policy.accountIds.includes(ownerId)) unavailable(); }
const fingerprint = (value: unknown) => hash(JSON.stringify(value));
const sourcePresent = (row: CitizenReport, job: AnalysisJob) => published(row) && !row.withdrawnMediaIds?.includes(job.mediaId) &&
  row.updates.some(entry => entry.id === job.sourceEntryId && entry.media.some(file => file.id === job.mediaId));

// expired active jobs (bounded recovery during owner requests, no automatic retries) ---------------------
// input param : existing job and current report
// output : current job after a guarded terminal transition
async function recover(job: AnalysisJob, row: CitizenReport) {
  if (!job.active) return job;
  const now = new Date();
  const reason = !sourcePresent(row, job) ? 'source_withdrawn' : row.revision !== job.baseReportRevision ? 'stale' :
    job.execution === 'queued' && job.queuedUntil <= now ? 'queue_expired' :
    job.execution === 'running' && (!job.leaseUntil || job.leaseUntil <= now || !job.executionDeadline || job.executionDeadline <= now) ? 'worker_lost' : null;
  if (!reason) return job;
  const updated = await analyses().findOneAndUpdate({ _id: job._id, ownerId: row.ownerId, active: true, jobVersion: job.jobVersion },
    { $set: { execution: reason === 'source_withdrawn' ? 'cancelled' : 'failed', active: false, failureCode: reason,
      completedAt: now.toISOString(), expiresAt: new Date(now.getTime() + week) }, $inc: { jobVersion: 1 } }, { returnDocument: 'after' });
  return updated ?? (await analyses().findOne({ _id: job._id, ownerId: row.ownerId })) ?? job;
}
// end of helper ---------------------------------------------------------------------------------------

function output(job: AnalysisJob) {
  const parsed = analysisOutput(job.modelOutput);
  if (job.outputDigest !== fingerprint(parsed) || ![job.storedMediaSha256, job.modelDigest, job.promptHash, job.schemaHash, job.derivativeSha256].every(value =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) || job.mediaProcessedVersion !== 1 ||
    typeof job.preprocessingVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(job.preprocessingVersion)) {
    analysisError(422, 'invalid_output', 'Hasil pemeriksaan tidak valid.');
  }
  return parsed;
}

function jobDTO(job: AnalysisJob, row: CitizenReport, policy: AnalysisPolicy) {
  const receipt = row.analysisReceipts?.find(item => item.analysisId === job._id);
  const suppressed = !sourcePresent(row, job), expired = job.expiresAt <= new Date();
  const stale = row.revision !== job.baseReportRevision && !receipt;
  let suggestion: AnalysisOutput | undefined, reason: string | null = suppressed ? 'source_withdrawn' : expired ? 'expired' : stale ? 'stale' : null;
  if (!suppressed && !expired && job.execution === 'succeeded') {
    try { suggestion = output(job); } catch { reason ??= 'invalid_output'; }
  }
  if (!reason && receipt) reason = 'already_reviewed';
  if (!reason && (!policy.available || !policy.accountIds.includes(row.ownerId))) reason = 'model_disabled';
  if (!reason && job.execution !== 'succeeded') reason = job.failureCode && ['queue_expired', 'worker_lost', 'timeout', 'oom',
    'invalid_output', 'invalid_media', 'stale', 'source_withdrawn', 'service_unavailable'].includes(job.failureCode) ? job.failureCode : job.execution;
  if (!reason && suggestion) reason = suggestion.qualityFlags.length ? 'photo_quality' : !positiveSuggestion(suggestion) ? 'manual_only' :
    suggestion.kindSuggestion === 'possible_closure' ? 'manual_closure' : !conditionKindAllowed(suggestion.kindSuggestion, row.category) ? 'category_mismatch' : null;
  return { analysisId: job._id, reportId: row._id, mediaId: job.mediaId, sourceEntryId: job.sourceEntryId,
    baseReportRevision: job.baseReportRevision, jobVersion: job.jobVersion, execution: job.execution,
    freshness: suppressed ? 'suppressed' : stale || expired ? 'stale' : 'fresh', review: receipt?.decision ?? 'pending', applicable: !reason,
    reason, createdAt: job.createdAt, ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}), expiresAt: job.expiresAt.toISOString(), pollAfterMs: 3000,
    revision: row.revision, ...(suggestion ? { suggestion } : {}) };
}

function fresh(job: AnalysisJob, row: CitizenReport, expectedRevision: number) {
  if (!sourcePresent(row, job)) analysisError(410, 'source_withdrawn', 'Sumber foto tidak tersedia untuk saran ini.');
  if (job.expiresAt <= new Date()) analysisError(409, 'expired', 'Hasil pemeriksaan telah kedaluwarsa.');
  if (row.revision !== expectedRevision || job.baseReportRevision !== expectedRevision) analysisError(409, 'stale', 'Laporan berubah setelah pemeriksaan ini.');
  if (row.analysisReceipts?.some(item => item.analysisId === job._id)) analysisError(409, 'already_reviewed', 'Saran telah ditinjau.');
  if ((row.analysisReceipts?.length ?? 0) >= 100) analysisError(409, 'review_limit', 'Batas tinjauan tercapai.');
}

export async function reviewReceipt(row: CitizenReport, review: AnalysisReview, expectedRevision: number,
  requestId: string, requestFingerprint: string, condition: Condition | null | undefined, policy: AnalysisPolicy): Promise<AnalysisReceipt> {
  available(policy, row.ownerId);
  const job = await analyses().findOne({ _id: review.analysisId, reportId: row._id, ownerId: row.ownerId });
  if (!job) analysisError(404, 'not_found', 'Pemeriksaan tidak ditemukan.');
  fresh(job, row, expectedRevision);
  if (job.execution !== 'succeeded') analysisError(409, 'not_ready', 'Pemeriksaan belum selesai.');
  const source = row.updates.find(entry => entry.id === job.sourceEntryId)!.media.find(file => file.id === job.mediaId)!;
  const identity = await analysisMediaIdentity(source);
  if (identity.storedMediaSha256 !== job.storedMediaSha256 || identity.mediaProcessedVersion !== job.mediaProcessedVersion) {
    analysisError(409, 'source_changed', 'Sumber foto berubah setelah pemeriksaan.');
  }
  const suggestion = output(job);
  if (!condition || !positiveSuggestion(suggestion)) analysisError(422, 'manual_only', 'Pengamatan lengkap perlu diisi manual.');
  const accepted = condition.kind === suggestion.kindSuggestion;
  if ((review.decision === 'accepted') !== accepted || (suggestion.kindSuggestion === 'possible_closure' && condition.kind !== 'closure')) {
    analysisError(422, 'invalid_review', 'Keputusan jenis tidak sesuai pengamatan.');
  }
  return receipt(job, requestId, requestFingerprint, review.decision, review.acceptedFields, review.correctedFields, condition.kind);
}

function receipt(job: AnalysisJob, requestId: string, requestFingerprint: string, decision: AnalysisReceipt['decision'],
  acceptedFields: string[], correctedFields: string[], confirmedKind?: string): AnalysisReceipt {
  const suggestion = output(job);
  return { requestId, fingerprint: requestFingerprint, analysisId: job._id, decision, acceptedFields, correctedFields,
    suggestedKind: suggestion.kindSuggestion, ...(confirmedKind ? { confirmedKind } : {}), outputDigest: job.outputDigest!,
    mediaId: job.mediaId, sourceEntryId: job.sourceEntryId, storedMediaSha256: job.storedMediaSha256,
    modelDigest: job.modelDigest!, promptHash: job.promptHash!, schemaHash: job.schemaHash!, preprocessingVersion: job.preprocessingVersion!,
    confirmedAt: new Date().toISOString() };
}

export function createAnalysisRoutes(policy: AnalysisPolicy = disabledAnalysis) {
  validateAnalysisPolicy(policy);
  policy = Object.freeze({ available: policy.available, accountIds: Object.freeze([...policy.accountIds]) });
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => { void (async () => {
    const account = await currentAccount(req), id = String(req.params.id);
    const row = uuid(id) ? await reports().findOne({ _id: id, ownerId: account._id }) : null;
    if (!row) analysisError(404, 'not_found', 'Laporan tidak ditemukan.');
    if (!['GET', 'HEAD'].includes(req.method)) await limit('write', account._id, 40, 60 * 60_000);
    res.locals.report = row;
    next();
  })().catch(next); });
  router.get('/', route(async (req, res) => {
    const latest = req.query.latest === 'true';
    if ((!latest && req.query.active !== 'true') || Object.keys(req.query).length !== 1) analysisError(400, 'invalid_input', 'Pilih pemeriksaan yang tersedia.');
    const row = res.locals.report as CitizenReport;
    const job = await analyses().findOne({ reportId: row._id, ownerId: row.ownerId, ...(!latest ? { active: true } : {}) },
      { sort: { createdAt: -1, _id: -1 } });
    res.json({ analysis: job ? jobDTO(await recover(job, row), row, policy) : null });
  }));
  router.post('/', route(async (req, res) => {
    const body = exactObject(req.body, ['requestId', 'mediaId', 'expectedRevision']);
    if (!uuid(body.requestId) || typeof body.mediaId !== 'string' || !/^[a-f0-9]{24}$/.test(body.mediaId)) analysisError(400, 'invalid_input', 'Pemeriksaan tidak valid.');
    const expectedRevision = version(body.expectedRevision), row = res.locals.report as CitizenReport;
    const requestFingerprint = fingerprint({ reportId: row._id, mediaId: body.mediaId, expectedRevision });
    const previous = await analyses().findOne({ ownerId: row.ownerId, requestId: String(body.requestId) });
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) analysisError(409, 'request_conflict', 'ID pengiriman sudah digunakan untuk isi lain.');
      res.json(jobDTO(await recover(previous, row), row, policy)); return;
    }
    available(policy, row.ownerId);
    if (!published(row) || row.withdrawnMediaIds?.includes(body.mediaId)) analysisError(410, 'source_withdrawn', 'Pilih foto yang masih tersedia.');
    if (row.revision !== expectedRevision) analysisError(409, 'stale', 'Ada pembaruan lain. Muat ulang laporan.');
    const entry = row.updates.find(item => item.media.some(file => file.id === body.mediaId));
    const file = entry?.media.find(item => item.id === body.mediaId);
    if (!entry || !file) analysisError(400, 'invalid_media', 'Pilih foto milik laporan ini.');
    const active = await analyses().findOne({ ownerId: row.ownerId, active: true });
    if (active) {
      const activeReport = await reports().findOne({ _id: active.reportId, ownerId: row.ownerId });
      if (activeReport) await recover(active, activeReport);
    }
    await limit('analysis', row.ownerId, 10, 60 * 60_000);
    const identity = await analysisMediaIdentity(file), now = new Date();
    const current = await reports().findOne({ _id: row._id, ownerId: row.ownerId, revision: expectedRevision,
      visibility: { $in: [null, 'public'] }, withdrawnMediaIds: { $ne: file.id } });
    if (!current) analysisError(409, 'stale', 'Laporan berubah sebelum pemeriksaan.');
    const job: AnalysisJob = { _id: randomUUID(), ownerId: row.ownerId, reportId: row._id, requestId: String(body.requestId), requestFingerprint,
      mediaId: file.id, sourceEntryId: entry.id, baseReportRevision: expectedRevision, ...identity, execution: 'queued', active: true,
      attempt: 0, jobVersion: 0, createdAt: now.toISOString(), queuedUntil: new Date(now.getTime() + 10 * 60_000), expiresAt: new Date(now.getTime() + week) };
    try { await analyses().insertOne(job); }
    catch (error: any) {
      if (error.code !== 11000) throw error;
      const replay = await analyses().findOne({ ownerId: row.ownerId, requestId: job.requestId });
      if (replay?.requestFingerprint === requestFingerprint) { res.json(jobDTO(replay, row, policy)); return; }
      analysisError(409, replay ? 'request_conflict' : 'analysis_active', replay ? 'ID pengiriman sudah digunakan.' : 'Masih ada pemeriksaan yang berjalan.');
    }
    res.status(202).json(jobDTO(job, current, policy));
  }));
  router.use('/:analysisId', (req, res, next) => { void (async () => {
    const row = res.locals.report as CitizenReport, id = String(req.params.analysisId);
    const job = uuid(id) ? await analyses().findOne({ _id: id, ownerId: row.ownerId, reportId: row._id }) : null;
    if (!job) analysisError(404, 'not_found', 'Pemeriksaan tidak ditemukan.');
    res.locals.analysis = await recover(job, row);
    next();
  })().catch(next); });
  router.get('/:analysisId', route(async (_req, res) => { res.json(jobDTO(res.locals.analysis, res.locals.report, policy)); }));
  router.post('/:analysisId/cancel', route(async (req, res) => {
    const body = exactObject(req.body, ['requestId', 'expectedJobVersion']);
    if (!uuid(body.requestId)) analysisError(400, 'invalid_input', 'ID pengiriman tidak valid.');
    const job = res.locals.analysis as AnalysisJob, expectedJobVersion = version(body.expectedJobVersion);
    const requestFingerprint = fingerprint({ expectedJobVersion });
    if (job.cancellation && job.cancellation.requestId === body.requestId) {
      if (job.cancellation.fingerprint !== requestFingerprint) analysisError(409, 'request_conflict', 'ID pengiriman sudah digunakan untuk isi lain.');
      res.json(jobDTO(job, res.locals.report, policy)); return;
    }
    const now = new Date();
    const updated = await analyses().findOneAndUpdate({ _id: job._id, ownerId: job.ownerId, active: true, jobVersion: expectedJobVersion,
      execution: { $in: ['queued', 'running'] } }, { $set: { active: false, execution: 'cancelled', completedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + week), cancellation: { requestId: String(body.requestId), fingerprint: requestFingerprint } },
      $inc: { jobVersion: 1 } }, { returnDocument: 'after' });
    if (!updated) {
      const current = await analyses().findOne({ _id: job._id, ownerId: job.ownerId });
      if (current && current.cancellation && current.cancellation.requestId === body.requestId && current.cancellation.fingerprint === requestFingerprint) {
        res.json(jobDTO(current, res.locals.report, policy)); return;
      }
      analysisError(409, 'job_changed', 'Pemeriksaan sudah berubah.');
    }
    res.json(jobDTO(updated, res.locals.report, policy));
  }));
  router.post('/:analysisId/reject', route(async (req, res) => {
    const body = exactObject(req.body, ['requestId', 'expectedRevision']);
    if (!uuid(body.requestId)) analysisError(400, 'invalid_input', 'ID pengiriman tidak valid.');
    const expectedRevision = version(body.expectedRevision), row = res.locals.report as CitizenReport, job = res.locals.analysis as AnalysisJob;
    const requestFingerprint = fingerprint({ analysisId: job._id, decision: 'rejected' });
    const previous = row.analysisReceipts?.find(item => item.requestId === body.requestId);
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) analysisError(409, 'request_conflict', 'ID pengiriman sudah digunakan untuk isi lain.');
      res.json(jobDTO(job, row, policy)); return;
    }
    available(policy, row.ownerId);
    fresh(job, row, expectedRevision);
    if (job.execution !== 'succeeded') analysisError(409, 'not_ready', 'Pemeriksaan belum selesai.');
    const decision = receipt(job, String(body.requestId), requestFingerprint, 'rejected', [], []);
    const updated = await reports().findOneAndUpdate({ _id: row._id, ownerId: row.ownerId, revision: expectedRevision,
      visibility: { $in: [null, 'public'] }, withdrawnMediaIds: { $ne: job.mediaId }, 'analysisReceipts.analysisId': { $ne: job._id },
      'analysisReceipts.requestId': { $ne: String(body.requestId) }, 'updates.id': { $ne: String(body.requestId) } },
      { $push: { analysisReceipts: decision }, $inc: { revision: 1 } }, { returnDocument: 'after' });
    if (!updated) {
      const current = await reports().findOne({ _id: row._id, ownerId: row.ownerId });
      if (current?.analysisReceipts?.some(item => item.requestId === body.requestId && item.fingerprint === requestFingerprint)) {
        res.json(jobDTO(job, current, policy)); return;
      }
      analysisError(409, 'report_changed', 'Ada pembaruan lain. Tinjau versi terbaru.');
    }
    res.json(jobDTO(job, updated, policy));
  }));
  return router;
}
