/* Verify public source boundaries with isolated inputs, bukan data produk.
Todo:
-> reject private data and exercise source failure/cache behavior
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicReportsReader, normalizePublicReports, sourceDates } from '../src/services/publicReports.js';

const row = {
  id: 'test-road', code: 'TEST001', lat: -6.2, lng: 106.8, isPrivacy: false,
  complaintCategory: { id: '6330b1db-fba5-4fde-9dbf-8458ac58a9c5', name: 'Jalan' },
  createdAt: '2026-10-17T01:00:00.000Z', tstatus: { name: 'Disposisi' },
  content: 'PRIVATE FREE TEXT', reporter: 'PRIVATE IDENTITY', zone: { name: 'NOT AN ADDRESS' },
};
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('privacy must be explicitly false; only the exact Jalan category is admitted', () => {
  assert.equal(normalizePublicReports([row, { ...row, id: 'private', isPrivacy: true },
    { ...row, id: 'missing', isPrivacy: undefined }, { ...row, id: 'numeric', isPrivacy: 0 },
    { ...row, id: 'other', complaintCategory: { ...row.complaintCategory, name: 'Saluran Air' } }]).length, 1);
});
test('only the metadata allowlist crosses the boundary', () => {
  const result = normalizePublicReports([row])[0];
  assert.deepEqual(Object.keys(result).sort(), ['id', 'code', 'lat', 'lng', 'category', 'sourceCategory', 'createdAt', 'sourceStatus'].sort());
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(result.sourceStatus, 'Disposisi');
});
test('invalid coordinates, dates and duplicate IDs cannot become pins', () => {
  assert.equal(normalizePublicReports([row, row, { ...row, id: 'nan', lat: NaN },
    { ...row, id: 'range', lng: 190 }, { ...row, id: 'string', lng: '106.8' },
    { ...row, id: 'date', createdAt: 'tomorrow' }]).length, 1);
});
test('absent status remains absent and results are sorted by publication date', () => {
  const result = normalizePublicReports([row, { ...row, id: 'new', createdAt: '2026-10-17T02:00:00Z', tstatus: {} }]);
  assert.equal(result[0].id, 'new');
  assert.equal(result[0].sourceStatus, null);
});
test('wrong response shape fails, a real empty array succeeds', () => {
  for (const value of [null, {}, { data: [] }, 'error']) assert.throws(() => normalizePublicReports(value));
  assert.deepEqual(normalizePublicReports([]), []);
});
test('date window follows Jakarta midnight', () => {
  assert.deepEqual(sourceDates(Date.parse('2026-10-16T17:00:00Z')), { dateStart: '2026-10-16', dateEnd: '2026-10-17' });
});
test('concurrent readers share one request and cache the successful snapshot', async () => {
  let calls = 0;
  let url = '';
  const read = createPublicReportsReader(async input => { calls++; url = String(input); return response([row]); }, () => Date.parse('2026-10-17T01:00:00Z'));
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a, b);
  assert.equal(await read(), a);
  assert.equal(calls, 1);
  assert.equal(new URL(url).origin, 'https://crm.jakarta.go.id');
  assert.equal(new URL(url).searchParams.get('isPrivacy'), '0');
});
test('cache expires and never silently masks a failed update', async () => {
  let now = Date.parse('2026-10-17T01:00:00Z');
  let calls = 0;
  const read = createPublicReportsReader(async () => { if (++calls > 1) throw new Error('offline'); return response([row]); }, () => now);
  await read(); now += 300_001;
  await assert.rejects(read());
  await assert.rejects(read());
  assert.equal(calls, 2);
  now += 30_001;
  await assert.rejects(read());
  assert.equal(calls, 3);
});
test('a new Jakarta day bypasses the previous day cache', async () => {
  let now = Date.parse('2026-10-17T16:59:59Z');
  let calls = 0;
  const read = createPublicReportsReader(async () => { calls++; return response([]); }, () => now);
  await read(); now += 2000;
  assert.equal((await read()).source.dateEnd, '2026-10-18');
  assert.equal(calls, 2);
});
test('HTTP, content type, malformed JSON and oversized responses fail explicitly', async () => {
  for (const value of [new Response('bad', { status: 503 }), new Response('[]'),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response('[]', { headers: { 'content-type': 'application/json', 'content-length': '99999999' } }),
    new Response(' '.repeat(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(createPublicReportsReader(async () => value)());
  }
});
test('a stalled source is aborted within the configured timeout', async () => {
  const read = createPublicReportsReader(async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  await assert.rejects(read());
});
