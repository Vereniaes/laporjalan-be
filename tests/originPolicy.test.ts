/* Verify which page addresses may write (sign in, register, report).
Todo:
-> development: any local address on any port; production: only the configured origins (APP_ORIGIN, comma-separated)
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('local addresses write in development; production keeps to APP_ORIGIN', async () => {
  const { ENV } = await import('../src/config/env.js');
  const { appOrigin, originAllowed } = await import('../src/community/auth.js');
  const original = { env: ENV.NODE_ENV, origin: ENV.APP_ORIGIN };
  try {
    ENV.NODE_ENV = 'development'; ENV.APP_ORIGIN = 'http://localhost:3001';
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:3002', 'http://[::1]:5173', 'http://192.168.1.20:3001', 'http://172.20.10.5:5173', 'http://10.0.0.7:3000'])
      assert.equal(originAllowed(origin), true, origin);
    for (const origin of ['https://evil.example', 'http://172.32.0.1:3001', 'http://localhost.evil.example', 'null', '', undefined])
      assert.equal(originAllowed(origin), false, String(origin));

    ENV.NODE_ENV = 'production'; ENV.APP_ORIGIN = 'https://lapor-jalan-two.vercel.app, https://laporjalan.example';
    assert.equal(appOrigin(), 'https://lapor-jalan-two.vercel.app'); // emailed links use the first
    assert.equal(originAllowed('https://laporjalan.example'), true);
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001', 'https://evil.example']) assert.equal(originAllowed(origin), false, origin);
  } finally { ENV.NODE_ENV = original.env; ENV.APP_ORIGIN = original.origin; }
});
