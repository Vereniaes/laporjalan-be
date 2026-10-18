/* Email login and private sessions for report owners.
Todo:
-> consume links once and keep identity out of public reports
*/
import { Router, type Request } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { ENV } from '../config/env.js';
import { database, field, hash, InputError, limit, route } from './db.js';

type Account = { _id: string; email: string };
type LoginLink = { _id: string; email: string; expiresAt: Date };
type Session = { _id: string; accountId: string; expiresAt: Date };
const secret = () => randomBytes(32).toString('base64url');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{43}$/.test(value);

export async function currentAccount(req: Request) {
  const token = req.get('Authorization')?.replace(/^Bearer /, '');
  if (!validToken(token)) throw new InputError(401, 'Silakan masuk melalui email.');
  const session = await database().collection<Session>('citizen_sessions').findOne({ _id: hash(token), expiresAt: { $gt: new Date() } });
  const account = session && await database().collection<Account>('citizen_accounts').findOne({ _id: session.accountId });
  if (!account) throw new InputError(401, 'Sesi berakhir. Silakan masuk kembali.');
  return account;
}

export function appOrigin() {
  let url: URL;
  try { url = new URL(ENV.APP_ORIGIN); } catch { throw new InputError(503, 'Alamat aplikasi belum dikonfigurasi.'); }
  const local = ENV.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new InputError(503, 'Alamat aplikasi belum dikonfigurasi.');
  }
  return url.origin;
}

export const authRoutes = Router();
authRoutes.post('/link', route(async (req, res) => {
  const email = field(req.body.email, 3, 254, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError(400, 'Email tidak valid.');
  const origin = appOrigin();
  if (!ENV.RESEND_API_KEY || !ENV.EMAIL_FROM) throw new InputError(503, 'Layanan email belum dikonfigurasi.');
  await limit('email', email, 3, 15 * 60_000);
  await limit('email-total', 'all', 100, 60 * 60_000);
  const token = secret();
  const links = database().collection<LoginLink>('citizen_links');
  const _id = hash(token);
  await links.insertOne({ _id, email, expiresAt: new Date(Date.now() + 15 * 60_000) });
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${ENV.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ENV.EMAIL_FROM, to: [email], subject: 'Masuk ke LaporJalan',
        text: `Buka tautan untuk masuk ke LaporJalan:\n${origin}/#masuk=${token}\n\nBerlaku 15 menit dan hanya sekali. Jangan bagikan tautan ini. Abaikan jika tidak meminta masuk.` }),
    });
    if (!response.ok) throw new Error('Email unavailable');
  } catch {
    await links.deleteOne({ _id });
    throw new InputError(503, 'Email belum berhasil dikirim. Silakan coba lagi.');
  }
  res.status(202).json({ message: 'Tautan masuk telah dikirim. Periksa kotak masuk dan spam.' });
}));

authRoutes.post('/exchange', route(async (req, res) => {
  if (!validToken(req.body.token)) throw new InputError(400, 'Tautan masuk tidak valid.');
  const link = await database().collection<LoginLink>('citizen_links').findOneAndDelete({ _id: hash(req.body.token), expiresAt: { $gt: new Date() } });
  if (!link) throw new InputError(401, 'Tautan sudah digunakan atau kedaluwarsa. Minta tautan baru.');
  const accounts = database().collection<Account>('citizen_accounts');
  let account: Account | null;
  try {
    account = await accounts.findOneAndUpdate({ email: link.email }, { $setOnInsert: { _id: randomUUID(), email: link.email } }, { upsert: true, returnDocument: 'after' });
  } catch (error: any) {
    if (error.code !== 11000) throw error;
    account = await accounts.findOne({ email: link.email });
  }
  if (!account) throw new InputError(503, 'Sesi belum dapat dibuat.');
  const token = secret();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  await database().collection<Session>('citizen_sessions').insertOne({ _id: hash(token), accountId: account._id, expiresAt });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token, expiresAt, user: { id: account._id, email: account.email } });
}));
authRoutes.get('/session', route(async (req, res) => {
  const account = await currentAccount(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: { id: account._id, email: account.email } });
}));
authRoutes.post('/logout', route(async (req, res) => {
  const token = req.get('Authorization')?.replace(/^Bearer /, '');
  if (validToken(token)) await database().collection<Session>('citizen_sessions').deleteOne({ _id: hash(token) });
  res.status(204).end();
}));
