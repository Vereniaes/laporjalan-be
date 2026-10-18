/* Verify community persistence and ownership against an isolated MongoDB.
Todo:
-> real database writes, with email delivery intercepted in this test only
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';

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
  async function login(email: string) {
    const response = await json('/auth/link', { email }); assert.equal(response.status, 202);
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
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), png);
      const partial = await nativeFetch(base + path, { headers: { Range: 'bytes=0-9' } });
      assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 10);
      assert.equal((await nativeFetch(base + path, { headers: { Range: 'bytes=99999-' } })).status, 416);
      assert.equal((await nativeFetch(base + `/reports/${report.id}/media/${withMedia.media[0].id}`)).status, 404);
      assert.equal(await db.collection('citizen_media.files').countDocuments(), 1);
    });
    await t.test('email request limits are enforced in shared storage', async () => {
      for (let i = 0; i < 3; i++) assert.equal((await json('/auth/link', { email: 'limited@example.test' })).status, 202);
      assert.equal((await json('/auth/link', { email: 'limited@example.test' })).status, 429);
    });
    await t.test('disconnect never claims writes were saved; reconnect retains reports', async () => {
      await mongoose.disconnect();
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
