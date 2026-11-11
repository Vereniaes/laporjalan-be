/* Verify the admin handling queue against an isolated MongoDB.
Todo:
-> admins only; status, unit, moderation and duplicates over warga + impor; the public sees the result, never the admin
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';

process.env.PUBLIC_REPORTS_ONLY = 'true';
process.env.COMMUNITY_REPORTS_ENABLED = 'true';
process.env.CORS_ORIGIN = 'http://127.0.0.1:3005';
process.env.APP_ORIGIN = 'http://127.0.0.1:3005';
process.env.NODE_ENV = 'test';
process.env.GCS_BUCKET_NAME = '';

test('admin handling: access, actions and what the public sees', async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27019/lj_admin_test_${randomUUID().replaceAll('-', '')}`);
  const { initCommunity } = await import('../src/community/db.js');
  const { app } = await import('../src/app.js');
  await initCommunity();
  const db = mongoose.connection.db!;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = (path: string, token?: string, body?: unknown) => fetch(root + path, { method: body ? 'POST' : 'GET',
    headers: { Origin: process.env.APP_ORIGIN!, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async (email: string) => (await call('/community/auth/register', undefined, { email, password: 'kata-sandi-uji' })).json();
  try {
    const admin = await register(`admin-${randomUUID()}@example.test`), citizen = await register(`warga-${randomUUID()}@example.test`);
    await db.collection('citizen_accounts').updateOne({ _id: admin.user.id } as any, { $set: { role: 'admin' } });
    assert.equal((await call('/community/auth/session', admin.token).then(r => r.json())).user.role, 'admin');
    assert.equal((await call('/community/auth/session', citizen.token).then(r => r.json())).user.role, undefined);

    // one imported report and one warga report
    const importedId = randomUUID();
    await db.collection<any>('imported_reports').insertOne({ _id: importedId, code: 'LJ-ADMN2345', sourceRef: 'a', reporterId: null, category: 'road', subcategory: 'Jalan',
      description: 'Lubang', address: 'Cakung', addressDetail: '', lat: -6.2, lng: 106.9, createdAt: new Date('2026-11-03T00:00:00Z'), updatedAt: new Date('2026-11-03T00:00:00Z'),
      status: 'Menunggu', statusSlug: 'menunggu', unit: 'KELURAHAN CAKUNG TIMUR', area: null, history: [], importedAt: new Date() });
    await db.collection<any>('imported_meta').insertOne({ _id: 'crm', importedAt: new Date(), dateStart: '2026-10-12', dateEnd: '2026-11-10' });
    const form = new FormData();
    Object.entries({ requestId: randomUUID(), category: 'road', title: 'Laporan warga uji admin', description: 'Isian uji terisolasi untuk admin.', lng: 106.84, lat: -6.2, address: 'Lokasi uji', publicConsent: true,
      condition: JSON.stringify({ kind: 'pothole', observedAt: '2026-11-03T00:00:00.000Z', locationConfirmed: true, source: 'reporter', geometry: { type: 'Point', coordinates: [106.84, -6.2] } }) })
      .forEach(([key, value]) => form.set(key, String(value)));
    // a new report needs a photo or video (owner, 10 Nov)
    form.set('media', new Blob([new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))], { type: 'image/png' }), 'bukti.png');
    const warga = await fetch(root + '/community/reports', { method: 'POST', headers: { Origin: process.env.APP_ORIGIN!, Authorization: `Bearer ${citizen.token}` }, body: form }).then(r => r.json());

    // access
    assert.equal((await call('/community/admin/summary')).status, 401);
    assert.equal((await call('/community/admin/summary', citizen.token)).status, 403);
    assert.equal((await call(`/community/admin/reports/impor/${importedId}/actions`, citizen.token, { action: 'hide' })).status, 403);
    const summary = await call('/community/admin/summary', admin.token).then(r => r.json());
    assert.equal(summary.total, 2); assert.equal(summary.unhandled, 2);
    const list = await call('/community/admin/reports?kind=impor', admin.token).then(r => r.json());
    assert.deepEqual(list.reports.map((row: any) => row.code), ['LJ-ADMN2345']);

    // status + unit: the public card shows them as the LaporJalan team, without the admin
    const act = (kind: string, id: string, body: object) => call(`/community/admin/reports/${kind}/${id}/actions`, admin.token, body);
    assert.equal((await act('impor', importedId, { action: 'status', status: 'bogus' })).status, 400);
    assert.equal((await act('impor', importedId, { action: 'status', status: 'diproses', note: 'Sudah diteruskan ke suku dinas.' })).status, 200);
    assert.equal((await act('impor', importedId, { action: 'assign', unit: 'SUDIN BINA MARGA JAKARTA TIMUR' })).status, 200);
    const detail = await call(`/public-reports/${importedId}`).then(r => r.json());
    assert.equal(detail.handling.status, 'Diproses'); assert.equal(detail.unit, 'SUDIN BINA MARGA JAKARTA TIMUR');
    assert.equal(detail.handling.history[0].unit, 'SUDIN BINA MARGA JAKARTA TIMUR');
    assert.equal(JSON.stringify(detail).includes(admin.user.id), false);
    assert.equal((await call('/community/admin/summary', admin.token).then(r => r.json())).byStatus.diproses, 1);

    // moderation of an imported report removes it from the map and its detail
    assert.equal((await act('impor', importedId, { action: 'hide', note: 'Data pribadi di deskripsi' })).status, 200);
    assert.equal((await call('/public-reports').then(r => r.json())).reports.length, 0);
    assert.equal((await call(`/public-reports/${importedId}`)).status, 404);
    await act('impor', importedId, { action: 'show' });
    assert.equal((await call('/public-reports').then(r => r.json())).reports.length, 1);

    // a warga report marked duplicate leaves the public list through its visibility, and comes back unchanged
    assert.equal((await act('warga', warga.id, { action: 'duplicate', duplicateOf: 'LJ-NOPE0000' })).status, 400);
    assert.equal((await act('warga', warga.id, { action: 'duplicate', duplicateOf: warga.code })).status, 400);
    assert.equal((await act('warga', warga.id, { action: 'duplicate', duplicateOf: 'lj-admn2345' })).status, 200);
    assert.equal((await call('/community/reports').then(r => r.json())).reports.length, 0);
    assert.equal((await db.collection('citizen_reports').findOne({ _id: warga.id } as any))!.visibility, 'hidden');
    await act('warga', warga.id, { action: 'unduplicate' });
    assert.equal((await call('/community/reports').then(r => r.json())).reports.length, 1);
    const handled = await call(`/community/admin/reports/warga/${warga.id}`, admin.token).then(r => r.json());
    assert.deepEqual(handled.handling.history.map((entry: any) => entry.action), ['duplicate', 'unduplicate']);
    assert.equal((await call(`/public-reports/${warga.id}/handling`)).status, 404); // no status or unit yet: nothing public
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
