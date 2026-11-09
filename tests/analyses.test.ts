/* Verify private analysis routes against an isolated database, without any model.
Todo:
-> exercise owner access, durable admission and real report CAS confirmation
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { analysisOutput, analysisReview } from '../src/community/analysisContract.js';
import { hash, initCommunity, InputError } from '../src/community/db.js';
import type { AnalysisJob } from '../src/community/analyses.js';
import type { CitizenReport } from '../src/community/reportStore.js';

const suggestion = { kindSuggestion: 'pothole', visibleEvidence: ['Permukaan berlubang'], qualityFlags: [],
  captionSuggestion: 'Terlihat lubang pada permukaan.', needsHumanReview: true };
test('suggestions and reviews enforce the P5 shape without output coercion', () => {
  assert.deepEqual(analysisOutput(suggestion), suggestion);
  const unicode = { ...suggestion, visibleEvidence: [' x ', 'x'], captionSuggestion: '𐍈'.repeat(240) };
  assert.deepEqual(analysisOutput(unicode), unicode);
  assert.throws(() => analysisOutput({ ...unicode, captionSuggestion: '𐍈'.repeat(241) }), InputError);
  for (const value of [null, [], {}, { ...suggestion, kindSuggestion: 'closure' }, { ...suggestion, needsHumanReview: false },
    { ...suggestion, confidence: 0.99 }, { ...suggestion, qualityFlags: ['blurred', 'blurred'] },
    { ...suggestion, qualityFlags: ['safe'] }, { ...suggestion, visibleEvidence: ['same', 'same'] },
    { ...suggestion, visibleEvidence: Array(5).fill('a') }, { ...suggestion, captionSuggestion: 'x'.repeat(241) },
    { ...suggestion, visibleEvidence: ['x'.repeat(161)] }, { ...suggestion, captionSuggestion: 123 }]) {
    assert.throws(() => analysisOutput(value), InputError);
  }
  const review = { analysisId: randomUUID(), decision: 'accepted', acceptedFields: ['kind'], correctedFields: [] };
  assert.deepEqual(analysisReview(JSON.stringify(review)), review);
  for (const value of [null, '{bad', { ...review, acceptedFields: ['caption'] }, { ...review, acceptedFields: ['kind', 'access'] },
    { ...review, outputDigest: 'client-forgery' }, { ...review, decision: 'rejected' }]) assert.throws(() => analysisReview(value), InputError);
});

test('private analysis API preserves model-off defaults, ownership and report CAS', async t => {
  Object.assign(process.env, { NODE_ENV: 'test', PUBLIC_REPORTS_ONLY: 'true', COMMUNITY_REPORTS_ENABLED: 'true',
    APP_ORIGIN: 'http://127.0.0.1:3005', CORS_ORIGIN: 'http://127.0.0.1:3005', RESEND_API_KEY: '', EMAIL_FROM: '',
    GCS_BUCKET_NAME: '', GCP_PROJECT_ID: '', GOOGLE_MAPS_API_KEY: '', MONGODB_URI: '' });
  const dbName = `lj_p6_test_${randomUUID().replaceAll('-', '')}`;
  await mongoose.connect(`mongodb://127.0.0.1:27019/${dbName}`);
  const { createCommunityRouter } = await import('../src/community/index.js');
  const { analyses, validateAnalysisPolicy } = await import('../src/community/analyses.js');
  const { reports } = await import('../src/community/reportStore.js');
  const { saveMedia, analysisMediaIdentity } = await import('../src/community/media.js');
  await initCommunity();
  const ownerId = randomUUID(), strangerId = randomUUID(), token = randomBytes(32).toString('base64url'), otherToken = randomBytes(32).toString('base64url');
  for (const [id, bearer] of [[ownerId, token], [strangerId, otherToken]]) {
    await mongoose.connection.db!.collection('citizen_accounts').insertOne({ _id: id as any, email: `${id}@example.test` });
    await mongoose.connection.db!.collection('citizen_sessions').insertOne({ _id: hash(bearer) as any, accountId: id, expiresAt: new Date(Date.now() + 3_600_000) });
  }
  const policy = { available: true, accountIds: [ownerId] };
  const app = express();
  app.use('/off', createCommunityRouter());
  app.use('/ready', createCommunityRouter(policy));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(base), 'No model, email or external HTTP call is allowed');
    return nativeFetch(url, init);
  };
  const request = (path: string, body?: unknown, bearer: string | null = token, prefix = '/ready', method = body === undefined ? 'GET' : 'POST') =>
    fetch(base + prefix + path, { method, headers: { Origin: process.env.APP_ORIGIN!, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const update = (row: CitizenReport, values: Record<string, unknown> = {}, prefix = '/ready') => {
    const body = new FormData();
    Object.entries({ requestId: randomUUID(), revision: row.revision, status: 'unchanged', publicConsent: true,
      note: 'Kondisi ditinjau oleh pelapor.', ...values }).forEach(([key, value]) => body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value)));
    return fetch(base + prefix + `/reports/${row._id}/updates`, { method: 'POST', headers: { Origin: process.env.APP_ORIGIN!, Authorization: 'Bearer ' + token }, body });
  };
  const condition = (kind = 'pothole') => ({ kind, observedAt: '2026-01-01T03:00:00Z', locationConfirmed: true });
  const review = (id: string, decision = 'accepted') => ({ analysisId: id, decision, acceptedFields: decision === 'accepted' ? ['kind'] : [], correctedFields: decision === 'corrected' ? ['kind'] : [] });
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  async function fixture() {
    await mongoose.connection.db!.collection('citizen_limits').deleteMany({});
    const media = await saveMedia([{ buffer: photo, mimetype: 'image/png', size: photo.length } as Express.Multer.File]);
    const id = randomUUID(), now = new Date().toISOString();
    const row: CitizenReport = { _id: id, ownerId, category: 'road', title: 'Isolated photo test', description: 'Only an isolated test fixture.',
      address: '', lat: -6.2, lng: 106.84, createdAt: now, updatedAt: now, status: 'reported', revision: 0,
      updates: [{ id, note: 'Only an isolated test fixture.', status: 'reported', createdAt: now, media, fingerprint: hash(id) }] };
    await reports().insertOne(row);
    return row;
  }
  async function completed(row: CitizenReport, overrides: Record<string, unknown> = {}) {
    const modelOutput = analysisOutput({ ...suggestion, ...overrides }), now = new Date();
    const job: AnalysisJob = { _id: randomUUID(), ownerId, reportId: row._id, requestId: randomUUID(), requestFingerprint: hash(randomUUID()),
      mediaId: row.updates[0].media[0].id, sourceEntryId: row._id, baseReportRevision: row.revision,
      ...await analysisMediaIdentity(row.updates[0].media[0]), execution: 'succeeded', active: false, attempt: 1, jobVersion: 2,
      createdAt: now.toISOString(), queuedUntil: new Date(now.getTime() + 600_000), completedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 604_800_000),
      modelOutput, outputDigest: hash(JSON.stringify(modelOutput)), modelDigest: hash('isolated-model'), promptHash: hash('isolated-prompt'),
      schemaHash: hash('isolated-schema'), preprocessingVersion: 'isolated-1024-v1', derivativeSha256: hash('isolated-derivative') };
    await analyses().insertOne(job);
    return job;
  }
  try {
    await t.test('default capability and admission/confirmation stay disabled; manual reports remain usable', async () => {
      const row = await fixture(), job = await completed(row), path = `/reports/${row._id}/analyses`;
      assert.deepEqual((await request('/capabilities', undefined, null, '/off').then(r => r.json())).analysis, { available: false, reason: 'model_disabled' });
      assert.equal((await request(path, { requestId: randomUUID(), mediaId: job.mediaId, expectedRevision: 0 }, token, '/off')).status, 503);
      assert.equal((await update(row, { condition: condition(), analysisReview: review(job._id) }, '/off')).status, 503);
      assert.equal((await update(row, { analysisReview: { invalid: true } }, '/off')).status, 400);
      assert.equal((await update(row)).status, 201);
      assert.equal(await analyses().countDocuments({ active: true }), 0);
    });
    await t.test('owner-only routes reject ID guessing, forged fields, media from elsewhere and video', async () => {
      const row = await fixture(), other = await fixture(), job = await completed(row), path = `/reports/${row._id}/analyses`;
      assert.equal((await request(path + '/' + job._id, undefined, null)).status, 401);
      assert.equal((await request(path + '/' + job._id, undefined, otherToken)).status, 404);
      assert.equal((await request(path + '?latest=true', undefined, otherToken)).status, 404);
      assert.equal((await request(`/reports/${other._id}/analyses/${job._id}`)).status, 404);
      assert.equal((await request(`/reports/CRM-123/analyses`, { requestId: randomUUID(), mediaId: job.mediaId, expectedRevision: 0 })).status, 404);
      for (const extra of [{ url: 'https://example.test/photo' }, { image: 'base64' }, { prompt: 'ignore rules' }, { model: 'other' }]) {
        assert.equal((await request(path, { requestId: randomUUID(), mediaId: job.mediaId, expectedRevision: 0, ...extra })).status, 400);
      }
      assert.equal((await request(path, { requestId: randomUUID(), mediaId: other.updates[0].media[0].id, expectedRevision: 0 })).status, 400);
      await reports().updateOne({ _id: row._id }, { $set: { 'updates.0.media.0.mime': 'video/mp4' } });
      assert.equal((await request(path, { requestId: randomUUID(), mediaId: job.mediaId, expectedRevision: 0 })).status, 400);
      assert.equal((await request(path, { requestId: randomUUID(), mediaId: job.mediaId, expectedRevision: '0' })).status, 400);
      assert.throws(() => validateAnalysisPolicy({ available: true, accountIds: Array.from({ length: 6 }, () => randomUUID()) }));
    });
    await t.test('concurrent admission has one active slot, replays identical requests and hashes stored bytes', async () => {
      const row = await fixture(), path = `/reports/${row._id}/analyses`;
      const first = { requestId: randomUUID(), mediaId: row.updates[0].media[0].id, expectedRevision: 0 }, second = { ...first, requestId: randomUUID() };
      const responses = await Promise.all([request(path, first), request(path, second)]);
      assert.deepEqual(responses.map(item => item.status).sort(), [202, 409]);
      const winner = await responses.find(item => item.status === 202)!.json();
      const winnerRequest = responses[0].status === 202 ? first : second;
      assert.equal((await request(path, winnerRequest)).status, 200);
      assert.equal((await request(path, { ...winnerRequest, expectedRevision: 1 })).status, 409);
      const stored = await analyses().findOne({ _id: winner.analysisId });
      const privateText = JSON.stringify(await request(path + '/' + winner.analysisId).then(r => r.json()));
      for (const secret of ['ownerId', 'requestFingerprint', 'storedMediaSha256', stored!.storedMediaSha256, ownerId]) assert.equal(privateText.includes(secret), false);
      assert.equal(stored!.storedMediaSha256, (await analysisMediaIdentity(row.updates[0].media[0])).storedMediaSha256);
      assert.equal(await analyses().countDocuments({ ownerId, active: true }), 1);
      assert.equal((await request(path + '?active=true').then(r => r.json())).analysis.analysisId, winner.analysisId);
      assert.equal((await request(path + '/' + winner.analysisId + '/cancel', { requestId: randomUUID(), expectedJobVersion: 3 })).status, 409);
      const cancel = { requestId: randomUUID(), expectedJobVersion: winner.jobVersion };
      assert.equal((await request(path + '/' + winner.analysisId + '/cancel', cancel)).status, 200);
      assert.equal((await request(path + '/' + winner.analysisId + '/cancel', cancel)).status, 200);
      assert.equal((await request(path + '/' + winner.analysisId + '/cancel', { ...cancel, expectedJobVersion: 2 })).status, 409);
    });
    await t.test('success resumes privately; confirmation is atomic and replay survives removed job', async () => {
      const row = await fixture(), job = await completed(row), path = `/reports/${row._id}/analyses`;
      const dto = await request(path + '?latest=true').then(r => r.json());
      assert.equal(dto.analysis.execution, 'succeeded'); assert.equal(dto.analysis.applicable, true);
      assert.equal((await request(path + '/' + job._id + '/cancel', { requestId: randomUUID(), expectedJobVersion: 2 })).status, 409);
      const values = { requestId: randomUUID(), condition: condition(), analysisReview: review(job._id) };
      const results = await Promise.all([update(row, values), update(row, values)]);
      assert.ok(results.every(result => [200, 201].includes(result.status)));
      const saved = (await reports().findOne({ _id: row._id }))!;
      assert.equal(saved.updates.length, 2); assert.equal(saved.analysisReceipts!.length, 1); assert.equal(saved.revision, 1);
      assert.equal(saved.condition!.source, 'reporter'); assert.equal(saved.analysisReceipts![0].decision, 'accepted');
      assert.equal((await update(row, { ...values, condition: condition('crack') })).status, 409);
      await analyses().deleteOne({ _id: job._id });
      assert.equal((await update(row, values)).status, 200);
      const publicText = JSON.stringify(await request(`/reports/${row._id}`, undefined, null).then(r => r.json()));
      for (const secret of ['analysisReceipts', job._id, job.outputDigest!, job.storedMediaSha256, job.modelDigest!, 'captionSuggestion', ownerId]) assert.equal(publicText.includes(secret), false);
    });
    await t.test('different confirmations and withdrawal race have only one report CAS winner', async () => {
      const row = await fixture(), job = await completed(row);
      const responses = await Promise.all([update(row, { condition: condition(), analysisReview: review(job._id) }), update(row, { condition: condition('crack'), analysisReview: review(job._id, 'corrected') })]);
      assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
      const next = await fixture(), nextJob = await completed(next);
      const race = await Promise.all([update(next, { condition: condition(), analysisReview: review(nextJob._id) }),
        request(`/reports/${next._id}/publication`, { requestId: randomUUID(), revision: 0, withdrawMediaIds: [nextJob.mediaId] }, token, '/ready', 'PATCH')]);
      assert.equal(race.filter(response => response.status === 409).length, 1);
      assert.equal((await reports().findOne({ _id: next._id }))!.revision, 1);
    });
    await t.test('negative/flagged/unknown output cannot create or clear reporter condition', async () => {
      for (const overrides of [{ kindSuggestion: 'unknown' }, { kindSuggestion: 'no_visible_issue' }, { kindSuggestion: 'other' }, { qualityFlags: ['blurred'] }]) {
        const row = await fixture(), job = await completed(row, overrides);
        assert.equal((await update(row, { condition: condition(), analysisReview: review(job._id) })).status, 422);
        assert.equal((await reports().findOne({ _id: row._id }))!.condition, undefined);
      }
      const row = await fixture(), job = await completed(row);
      for (const value of [undefined, null]) assert.equal((await update(row, { ...(value === null ? { condition: null } : {}), analysisReview: review(job._id) })).status, 422);
    });
    await t.test('category and closure require manual correction; private rejection leaves public state untouched', async () => {
      const row = await fixture(), job = await completed(row, { kindSuggestion: 'construction' });
      assert.equal((await update(row, { condition: condition('construction'), analysisReview: review(job._id) })).status, 400);
      assert.equal((await update(row, { condition: condition('excavation'), analysisReview: review(job._id, 'corrected') })).status, 201);
      const closure = await fixture(), closureJob = await completed(closure, { kindSuggestion: 'possible_closure' });
      assert.equal((await update(closure, { condition: condition('closure'), analysisReview: review(closureJob._id) })).status, 422);
      const accepted = await update(closure, { condition: condition('closure'), analysisReview: review(closureJob._id, 'corrected') });
      assert.equal(accepted.status, 201); assert.equal((await accepted.json()).condition.access, 'unknown');
      const rejected = await fixture(), rejectedJob = await completed(rejected), path = `/reports/${rejected._id}/analyses/${rejectedJob._id}/reject`;
      const body = { requestId: randomUUID(), expectedRevision: 0 };
      assert.equal((await request(path, body)).status, 200); assert.equal((await request(path, body)).status, 200);
      const saved = (await reports().findOne({ _id: rejected._id }))!;
      assert.equal(saved.updates.length, 1); assert.equal(saved.updatedAt, rejected.updatedAt); assert.equal(saved.status, rejected.status); assert.equal(saved.revision, 1);
    });
    await t.test('stale, expired and withdrawn sources are enforced on every private read and confirmation', async () => {
      const row = await fixture(), job = await completed(row), path = `/reports/${row._id}/analyses/${job._id}`;
      await reports().updateOne({ _id: row._id }, { $inc: { revision: 1 } });
      assert.equal((await request(path).then(r => r.json())).freshness, 'stale');
      assert.equal((await update(row, { condition: condition(), analysisReview: review(job._id) })).status, 409);
      await reports().updateOne({ _id: row._id }, { $set: { revision: 0, withdrawnMediaIds: [job.mediaId] } });
      const suppressed = await request(path).then(r => r.json());
      assert.equal(suppressed.freshness, 'suppressed'); assert.equal(suppressed.suggestion, undefined);
      assert.equal((await update(row, { condition: condition(), analysisReview: review(job._id) })).status, 410);
      const expired = await fixture(), expiredJob = await completed(expired);
      await analyses().updateOne({ _id: expiredJob._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const response = await request(`/reports/${expired._id}/analyses/${expiredJob._id}`).then(r => r.json());
      assert.equal(response.suggestion, undefined); assert.equal(response.reason, 'expired');
      assert.equal((await update(expired, { condition: condition(), analysisReview: review(expiredJob._id) })).status, 409);
    });
    await t.test('queued expiry and lost leases release the slot without retry or exposing stored output', async () => {
      for (const execution of ['queued', 'running'] as const) {
        const row = await fixture(), job = await completed(row);
        await analyses().updateOne({ _id: job._id }, { $set: { execution, active: true, queuedUntil: new Date(Date.now() - 1000),
          leaseUntil: new Date(Date.now() - 1000), executionDeadline: new Date(Date.now() - 1000) } });
        const dto = await request(`/reports/${row._id}/analyses/${job._id}`).then(r => r.json());
        assert.equal(dto.execution, 'failed'); assert.equal(dto.reason, execution === 'queued' ? 'queue_expired' : 'worker_lost');
        assert.equal(dto.suggestion, undefined);
        const saved = (await analyses().findOne({ _id: job._id }))!;
        assert.equal(saved.active, false); assert.equal(saved.attempt, 1); assert.equal(saved.jobVersion, 3);
      }
    });
    await t.test('cancel races a controlled completion with one terminal winner', async () => {
      const row = await fixture(), job = await completed(row);
      await analyses().updateOne({ _id: job._id }, { $set: { execution: 'running', active: true,
        leaseUntil: new Date(Date.now() + 150_000), executionDeadline: new Date(Date.now() + 120_000) } });
      const [cancel, completion] = await Promise.all([
        request(`/reports/${row._id}/analyses/${job._id}/cancel`, { requestId: randomUUID(), expectedJobVersion: 2 }),
        analyses().findOneAndUpdate({ _id: job._id, active: true, jobVersion: 2, execution: 'running' },
          { $set: { active: false, execution: 'succeeded' }, $inc: { jobVersion: 1 } }, { returnDocument: 'after' }),
      ]);
      assert.equal(Number(cancel.status === 200) + Number(!!completion), 1);
      const saved = (await analyses().findOne({ _id: job._id }))!;
      assert.equal(saved.active, false); assert.equal(saved.jobVersion, 3);
    });
    await t.test('malformed stored results and full private ledgers fail without changing observations', async () => {
      const row = await fixture(), job = await completed(row);
      await analyses().updateOne({ _id: job._id }, { $set: { outputDigest: hash('wrong output') } });
      const dto = await request(`/reports/${row._id}/analyses/${job._id}`).then(r => r.json());
      assert.equal(dto.reason, 'invalid_output'); assert.equal(dto.suggestion, undefined);
      assert.equal((await update(row, { condition: condition(), analysisReview: review(job._id) })).status, 422);
      await analyses().updateOne({ _id: job._id }, { $set: { outputDigest: job.outputDigest } });
      await reports().updateOne({ _id: row._id }, { $set: { analysisReceipts: Array.from({ length: 100 }, () => ({
        requestId: randomUUID(), analysisId: randomUUID(), fingerprint: hash('existing receipt'), decision: 'rejected', acceptedFields: [],
        correctedFields: [], suggestedKind: 'unknown', outputDigest: hash('old'), mediaId: job.mediaId, sourceEntryId: row._id,
        storedMediaSha256: job.storedMediaSha256, modelDigest: job.modelDigest!, promptHash: job.promptHash!, schemaHash: job.schemaHash!,
        preprocessingVersion: job.preprocessingVersion!, confirmedAt: new Date().toISOString(),
      })) } });
      assert.equal((await update(row, { condition: condition(), analysisReview: review(job._id) })).status, 409);
      const saved = (await reports().findOne({ _id: row._id }))!;
      assert.equal(saved.updates.length, 1); assert.equal(saved.analysisReceipts!.length, 100); assert.equal(saved.revision, 0);
    });
    await t.test('confirmation rechecks stored media existence, version and actual bytes before report CAS', async () => {
      const db = mongoose.connection.db!;
      for (const change of ['missing', 'incomplete', 'version', 'bytes'] as const) {
        const row = await fixture(), job = await completed(row), fileId = new mongoose.mongo.ObjectId(job.mediaId);
        if (change === 'missing') await new mongoose.mongo.GridFSBucket(db, { bucketName: 'citizen_media' }).delete(fileId);
        if (change === 'incomplete') await db.collection('citizen_media.chunks').deleteMany({ files_id: fileId });
        if (change === 'version') await db.collection('citizen_media.files').updateOne({ _id: fileId }, { $set: { 'metadata.processedVersion': 2 } });
        if (change === 'bytes') {
          const chunk = (await db.collection('citizen_media.chunks').findOne({ files_id: fileId }))!;
          const bytes = Buffer.from(chunk.data.buffer); bytes[0] ^= 1;
          await db.collection('citizen_media.chunks').updateOne({ _id: chunk._id }, { $set: { data: new mongoose.mongo.Binary(bytes) } });
        }
        const response = await update(row, { condition: condition(), analysisReview: review(job._id) });
        assert.equal(response.status, change === 'bytes' ? 409 : 422);
        assert.equal((await response.json()).code, change === 'bytes' ? 'source_changed' : 'invalid_media');
        const saved = (await reports().findOne({ _id: row._id }))!;
        assert.equal(saved.revision, 0); assert.equal(saved.updates.length, 1); assert.equal(saved.analysisReceipts, undefined);
        assert.equal(saved.updates[0].media[0].id, job.mediaId);
      }
    });
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(mongoose.connection.name.startsWith('lj_p6_test_'));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
