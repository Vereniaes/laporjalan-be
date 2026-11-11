/* Verify how the public Jalan Kita 2.0 dashboard rows become LaporJalan reports.
Todo:
-> keep only "Jalan" rows, read only point/status/time/segment, NEVER read name/email/password/description
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapNational, nationalRef, nationalStatus } from '../src/services/nationalImport.js';

// a row shaped like data.map, including the personal fields the source leaks
const row = {
  id_laporan: 'SK00017276', status: 0, cat_a_name: 'Jalan', status_text: 'Selesai', nama_ruas: 'Jakarta - Bekasi',
  created_at: '2026-11-10 10:44:53', description: 'saya atas nama Rayzlan, hp 0812-3456-7890, tolong diperbaiki',
  location: { type: 'Point', coordinates: [106.9, -6.24] },
  userable: { name: 'Rayzlan', email: 'rayzlan@example.test', password_jaki: 'secret123', role_text: 'masyarakat' },
  media_complaints: [{ file: 'a.jpg', url_file: 'https://x/a.jpg' }],
};

test('a "Jalan" row keeps only point, status, time and the road-segment name; no personal field survives', () => {
  const mapped = mapNational(row)!;
  assert.equal(mapped.sourceId, 'SK00017276');
  assert.deepEqual(mapped.fields, { source: 'jalankita', category: 'road', subcategory: 'Jalan', description: '', address: 'Jakarta - Bekasi', addressDetail: '',
    lat: -6.24, lng: 106.9, createdAt: new Date('2026-11-10T10:44:53'), status: 'Selesai', statusSlug: '',
    unit: null, area: { village: null, district: null, city: null }, reporterId: null });
  const text = JSON.stringify(mapped);
  for (const leaked of ['Rayzlan', 'rayzlan@', 'secret123', 'password', '0812', 'a.jpg', 'saya atas nama']) assert.equal(text.includes(leaked), false, leaked);
});

test('non-road categories and unusable rows are dropped', () => {
  assert.equal(mapNational({ ...row, cat_a_name: 'Jembatan' }), null);
  assert.equal(mapNational({ ...row, cat_a_name: 'Bencana' }), null);
  assert.equal(mapNational({ ...row, location: { coordinates: [200, -6] } }), null); // out of range
  assert.equal(mapNational({ ...row, location: { coordinates: [151.2, -33.8] } }), null); // Sydney
  assert.equal(mapNational({ ...row, id_laporan: '' }), null);
  assert.equal(mapNational({ ...row, created_at: 'kemarin' }), null);
  assert.equal(mapNational(null), null);
});

test('status reads as words; refs are stable and distinct from other sources', () => {
  assert.equal(nationalStatus('Baru'), 'Baru');
  assert.equal(nationalStatus('proses lelang'), 'Proses lelang');
  assert.equal(nationalStatus(''), 'Status belum tersedia');
  assert.equal(nationalRef('1'), nationalRef('1'));
  assert.notEqual(nationalRef('1'), nationalRef('2'));
});
