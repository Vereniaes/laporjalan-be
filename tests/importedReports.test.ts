/* Verify that imported reports in the database are the map's data, with a detail for the card tabs.
Todo:
-> list from imported_reports (no source named), detail with history, 404 for unknown ids, live source when nothing is imported
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';

process.env.PUBLIC_REPORTS_ONLY = 'true';
process.env.COMMUNITY_REPORTS_ENABLED = 'false';
process.env.CORS_ORIGIN = 'http://127.0.0.1:3005';
const nativeFetch = globalThis.fetch;
let liveCalls = 0;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://crm.jakarta.go.id/')) { liveCalls++; return new Response('[]', { headers: { 'content-type': 'application/json' } }); }
  return nativeFetch(input, init);
};

test('the map reads imported reports from the database and falls back to the live source', async () => {
  const dbName = `lj_imported_test_${randomUUID().replaceAll('-', '')}`;
  await mongoose.connect(`mongodb://127.0.0.1:27019/${dbName}`);
  const { app } = await import('../src/app.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public-reports`;
  try {
    // nothing imported yet: the live source answers
    const empty = await nativeFetch(base).then(r => r.json());
    assert.equal(empty.source.name, 'CRM Jakarta · JAKI'); assert.equal(liveCalls, 1);

    const db = mongoose.connection.db!;
    const id = randomUUID();
    await db.collection<any>('imported_reports').insertOne({ _id: id, code: 'LJ-TEST2345', sourceRef: 'x', reporterId: null, category: 'drain',
      subcategory: 'Tutup Saluran', description: 'Tutup saluran hilang', address: 'Cakung', addressDetail: '', lat: -6.2, lng: 106.9,
      createdAt: new Date('2026-11-03T00:00:00Z'), updatedAt: new Date('2026-11-04T00:00:00Z'), status: 'Disposisi', statusSlug: 'disposisi',
      unit: 'SUDIN SDA', area: { village: 'CAKUNG TIMUR', district: 'CAKUNG', city: 'JAKARTA TIMUR' },
      history: [{ at: new Date('2026-11-03T05:00:00Z'), status: 'Disposisi', unit: 'SUDIN SDA', role: 'skpd', note: 'Mohon ditindaklanjuti' }], importedAt: new Date() });
    await db.collection<any>('imported_meta').insertOne({ _id: 'crm', importedAt: new Date('2026-11-10T00:00:00Z'), dateStart: '2026-10-12', dateEnd: '2026-11-10' });
    // a second source (owner, 11 Nov: beyond Jakarta): the range covers both
    await db.collection<any>('imported_meta').insertOne({ _id: 'samarinda', importedAt: new Date('2026-11-11T00:00:00Z'), dateStart: '2026-10-01', dateEnd: '2026-11-11' });

    await new Promise(resolve => setTimeout(resolve, 10));
    const snapshot = await nativeFetch(base).then(r => r.json());
    assert.equal(snapshot.reports.length, 1);
    assert.deepEqual(snapshot.reports[0], { id, code: 'LJ-TEST2345', lat: -6.2, lng: 106.9, category: 'drain', sourceCategory: 'Tutup Saluran',
      createdAt: '2026-11-03T00:00:00.000Z', sourceStatus: 'Disposisi' });
    assert.deepEqual([snapshot.source.dateStart, snapshot.source.dateEnd, snapshot.source.retrievedAt], ['2026-10-01', '2026-11-11', '2026-11-11T00:00:00.000Z']);
    assert.equal(snapshot.source.url, ''); assert.equal(JSON.stringify(snapshot).includes('crm.jakarta'), false);

    const detail = await nativeFetch(`${base}/${id}`).then(r => r.json());
    assert.equal(detail.unit, 'SUDIN SDA'); assert.equal(detail.history[0].note, 'Mohon ditindaklanjuti');
    assert.equal(JSON.stringify(detail).includes('sourceRef'), false);
    assert.equal((await nativeFetch(`${base}/${randomUUID()}`)).status, 404);
    assert.equal((await nativeFetch(`${base}/not-an-id`)).status, 404);
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    globalThis.fetch = nativeFetch;
  }
});
