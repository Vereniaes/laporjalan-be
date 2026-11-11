/* Check condition input independently of storage or services. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionInput, publicCondition, type Condition, type Category, type Position } from '../src/community/condition.js';
import { InputError } from '../src/community/db.js';

const anchor: Position = [106.84, -6.2];
const base = { kind: 'pothole', observedAt: '2026-01-01T10:00:00+07:00', locationConfirmed: true };
const parse = (value: unknown, category: Category = 'road') => conditionInput(JSON.stringify(value), category, anchor);
const bad = (value: unknown, category: Category = 'road') => assert.throws(() => parse(value, category), (error: unknown) => error instanceof InputError && error.status === 400);
const point = [106.8, -6.2], east = [106.81, -6.2], northEast = [106.81, -6.19], north = [106.8, -6.19];

test('conditions preserve omission, normalize reporter data and ignore forged authority', () => {
  assert.equal(conditionInput(undefined, 'road', anchor), undefined);
  assert.equal(conditionInput(null, 'road', anchor), null);
  assert.equal(parse(null), null);
  assert.throws(() => conditionInput('{invalid', 'road', anchor), InputError);
  assert.throws(() => conditionInput(base, 'road', anchor), InputError);
  const condition = parse({ ...base, source: 'government', ownerId: 'private', dimensions: { method: 'measured', tool: ' meteran ', widthM: 0.52, depthM: 0.075 } })!;
  assert.deepEqual(condition, { kind: 'pothole', observedAt: '2026-01-01T03:00:00.000Z', locationConfirmed: true, source: 'reporter',
    geometry: { type: 'Point', coordinates: anchor }, dimensions: { method: 'measured', tool: 'meteran', widthM: 0.52, depthM: 0.075 } });
  assert.equal(JSON.stringify(condition).includes('private'), false);
  assert.equal(parse(base)!.dimensions, undefined);
});
test('condition categories and road access stay within the frozen contract', () => {
  for (const [category, kinds] of Object.entries({ road: ['pothole', 'subsidence', 'crack', 'excavation', 'closure', 'other'],
    construction: ['construction', 'excavation', 'closure', 'other'], drain: ['blocked_drain', 'other'], burning: ['burning', 'other'] })) {
    for (const kind of kinds) assert.equal(parse({ ...base, kind }, category as Category)!.kind, kind);
  }
  bad({ ...base, kind: 'burning' }); bad({ ...base, kind: 'pothole' }, 'construction');
  bad({ ...base, kind: 'closure' }, 'drain'); bad({ ...base, kind: 'closure' }, 'burning');
  bad({ ...base, access: 'closed' });
  for (const access of [null, ['closed'], 'open', 0, {}]) bad({ ...base, kind: 'closure', access });
  assert.equal(parse({ ...base, kind: 'closure' })!.access, 'unknown');
  for (const access of ['unknown', 'partial', 'closed']) assert.equal(parse({ ...base, kind: 'closure', access })!.access, access);
});
test('observation dates require a real confirmed time without future fabrication', () => {
  for (const observedAt of ['2026-02-30T10:00:00Z', '2025-02-29T10:00:00Z', '2026-01-01', '2026-01-01T24:00:00Z', null, 0, 'invalid',
    new Date(Date.now() + 6 * 60_000).toISOString()]) bad({ ...base, observedAt });
  assert.equal(parse({ ...base, observedAt: '2024-02-29T10:00:00Z' })!.observedAt, '2024-02-29T10:00:00.000Z');
  for (const locationConfirmed of [undefined, false, 'true', 1]) bad({ ...base, locationConfirmed });
});
test('dimensions keep units and unknowns explicit without scalar coercion', () => {
  const dimensions = { method: 'estimated', widthM: 0.52, depthM: 0.075, lengthM: 1000 };
  assert.deepEqual(parse({ ...base, dimensions })!.dimensions, dimensions);
  assert.equal(parse({ ...base, dimensions: { method: 'estimated', depthM: 0 } })!.dimensions!.depthM, 0);
  for (const dimensions of [null, [], {}, { method: 'estimated' }, { widthM: 1 }, { method: 'measured', widthM: 1 },
    { method: 'measured', tool: ' ', widthM: 1 }, { method: 'measured', tool: 'meteran\nGPS', widthM: 1 },
    { method: 'estimated', widthM: '0.52' }, { method: 'estimated', depthM: null }, { method: 'estimated', lengthM: 0 },
    { method: 'estimated', widthM: -1 }, { method: 'estimated', depthM: -0.1 }, { method: 'estimated', depthM: 1001 }]) bad({ ...base, dimensions });
  assert.throws(() => conditionInput('{"kind":"pothole","observedAt":"2026-01-01T00:00:00Z","locationConfirmed":true,"dimensions":{"method":"estimated","widthM":1e400}}', 'road', anchor), InputError);
});
test('geometry rejects invalid numbers, out-of-envelope points and unsupported shapes', () => {
  for (const coordinates of [[null, -6.2], ['106.8', -6.2], [106.8, -6.2, 0], [151.2, -33.9], [106.8, 7.5], []]) {
    bad({ ...base, geometry: { type: 'Point', coordinates } });
  }
  for (const geometry of [null, {}, { type: 'MultiPoint', coordinates: [point, east] },
    { type: 'LineString', coordinates: [point] }, { type: 'LineString', coordinates: [point, east, point] },
    { type: 'LineString', coordinates: Array.from({ length: 65 }, (_, i) => [106.8 + i / 10000, -6.2]) }]) bad({ ...base, geometry });
  assert.deepEqual(parse({ ...base, geometry: { type: 'LineString', coordinates: [point, east] } })!.geometry, { type: 'LineString', coordinates: [point, east] });
});
test('polygon boundaries are closed, distinct, nonzero and free of crossings or overlap', () => {
  const geometry = { type: 'Polygon', coordinates: [[point, east, northEast, north, point]] };
  assert.deepEqual(parse({ ...base, geometry })!.geometry, geometry);
  for (const coordinates of [[[]], [[point, east, north]], [[point, east, [106.82, -6.2], point]],
    [[point, east, northEast, point], [point, east, northEast, point]],
    [[point, northEast, north, east, point]], [[point, east, north, east, point]],
    [[point, east, [106.805, -6.2], northEast, north, point]]]) bad({ ...base, geometry: { type: 'Polygon', coordinates } });
  const ring = Array.from({ length: 64 }, (_, i) => [106.8 + Math.cos(i / 64 * Math.PI * 2) * 0.001, -6.2 + Math.sin(i / 64 * Math.PI * 2) * 0.001]);
  assert.equal(parse({ ...base, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } })!.geometry.type, 'Polygon');
});
test('canonical fingerprints and DTO projection are independent of untrusted key order', () => {
  const a = parse({ ...base, dimensions: { method: 'estimated', lengthM: 2, widthM: 1 }, geometry: { type: 'Point', coordinates: anchor } });
  const b = parse({ geometry: { coordinates: anchor, type: 'Point' }, dimensions: { widthM: 1, lengthM: 2, method: 'estimated' },
    locationConfirmed: true, observedAt: base.observedAt, kind: 'pothole' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const polluted = { ...a, privateAudit: 'secret', source: 'government', geometry: { ...a!.geometry, privateAudit: 'secret' },
    dimensions: { ...a!.dimensions, privateAudit: 'secret' } } as unknown as Condition;
  assert.equal(JSON.stringify(publicCondition(polluted)).includes('secret'), false);
  assert.equal(publicCondition(polluted)!.source, 'reporter');
  assert.equal(publicCondition(null), null);
});

