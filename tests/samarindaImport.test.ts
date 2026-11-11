/* Verify how the public Jalan Peduli (Samarinda) map rows become LaporJalan reports.
Todo:
-> only point, status, damage level and time kept; free text and photos dropped; bad rows refused
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSamarinda, samarindaRef, samarindaStatus } from '../src/services/samarindaImport.js';

const row = { id_laporan: '2647050002', latitude: -0.519780000000000019, longitude: 117.116146999999998, deskripsi_laporan: 'Pak Budi 0812-3456-7890',
  foto_kerusakan: ['a.jpeg'], status: { nama_status: 'belum_dikerjakan' }, tingkat_kerusakan: 'sedang', created_at: '2026-11-10T14:03:28+08:00' };

test('a public map row keeps only the point, status, damage level and time', () => {
  const mapped = mapSamarinda(row)!;
  assert.equal(mapped.sourceId, '2647050002');
  assert.deepEqual(mapped.fields, { source: 'samarinda', category: 'road', subcategory: 'Jalan', description: 'Tingkat kerusakan sedang.',
    address: '', addressDetail: '', lat: -0.51978, lng: 117.116147, createdAt: new Date('2026-11-10T06:03:28Z'), status: 'Belum dikerjakan',
    statusSlug: 'belum_dikerjakan', unit: null, area: { village: null, district: null, city: 'Samarinda' }, reporterId: null });
  const text = JSON.stringify(mapped);
  for (const dropped of ['Budi', '0812', 'jpeg', 'foto']) assert.equal(text.includes(dropped), false, dropped);
});

test('rows without a usable id, point or time, or outside Indonesia, are refused', () => {
  assert.equal(mapSamarinda({ ...row, id_laporan: '' }), null);
  assert.equal(mapSamarinda({ ...row, id_laporan: '../x' }), null);
  assert.equal(mapSamarinda({ ...row, latitude: 'x' }), null);
  assert.equal(mapSamarinda({ ...row, latitude: -33.87, longitude: 151.21 }), null); // Sydney
  assert.equal(mapSamarinda({ ...row, created_at: 'kemarin' }), null);
  assert.equal(mapSamarinda(null), null);
  assert.equal(mapSamarinda({ ...row, id_laporan: 2647050003 })?.sourceId, '2647050003');
  assert.equal(mapSamarinda({ ...row, tingkat_kerusakan: '<b>parah</b>' })?.fields.description, '');
});

test('status slugs read as words; unknown ones are spelled out; refs are stable and per source', () => {
  assert.equal(samarindaStatus('telah_dikerjakan'), 'Selesai dikerjakan');
  assert.equal(samarindaStatus('menunggu_anggaran'), 'Menunggu anggaran');
  assert.equal(samarindaStatus('<script>'), 'Status belum tersedia');
  assert.equal(samarindaStatus(undefined), 'Status belum tersedia');
  assert.equal(samarindaRef('1'), samarindaRef('1'));
  assert.notEqual(samarindaRef('1'), samarindaRef('2'));
});
