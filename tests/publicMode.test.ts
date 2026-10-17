/* Check the deployable read-only API, tanpa database atau writes.
Todo:
-> verify mode, CORS and disabled legacy routes
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

test('public-only mode exposes metadata and health but no legacy writes', async () => {
  process.env.PUBLIC_REPORTS_ONLY = 'true';
  process.env.CORS_ORIGIN = 'https://frontend.example';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  const { app } = await import('../src/app.js');
  globalThis.fetch = realFetch;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await realFetch(`${base}/health`).then(response => response.json());
    assert.equal(health.mode, 'public-reports');
    assert.equal(health.database, 'not-used');
    const response = await realFetch(`${base}/api/public-reports`, { headers: { Origin: 'https://frontend.example' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://frontend.example');
    assert.deepEqual((await response.json()).reports, []);
    for (const [path, method] of [['/api/reports', 'GET'], ['/api/reports', 'POST'], ['/api/reports/test', 'PATCH'], ['/api/cctv', 'GET'], ['/api/traffic', 'GET'], ['/api/places/autocomplete', 'GET']]) {
      assert.equal((await realFetch(`${base}${path}`, { method })).status, 404);
    }
    assert.equal((await realFetch(`${base}/api/public-reports`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
