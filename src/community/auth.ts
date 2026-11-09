/* Email login and private sessions for report owners.
Todo:
-> consume links once and keep identity out of public reports
-> register and sign in with email + password (owner choice, 9 Nov: works without Resend)
    -> scrypt hash with a random salt; the same answer for unknown email and wrong password
*/
import { Router, type Request, type Response } from 'express';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ENV } from '../config/env.js';
import { database, displayName, field, hash, InputError, limit, route, uuid } from './db.js';

type Account = { _id: string; email: string; displayName?: string; passwordHash?: string; role?: 'admin' };
type LoginLink = { _id: string; email: string; expiresAt: Date; returnTo?: string };
type Session = { _id: string; accountId: string; expiresAt: Date };
const privateUser = (account: Account) => ({ id: account._id, email: account.email, ...(account.displayName ? { displayName: account.displayName } : {}), ...(account.role === 'admin' ? { role: 'admin' as const } : {}) });
const bearer = (req: Request) => /^Bearer ([\w-]{43})$/.exec(req.get('Authorization') ?? '')?.[1];
const secret = () => randomBytes(32).toString('base64url');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{43}$/.test(value);

export async function currentAccount(req: Request) {
  const token = bearer(req);
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

// --- passwords and sessions ---
const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
// stored as scrypt$salt$key (base64url); the salt is per account
async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await derive(password, salt, 64)).toString('base64url')}`;
}
// Why/Note: unknown accounts still run one scrypt so the answer time does not reveal registered emails
const DUMMY_HASH = `scrypt$${randomBytes(16).toString('base64url')}$${randomBytes(64).toString('base64url')}`;
async function passwordMatches(password: string, stored = DUMMY_HASH) {
  const [, salt, key] = stored.split('$');
  const expected = Buffer.from(key ?? '', 'base64url');
  const actual = await derive(password, Buffer.from(salt ?? '', 'base64url'), 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function emailField(value: unknown) {
  const email = field(value, 3, 254, 'Email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError(400, 'Email tidak valid.');
  return email;
}
function passwordField(value: unknown) {
  if (typeof value !== 'string' || value.length < 8) throw new InputError(400, 'Kata sandi minimal 8 karakter.');
  if (value.length > 128) throw new InputError(400, 'Kata sandi maksimum 128 karakter.');
  return value;
}
// one session for any way in (email link, register, password login): 7 days, only the hash is stored
async function startSession(res: Response, account: Account, extra: Record<string, unknown> = {}) {
  const token = secret();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  await database().collection<Session>('citizen_sessions').insertOne({ _id: hash(token), accountId: account._id, expiresAt });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token, expiresAt, user: privateUser(account), ...extra });
}
// --- end of passwords and sessions ---

export const authRoutes = Router();
authRoutes.post('/register', route(async (req, res) => {
  const email = emailField(req.body.email), password = passwordField(req.body.password);
  const name = displayName(req.body.displayName ?? '');
  await limit('register', email, 5, 60 * 60_000);
  await limit('register-total', 'all', 200, 60 * 60_000);
  const account: Account = { _id: randomUUID(), email, passwordHash: await hashPassword(password), ...(name ? { displayName: name } : {}) };
  try { await database().collection<Account>('citizen_accounts').insertOne(account); }
  catch (error: any) {
    // an existing email (with or without a password) is never taken over by a new registration
    if (error.code === 11000) throw new InputError(409, 'Email sudah terdaftar. Silakan masuk.');
    throw error;
  }
  res.status(201); await startSession(res, account);
}));
authRoutes.post('/login', route(async (req, res) => {
  const email = emailField(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 128) : '';
  await limit('login', email, 10, 15 * 60_000);
  const account = await database().collection<Account>('citizen_accounts').findOne({ email });
  if (!(await passwordMatches(password, account?.passwordHash)) || !account?.passwordHash) throw new InputError(401, 'Email atau kata sandi salah.');
  await startSession(res, account);
}));

authRoutes.post('/link', route(async (req, res) => {
  const email = emailField(req.body.email);
  const returnTo = req.body.returnTo ?? 'mine';
  if (!['new', 'mine'].includes(returnTo) && !uuid(returnTo)) throw new InputError(400, 'Tujuan masuk tidak valid.');
  const origin = appOrigin();
  if (!ENV.RESEND_API_KEY || !ENV.EMAIL_FROM) throw new InputError(503, 'Layanan email belum dikonfigurasi.');
  await limit('email', email, 3, 15 * 60_000);
  await limit('email-total', 'all', 100, 60 * 60_000);
  const token = secret();
  const links = database().collection<LoginLink>('citizen_links');
  const _id = hash(token);
  await links.insertOne({ _id, email, returnTo, expiresAt: new Date(Date.now() + 15 * 60_000) });
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
  await startSession(res, account, { returnTo: link.returnTo ?? 'mine' });
}));
authRoutes.get('/session', route(async (req, res) => {
  const account = await currentAccount(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: privateUser(account) });
}));
authRoutes.patch('/profile', route(async (req, res) => {
  const account = await currentAccount(req);
  const name = displayName(req.body.displayName);
  await database().collection<Account>('citizen_accounts').updateOne({ _id: account._id },
    name ? { $set: { displayName: name } } : { $unset: { displayName: '' } });
  res.json({ user: privateUser({ ...account, displayName: name }) });
}));
authRoutes.post('/logout', route(async (req, res) => {
  const token = bearer(req);
  if (validToken(token)) await database().collection<Session>('citizen_sessions').deleteOne({ _id: hash(token) });
  res.status(204).end();
}));
