/* Verify community persistence and ownership against an isolated MongoDB.
Todo:
-> real database writes, with email delivery intercepted in this test only
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import sharp from 'sharp';

process.env.PUBLIC_REPORTS_ONLY = 'true';
process.env.COMMUNITY_REPORTS_ENABLED = 'true';
process.env.CORS_ORIGIN = 'http://127.0.0.1:3005';
process.env.APP_ORIGIN = 'http://127.0.0.1:3005';
process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = 'isolated-test-key';
process.env.EMAIL_FROM = 'LaporJalan <test@example.test>';
process.env.GCS_BUCKET_NAME = '';
const dbName = `lj_contributions_test_${randomUUID().replaceAll('-', '')}`;
const dbUri = `mongodb://127.0.0.1:27019/${dbName}`;
const nativeFetch = globalThis.fetch;
let lastLink = '', mailFails = false;
globalThis.fetch = async (input, init) => {
  if (String(input) === 'https://api.resend.com/emails') {
    if (mailFails) return new Response('{}', { status: 503 });
    const message = JSON.parse(String(init?.body));
    lastLink = /#masuk=([\w-]+)/.exec(message.text)![1];
    return new Response('{"id":"test-mail"}', { status: 200 });
  }
  if (String(input).startsWith('https://crm.jakarta.go.id/')) return new Response('[]');
  return nativeFetch(input, init);
};

test('community API preserves ownership, persistence and actual observations', async t => {
  await mongoose.connect(dbUri);
  const { initCommunity } = await import('../src/community/db.js');
  const { app } = await import('../src/app.js');
  await initCommunity();
  const db = mongoose.connection.db!;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/community`;
  const json = (path: string, body: unknown, token?: string, origin = process.env.APP_ORIGIN!) => nativeFetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const patch = (path: string, body: unknown, token: string) => nativeFetch(base + path, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: process.env.APP_ORIGIN!, Authorization: 'Bearer ' + token }, body: JSON.stringify(body),
  });
  async function login(email: string, returnTo = 'mine') {
    const response = await json('/auth/link', { email, returnTo }); assert.equal(response.status, 202);
    const link = lastLink;
    const exchange = await json('/auth/exchange', { token: link }); assert.equal(exchange.status, 200);
    return { ...(await exchange.json()), link };
  }
  const send = (path: string, token: string, values: Record<string, unknown>, media?: { mime: string; bytes: Buffer }) => {
    const body = new FormData();
    Object.entries(values).forEach(([key, value]) => body.set(key, String(value)));
    if (media) body.set('media', new Blob([new Uint8Array(media.bytes)], { type: media.mime }), 'evidence');
    return nativeFetch(base + path, { method: 'POST', headers: { Origin: process.env.APP_ORIGIN!, Authorization: `Bearer ${token}` }, body });
  };
  const input = { requestId: randomUUID(), category: 'road', title: 'Isolated test report', description: 'Synthetic data for the isolated test database only.',
    lng: 106.84, lat: -6.20, address: 'Test location', publicConsent: true };
  let owner: any, stranger: any, report: any;
  try {
    await t.test('empty database returns empty, never seed data', async () => {
      assert.deepEqual(await nativeFetch(base + '/reports').then(r => r.json()), { reports: [], nextCursor: null });
      assert.equal(await db.collection('reports').countDocuments(), 0);
      assert.equal((await json('/reports', input)).status, 401);
    });
    await t.test('login validates origin/email and does not claim failed email success', async () => {
      assert.equal((await json('/auth/link', { email: 'invalid' })).status, 400);
      assert.equal((await json('/auth/link', { email: 'owner@example.test' }, undefined, 'https://untrusted.example')).status, 403);
      mailFails = true;
      assert.equal((await json('/auth/link', { email: 'failure@example.test' })).status, 503);
      assert.equal(await db.collection('citizen_links').countDocuments({ email: 'failure@example.test' }), 0);
      mailFails = false;
    });
    await t.test('email links are one-use and expire; session secrets are hashed', async () => {
      owner = await login('owner@example.test'); stranger = await login('other@example.test');
      assert.equal((await json('/auth/exchange', { token: owner.link })).status, 401);
      const expired = randomBytes(32).toString('base64url');
      await db.collection<any>('citizen_links').insertOne({ _id: createHash('sha256').update(expired).digest('hex'), email: 'expired@example.test', expiresAt: new Date(Date.now() - 1000) });
      assert.equal((await json('/auth/exchange', { token: expired })).status, 401);
      const rows = await db.collection('citizen_sessions').find().toArray();
      assert.equal(JSON.stringify(rows).includes(owner.token), false);
      const race = await json('/auth/link', { email: 'race@example.test' }); assert.equal(race.status, 202);
      const results = await Promise.all([json('/auth/exchange', { token: lastLink }), json('/auth/exchange', { token: lastLink })]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
    });
    await t.test('password registration and login: hashed, no takeover, one answer for unknown email or wrong password', async () => {
      const email = `password-${randomUUID()}@example.test`;
      assert.equal((await json('/auth/register', { email, password: 'pendek' })).status, 400);
      assert.equal((await json('/auth/register', { email: 'invalid', password: 'kata-sandi-uji' })).status, 400);
      assert.equal((await json('/auth/register', { email, password: 'kata-sandi-uji' }, undefined, 'https://untrusted.example')).status, 403);
      const created = await json('/auth/register', { email: email.toUpperCase(), password: 'kata-sandi-uji', displayName: 'Nama Uji' });
      assert.equal(created.status, 201);
      const account = await created.json();
      assert.equal(account.user.email, email); assert.equal(account.user.displayName, 'Nama Uji'); assert.equal(JSON.stringify(account).includes('passwordHash'), false);
      const stored = await db.collection<any>('citizen_accounts').findOne({ email });
      assert.match(stored.passwordHash, /^scrypt\$/); assert.equal(stored.passwordHash.includes('kata-sandi-uji'), false);
      assert.equal((await nativeFetch(base + '/auth/session', { headers: { Authorization: 'Bearer ' + account.token } })).status, 200);
      // an existing email is never taken over, whether it came from registration or from an email link
      assert.equal((await json('/auth/register', { email, password: 'kata-sandi-lain' })).status, 409);
      assert.equal((await json('/auth/register', { email: 'owner@example.test', password: 'kata-sandi-uji' })).status, 409);
      const wrong = await json('/auth/login', { email, password: 'kata-sandi-salah' });
      const unknown = await json('/auth/login', { email: `nobody-${randomUUID()}@example.test`, password: 'kata-sandi-uji' });
      const linkOnly = await json('/auth/login', { email: 'owner@example.test', password: 'kata-sandi-uji' });
      assert.deepEqual([wrong.status, unknown.status, linkOnly.status], [401, 401, 401]);
      assert.equal((await wrong.json()).message, (await unknown.json()).message);
      const signedIn = await json('/auth/login', { email, password: 'kata-sandi-uji' });
      assert.equal(signedIn.status, 200);
      const session = await signedIn.json();
      assert.notEqual(session.token, account.token); assert.equal(session.user.id, account.user.id);
      const created2 = await send('/reports', session.token, { ...input, requestId: randomUUID() });
      assert.equal(created2.status, 201);
      await db.collection('citizen_reports').deleteOne({ _id: (await created2.json()).id });
    });
    await t.test('invalid location, consent, forged category and disguised media are rejected', async () => {
      for (const override of [{ lng: 999 }, { lat: '' }, { category: '__proto__' }, { publicConsent: false }, { title: '' }]) {
        assert.equal((await send('/reports', owner.token, { ...input, ...override })).status, 400);
      }
      assert.equal((await send('/reports', owner.token, input, { mime: 'image/png', bytes: Buffer.from('<svg><script>invalid</script></svg>') })).status, 400);
      assert.equal(await db.collection('citizen_reports').countDocuments(), 0);
    });
    await t.test('creation persists real fields, ignores forged owner/status and excludes private identity', async () => {
      const response = await send('/reports', owner.token, { ...input, ownerId: stranger.user.id, status: 'verified' });
      assert.equal(response.status, 201); report = await response.json();
      assert.equal(report.status, 'reported'); assert.equal(report.canUpdate, true);
      assert.equal(report.updates.length, 1); assert.equal(report.updates[0].actor, 'Pelapor');
      assert.equal(await db.collection('citizen_reports').countDocuments(), 1);
      const publicText = await nativeFetch(base + '/reports').then(r => r.text());
      for (const secret of [owner.user.email, owner.user.id, owner.token, 'fingerprint', 'ownerId']) assert.equal(publicText.includes(secret), false);
      assert.equal(JSON.stringify(report).includes('fingerprint'), false);
      assert.equal(report.widthCm, undefined);
    });
    await t.test('same-request retry is idempotent and different content conflicts', async () => {
      const responses = await Promise.all([send('/reports', owner.token, input), send('/reports', owner.token, input)]);
      assert.deepEqual(responses.map(r => r.status), [200, 200]);
      assert.equal(await db.collection('citizen_reports').countDocuments(), 1);
      assert.equal((await send('/reports', owner.token, { ...input, title: 'Different content' })).status, 409);
    });
    await t.test('only the report owner may append observations', async () => {
      const response = await send(`/reports/${report.id}/updates`, stranger.token, { requestId: randomUUID(), note: 'A stranger cannot alter status.', status: 'resolved_observed', revision: 0, publicConsent: true });
      assert.equal(response.status, 403);
      const detail = await nativeFetch(base + `/reports/${report.id}`, { headers: { Authorization: `Bearer ${stranger.token}` } }).then(r => r.json());
      assert.equal(detail.canUpdate, false); assert.equal(detail.updates.length, 1);
    });
    await t.test('updates atomically preserve history, support retry and reject stale revisions', async () => {
      const change = { requestId: randomUUID(), note: 'Work observed in this isolated test.', status: 'work_observed', revision: 0, publicConsent: true };
      const response = await send(`/reports/${report.id}/updates`, owner.token, change); assert.equal(response.status, 201);
      report = await response.json(); assert.equal(report.status, 'work_observed'); assert.equal(report.updates.length, 2);
      assert.equal((await send(`/reports/${report.id}/updates`, owner.token, change)).status, 200);
      assert.equal((await send(`/reports/${report.id}/updates`, owner.token, { ...change, requestId: randomUUID() })).status, 409);
      assert.equal((await send(`/reports/${report.id}/updates`, owner.token, { ...change, status: 'verified' })).status, 400);
    });
    await t.test('attachments persist and byte ranges work; unreferenced files are not public', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const response = await send('/reports', owner.token, { ...input, requestId: randomUUID() }, { mime: 'image/png', bytes: png });
      assert.equal(response.status, 201);
      const withMedia = await response.json(), path = `/reports/${withMedia.id}/media/${withMedia.media[0].id}`;
      const full = await nativeFetch(base + path); assert.equal(full.headers.get('content-type'), 'image/png');
      const clean = Buffer.from(await full.arrayBuffer());
      assert.deepEqual(await sharp(clean).raw().toBuffer(), await sharp(png).raw().toBuffer());
      const metadata = await sharp(clean).metadata(); assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
      const partial = await nativeFetch(base + path, { headers: { Range: 'bytes=0-9' } });
      assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 10);
      assert.equal((await nativeFetch(base + path, { headers: { Range: 'bytes=99999-' } })).status, 416);
      assert.equal((await nativeFetch(base + `/reports/${report.id}/media/${withMedia.media[0].id}`)).status, 404);
      assert.equal(await db.collection('citizen_media.files').countDocuments(), 1);
      const storedId = new mongoose.mongo.ObjectId(withMedia.media[0].id);
      await db.collection('citizen_media.files').updateOne({ _id: storedId }, { $unset: { 'metadata.processedVersion': '' } });
      assert.equal((await nativeFetch(base + path)).status, 503);
      await db.collection('citizen_media.files').updateOne({ _id: storedId }, { $set: { 'metadata.processedVersion': 1 } });
    });

    await t.test('capabilities distinguish disabled, storage and email without configuration leakage', async () => {
      const { ENV } = await import('../src/config/env.js');
      const original = { enabled: ENV.COMMUNITY_REPORTS_ENABLED, key: ENV.RESEND_API_KEY, origin: ENV.APP_ORIGIN };
      try {
        assert.deepEqual(await nativeFetch(base + '/capabilities').then(r => r.json()), { reports: true, write: true, login: true, emailLink: true, reason: null, analysis: { available: false, reason: 'model_disabled' } });
        ENV.COMMUNITY_REPORTS_ENABLED = false;
        assert.deepEqual(await nativeFetch(base + '/capabilities').then(r => r.json()), { reports: false, write: false, login: false, emailLink: false, reason: 'disabled', analysis: { available: false, reason: 'model_disabled' } });
        assert.equal((await nativeFetch(base + '/reports')).status, 503);
        ENV.COMMUNITY_REPORTS_ENABLED = true; ENV.RESEND_API_KEY = '';
        assert.deepEqual(await nativeFetch(base + '/capabilities').then(r => r.json()), { reports: true, write: true, login: true, emailLink: false, reason: null, analysis: { available: false, reason: 'model_disabled' } });
        ENV.RESEND_API_KEY = original.key; ENV.APP_ORIGIN = 'https://example.test/invalid';
        assert.deepEqual(await nativeFetch(base + '/capabilities').then(r => r.json()), { reports: true, write: false, login: false, emailLink: false, reason: 'origin_unconfigured', analysis: { available: false, reason: 'model_disabled' } });
        assert.equal((await nativeFetch(base + '/auth/session', { headers: { Authorization: 'Bearer ' + owner.token } })).status, 200);
        assert.equal((await patch('/auth/profile', { displayName: 'Unavailable write' }, owner.token)).status, 503);
      } finally { ENV.COMMUNITY_REPORTS_ENABLED = original.enabled; ENV.RESEND_API_KEY = original.key; ENV.APP_ORIGIN = original.origin; }
    });
    await t.test('login destination survives exchange while private profile never publishes implicitly', async () => {
      assert.equal((await json('/auth/link', { email: 'destination@example.test', returnTo: 'https://untrusted.example' })).status, 400);
      const destination = await login('destination@example.test', report.id);
      assert.equal(destination.returnTo, report.id);
      const oldToken = randomBytes(32).toString('base64url');
      await db.collection<any>('citizen_links').insertOne({ _id: createHash('sha256').update(oldToken).digest('hex'), email: 'old-link@example.test', expiresAt: new Date(Date.now() + 60000) });
      assert.equal((await json('/auth/exchange', { token: oldToken }).then(r => r.json())).returnTo, 'mine');
      const profile = await patch('/auth/profile', { displayName: '  Ame\u0301lie  ' }, owner.token);
      assert.equal(profile.status, 200);
      assert.equal((await profile.json()).user.displayName, 'Amélie');
      assert.equal((await patch('/auth/profile', { displayName: 'a'.repeat(41) }, owner.token)).status, 400);
      assert.equal((await patch('/auth/profile', { displayName: 'A\nB' }, owner.token)).status, 400);
      const session = await nativeFetch(base + '/auth/session', { headers: { Authorization: 'Bearer ' + owner.token } }).then(r => r.json());
      assert.equal(session.user.displayName, 'Amélie');
      assert.equal((await nativeFetch(base + '/auth/session?token=' + owner.token)).status, 401);
      assert.equal((await nativeFetch(base + '/auth/session', { headers: { Authorization: owner.token } })).status, 401);
      const existing = await nativeFetch(base + '/reports/' + report.id).then(r => r.json());
      assert.equal(existing.reporterName, undefined);
      assert.equal(existing.updates[0].actor, 'Pelapor');
      const ignored = await send('/reports', owner.token, { ...input, reporterName: 'Must remain private', nameConsent: false });
      assert.equal(ignored.status, 200); assert.equal((await ignored.json()).reporterName, undefined);
      assert.equal((await patch('/auth/profile', { displayName: '' }, owner.token).then(r => r.json())).user.displayName, undefined);
    });
    await t.test('consent, publication revisions and media withdrawals share owner-only atomic controls', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const creation = { ...input, requestId: randomUUID(), reporterName: '<b>Amélie</b>', nameConsent: true };
      const response = await send('/reports', owner.token, creation, { mime: 'image/png', bytes: png });
      assert.equal(response.status, 201);
      let named = await response.json();
      assert.equal(named.reporterName, '<b>Amélie</b>');
      assert.equal(named.updates[0].actor, named.reporterName);
      assert.equal((await send('/reports', owner.token, { ...creation, reporterName: 'Changed name' }, { mime: 'image/png', bytes: png })).status, 409);
      const target = '/reports/' + named.id + '/publication';
      const mediaPath = '/reports/' + named.id + '/media/' + named.media[0].id;
      assert.equal((await nativeFetch(base + mediaPath)).headers.get('cache-control'), 'no-store');
      const revoke = { requestId: randomUUID(), revision: named.revision, nameConsent: false };
      assert.equal((await patch(target, revoke, stranger.token)).status, 403);
      let result = await patch(target, revoke, owner.token); assert.equal(result.status, 200);
      named = await result.json(); assert.equal(named.reporterName, undefined);
      assert.equal(named.updates[0].actor, 'Pelapor');
      assert.equal((await patch(target, revoke, owner.token)).status, 200);
      assert.equal((await patch(target, { ...revoke, nameConsent: true, reporterName: 'Other' }, owner.token)).status, 409);
      assert.equal((await patch(target, { requestId: randomUUID(), revision: 0, visibility: 'withdrawn' }, owner.token)).status, 409);
      const race = await Promise.all([
        patch(target, { requestId: randomUUID(), revision: named.revision, nameConsent: true, reporterName: 'New name' }, owner.token),
        patch(target, { requestId: randomUUID(), revision: named.revision, visibility: 'withdrawn' }, owner.token),
      ]);
      assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
      named = await nativeFetch(base + '/reports/' + named.id, { headers: { Authorization: 'Bearer ' + owner.token } }).then(r => r.json());
      result = await patch(target, { requestId: randomUUID(), revision: named.revision, visibility: 'withdrawn' }, owner.token);
      assert.equal(result.status, 200); named = await result.json();
      assert.equal(named.canManage, true); assert.equal(named.canUpdate, false);
      assert.equal((await nativeFetch(base + '/reports/' + named.id)).status, 404);
      assert.equal((await nativeFetch(base + '/reports/' + named.id, { headers: { Authorization: 'Bearer ' + stranger.token } })).status, 404);
      assert.equal((await nativeFetch(base + mediaPath)).status, 404);
      assert.equal((await nativeFetch(base + mediaPath + '?token=' + owner.token)).status, 404);
      assert.equal((await nativeFetch(base + mediaPath, { headers: { Authorization: 'Bearer ' + owner.token } })).status, 200);
      assert.equal((await send('/reports/' + named.id + '/updates', owner.token, { requestId: randomUUID(), revision: named.revision, status: 'unchanged', note: 'Private reports cannot append observations.', publicConsent: true })).status, 409);
      const feed = await nativeFetch(base + '/reports').then(r => r.json());
      assert.equal(feed.reports.some((row: any) => row.id === named.id), false);
      const mine = await nativeFetch(base + '/reports?mine=true', { headers: { Authorization: 'Bearer ' + owner.token } }).then(r => r.json());
      assert.equal(mine.reports.some((row: any) => row.id === named.id && row.canManage), true);
      result = await patch(target, { requestId: randomUUID(), revision: named.revision, visibility: 'public', withdrawMediaIds: [named.media[0].id, named.media[0].id] }, owner.token);
      assert.equal(result.status, 200); named = await result.json();
      assert.equal(named.canUpdate, true); assert.equal(named.media.length, 0);
      assert.equal((await nativeFetch(base + mediaPath)).status, 404);
      assert.equal((await nativeFetch(base + mediaPath, { headers: { Authorization: 'Bearer ' + owner.token } })).status, 404);
      const privateRow = await db.collection<any>('citizen_reports').findOne({ _id: named.id });
      assert.equal(privateRow.withdrawnMediaIds.length, 1);
      assert.equal(privateRow.publicationAudit.length, 4);
      assert.equal(await db.collection('citizen_media.files').countDocuments(), 2);
      const publicText = await nativeFetch(base + '/reports/' + named.id).then(r => r.text());
      for (const secret of ['consentAudit', 'nameConsent', 'publicationAudit', 'withdrawnMediaIds', 'fingerprint', owner.user.id, owner.user.email]) assert.equal(publicText.includes(secret), false);
      await db.collection<any>('citizen_reports').updateOne({ _id: named.id }, { $set: { visibility: 'hidden' } });
      assert.equal((await nativeFetch(base + '/reports/' + named.id)).status, 404);
      assert.equal((await patch(target, { requestId: randomUUID(), revision: named.revision, visibility: 'public' }, owner.token)).status, 403);
      assert.equal((await nativeFetch(base + '/reports/' + named.id, { headers: { Authorization: 'Bearer ' + owner.token } })).status, 200);
      const fullAudit = Array.from({ length: 100 }, () => ({ id: randomUUID(), fingerprint: 'previous', createdAt: new Date().toISOString(), change: { nameConsent: true, reporterName: 'Previous name' } }));
      await db.collection<any>('citizen_reports').updateOne({ _id: named.id }, {
        $set: { publicationAudit: fullAudit, revision: 100, visibility: 'public', nameConsent: true, reporterName: 'Previous name' },
        $unset: { withdrawnMediaIds: '' },
      });
      const atCapacity = { requestId: randomUUID(), revision: 100, nameConsent: false, visibility: 'withdrawn', withdrawMediaIds: [privateRow.updates[0].media[0].id] };
      result = await patch(target, atCapacity, owner.token);
      assert.equal(result.status, 200); named = await result.json();
      assert.equal(named.reporterName, undefined); assert.equal(named.visibility, 'withdrawn'); assert.equal(named.media.length, 0);
      assert.equal(named.updates[0].actor, 'Pelapor');
      assert.equal((await patch(target, atCapacity, owner.token)).status, 200);
      const bounded = await db.collection<any>('citizen_reports').findOne({ _id: named.id });
      assert.equal(bounded.publicationAudit.length, 100);
      assert.equal(bounded.publicationAudit.at(-1).id, atCapacity.requestId);
      assert.equal(bounded.publicationAudit.some((entry: any) => entry.id === fullAudit[0].id), false);
      assert.equal((await nativeFetch(base + mediaPath)).status, 404);
    });

    await t.test('condition snapshots persist atomically, distinguish omission/clear and never refresh from publication', async () => {
      const author = await login('condition-owner@example.test');
      assert.equal((await nativeFetch(base + '/reports/' + report.id).then(r => r.json())).condition, undefined);
      const initialCondition = { kind: 'closure', observedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), locationConfirmed: true,
        source: 'government', access: 'closed', geometry: { type: 'LineString', coordinates: [[106.84, -6.2], [106.8401, -6.2001]] },
        dimensions: { method: 'measured', tool: 'meteran', lengthM: 10, widthM: 0.52, depthM: 0.075 } };
      const creation = { ...input, requestId: randomUUID(), condition: JSON.stringify(initialCondition) };
      assert.equal((await send('/reports', author.token, { ...creation, condition: '{invalid' })).status, 400);
      let response = await send('/reports', author.token, creation);
      assert.equal(response.status, 201);
      let current = await response.json(), target = '/reports/' + current.id;
      const canonical = { ...initialCondition, source: 'reporter' };
      assert.deepEqual(current.condition, canonical);
      assert.deepEqual(current.updates[0].condition, canonical);
      assert.equal(current.condition.dimensions.widthM, 0.52); assert.equal(current.condition.dimensions.depthM, 0.075);
      const reordered = { dimensions: { depthM: 0.075, widthM: 0.52, lengthM: 10, tool: 'meteran', method: 'measured' },
        geometry: { coordinates: initialCondition.geometry.coordinates, type: 'LineString' }, access: 'closed',
        source: 'reporter', locationConfirmed: true, observedAt: initialCondition.observedAt, kind: 'closure' };
      assert.equal((await send('/reports', author.token, { ...creation, condition: JSON.stringify(reordered) })).status, 200);
      assert.equal((await send('/reports', author.token, { ...creation, condition: JSON.stringify({ ...initialCondition, access: 'partial' }) })).status, 409);
      const { condition: _, ...withoutCondition } = creation;
      assert.equal((await send('/reports', author.token, withoutCondition)).status, 409);
      const observation = { requestId: randomUUID(), revision: current.revision, status: 'unchanged', note: 'A note preserves the existing observed condition.', publicConsent: true };
      assert.equal((await send(target + '/updates', stranger.token, { ...observation, condition: 'null' })).status, 403);
      response = await send(target + '/updates', author.token, observation);
      assert.equal(response.status, 201); current = await response.json();
      assert.deepEqual(current.condition, canonical);
      assert.equal(current.updates.at(-1).condition, undefined);
      assert.equal((await send(target + '/updates', author.token, observation)).status, 200);
      assert.equal((await send(target + '/updates', author.token, { ...observation, condition: 'null' })).status, 409);
      const changedCondition = { ...initialCondition, observedAt: new Date().toISOString(), access: 'partial',
        dimensions: { method: 'estimated', lengthM: 11 } };
      const changed = { requestId: randomUUID(), revision: current.revision, status: 'work_observed', note: 'The reporter has observed a new condition.', publicConsent: true,
        condition: JSON.stringify(changedCondition) };
      response = await send(target + '/updates', author.token, changed);
      assert.equal(response.status, 201); current = await response.json();
      assert.deepEqual(current.condition, { ...changedCondition, source: 'reporter' });
      assert.deepEqual(current.updates.at(-1).condition, current.condition);
      assert.deepEqual(current.updates[0].condition, canonical);
      assert.equal((await send(target + '/updates', author.token, { ...changed, condition: JSON.stringify({ ...changedCondition, dimensions: { method: 'estimated', lengthM: 12 } }) })).status, 409);
      const races = await Promise.all(['closed', 'unknown'].map(access => send(target + '/updates', author.token,
        { ...changed, requestId: randomUUID(), revision: current.revision, condition: JSON.stringify({ ...changedCondition, access }) })));
      assert.deepEqual(races.map(r => r.status).sort(), [201, 409]);
      current = await nativeFetch(base + target, { headers: { Authorization: 'Bearer ' + author.token } }).then(r => r.json());
      assert.deepEqual(current.condition, current.updates.at(-1).condition);
      const persisted = await db.collection<any>('citizen_reports').findOne({ _id: current.id });
      assert.deepEqual(persisted.condition, persisted.updates.at(-1).condition);
      const time = current.condition.observedAt;
      for (const visibility of ['withdrawn', 'public']) {
        response = await patch(target + '/publication', { requestId: randomUUID(), revision: current.revision, visibility, nameConsent: false }, author.token);
        assert.equal(response.status, 200); current = await response.json();
        assert.equal(current.condition.observedAt, time);
        assert.deepEqual(current.updates[0].condition, canonical);
      }
      const clearing = { ...observation, requestId: randomUUID(), revision: current.revision, condition: 'null' };
      response = await send(target + '/updates', author.token, clearing);
      assert.equal(response.status, 201); current = await response.json();
      assert.equal(current.condition, null); assert.equal(current.updates.at(-1).condition, null);
      assert.equal((await send(target + '/updates', author.token, clearing)).status, 200);
      const { condition: __, ...missing } = clearing;
      assert.equal((await send(target + '/updates', author.token, missing)).status, 409);
      const publicRow = await nativeFetch(base + target).then(r => r.json());
      assert.equal(publicRow.condition, null);
      assert.equal(publicRow.updates[0].condition.source, 'reporter');
      const publicFeed = await nativeFetch(base + '/reports').then(r => r.json());
      assert.equal(publicFeed.reports.find((row: any) => row.id === current.id).condition, null);
    });
    await t.test('email request limits are enforced in shared storage', async () => {
      for (let i = 0; i < 3; i++) assert.equal((await json('/auth/link', { email: 'limited@example.test' })).status, 202);
      assert.equal((await json('/auth/link', { email: 'limited@example.test' })).status, 429);
    });
    await t.test('disconnect never claims writes were saved; reconnect retains reports', async () => {
      await mongoose.disconnect();
      assert.deepEqual(await nativeFetch(base + '/capabilities').then(r => r.json()), { reports: false, write: false, login: false, emailLink: false, reason: 'storage_unavailable', analysis: { available: false, reason: 'model_disabled' } });
      assert.equal((await send('/reports', owner.token, { ...input, requestId: randomUUID() })).status, 503);
      await mongoose.connect(dbUri);
      const restored = await nativeFetch(base + `/reports/${report.id}`).then(r => r.json());
      assert.equal(restored.updates.length, 2); assert.equal(restored.status, 'work_observed');
    });
    await t.test('logout revokes writes and legacy endpoints remain closed', async () => {
      assert.equal((await json('/auth/logout', {}, owner.token)).status, 204);
      assert.equal((await send('/reports', owner.token, { ...input, requestId: randomUUID() })).status, 401);
      assert.equal((await nativeFetch(base.replace('/community', '/reports'))).status, 404);
    });
  } finally {
    assert.ok(mongoose.connection.name.startsWith('lj_contributions_test_'));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await new Promise<void>(resolve => server.close(() => resolve()));
    globalThis.fetch = nativeFetch;
  }
});
