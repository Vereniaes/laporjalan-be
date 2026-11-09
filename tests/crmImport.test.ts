/* Verify how public CRM records become LaporJalan reports.
Todo:
-> strict category labels, masked contact data, no reporter id from generic names, stable mapping
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, labelCategory, mapDetail, randomCode, reporterId, splitContent, sourceRef } from '../src/services/crmImport.js';

test('only our categories are kept, burning only when the text says so', () => {
  assert.equal(labelCategory('Jalan', ''), 'road');
  assert.equal(labelCategory('Keluhan Galian/Sisa Proyek', ''), 'construction');
  assert.equal(labelCategory('Tutup Saluran', ''), 'drain');
  assert.equal(labelCategory('Sampah', 'Ada warga membakar sampah di bahu jalan'), 'burning');
  assert.equal(labelCategory('Pencemaran Lingkungan', 'asap pembakaran kabel'), 'burning');
  assert.equal(labelCategory('Sampah', 'Sampah menumpuk'), null);
  for (const other of ['Parkir Liar', 'Trotoar', 'Pohon', undefined]) assert.equal(labelCategory(other, 'bakar'), null);
});

test('contact numbers, emails and NIK-like numbers are masked; content is split into parts', () => {
  const text = cleanText('Hubungi 0812-3456-7890 atau +62 812 3456 7890, email a.b@example.test, NIK 3171234567890001.\n\n  Terima kasih');
  assert.equal(/\d{7,}|@/.test(text.replace(/\[disamarkan\]/g, '')), false);
  assert.equal(text.split('[disamarkan]').length - 1, 4);
  const parts = splitContent('Permasalahan: Jalan berlubang besar Kategori: Jalan Lokasi: Cakung, Jalan Raya Bekasi Detail Alamat Laporan: depan halte');
  assert.deepEqual(parts, { description: 'Jalan berlubang besar', address: 'Cakung, Jalan Raya Bekasi', addressDetail: 'depan halte' });
  assert.equal(splitContent('Teks bebas tanpa label').description, 'Teks bebas tanpa label');
});

test('generic or masked names give no reporter id; a real name gives a stable id that does not contain it', () => {
  for (const name of ['Anonim', 'Warga', '*****', '', null]) assert.equal(reporterId(name, 'salt'), null);
  const id = reporterId('Nama Uji', 'salt');
  assert.match(id!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(reporterId(' nama uji ', 'salt'), id);
  assert.notEqual(reporterId('Nama Uji', 'other-salt'), id);
  assert.match(randomCode(), /^LJ-[2-9A-HJ-NP-Z]{8}$/);
  assert.equal(sourceRef('x'), sourceRef('x')); assert.notEqual(sourceRef('x'), sourceRef('y'));
});

test('a detail maps to our fields with named statuses, units and newest history first', () => {
  const lookups = { status: new Map([['disposisi', 'Disposisi'], ['menunggu', 'Menunggu']]), zone: new Map([['z1', 'SUDIN BINA MARGA']]) };
  const row = mapDetail({
    id: 's1', name: 'Anonim', content: 'Permasalahan: Lubang 0812 3456 7890 Lokasi: Cakung', lat: -6.2, lng: 106.9, createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z',
    status: 'disposisi', tstatus: { name: 'Disposisi' }, zone: { name: 'SUDIN BINA MARGA' }, complaintCategory: { name: 'Jalan' },
    village: { name: 'CAKUNG TIMUR', district: { name: 'CAKUNG', city: { name: 'JAKARTA TIMUR' } } },
    documents: [{ url: 'https://example.test/photo.jpg' }],
    history: [{ createdAt: '2026-11-03T01:00:00Z', status: 'menunggu', assignedToZone: 'unknown', assignedToRole: 'lurah', comment: '' },
      { createdAt: '2026-11-03T05:00:00Z', status: 'disposisi', assignedToZone: 'z1', assignedToRole: 'skpd', comment: 'Mohon ditindaklanjuti' }],
  }, 'road', lookups, 'salt');
  assert.equal(row.reporterId, null);
  assert.equal(row.description, 'Lubang [disamarkan]');
  assert.equal(row.address, 'Cakung');
  assert.deepEqual(row.area, { village: 'CAKUNG TIMUR', district: 'CAKUNG', city: 'JAKARTA TIMUR' });
  assert.deepEqual(row.history.map(entry => [entry.status, entry.unit, entry.role]), [['Disposisi', 'SUDIN BINA MARGA', 'skpd'], ['Menunggu', null, 'lurah']]);
  assert.equal(JSON.stringify(row).includes('photo.jpg'), false); // no photos
  assert.equal(JSON.stringify(row).includes('Anonim'), false);
});
