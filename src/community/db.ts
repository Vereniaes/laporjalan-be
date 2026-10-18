/* Store community data separately from legacy samples.
Todo:
-> indexes, request limits and safe errors
*/
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export class InputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function database() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) throw new InputError(503, 'Penyimpanan laporan belum tersedia.');
  return mongoose.connection.db;
}
export const route = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void handler(req, res).catch(next); };
export function field(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new InputError(400, `${label} tidak valid.`);
  }
  return value.trim();
}
export const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export async function initCommunity() {
  const db = database();
  await Promise.all([
    db.collection('citizen_accounts').createIndex({ email: 1 }, { unique: true }),
    ...['citizen_links', 'citizen_sessions', 'citizen_limits'].map(name => db.collection(name).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })),
    db.collection('citizen_reports').createIndex({ createdAt: -1, _id: -1 }),
    db.collection('citizen_reports').createIndex({ ownerId: 1, createdAt: -1 }),
  ]);
}

// request limits (shared by all server instances) -------------------------------------------------------
// input param : scope, identity, count and window duration
// output : throw 429 when the fixed window is exhausted
export async function limit(scope: string, identity: string, maximum: number, ms: number) {
  const window = Math.floor(Date.now() / ms);
  const collection = database().collection<{ _id: string; count: number; expiresAt: Date }>('citizen_limits');
  const _id = hash(`${scope}:${identity}:${window}`);
  let row;
  try {
    row = await collection.findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * ms) } }, { upsert: true, returnDocument: 'after' });
  } catch (error: any) {
    if (error.code !== 11000) throw error;
    row = await collection.findOneAndUpdate({ _id }, { $inc: { count: 1 } }, { returnDocument: 'after' });
  }
  if (!row || row.count > maximum) throw new InputError(429, 'Terlalu banyak permintaan. Silakan coba beberapa saat lagi.');
}
// end of helper ---------------------------------------------------------------------------------------

export function communityError(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (typeof error === 'object' && error && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))) {
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ message: 'Isi permintaan tidak valid atau terlalu besar.' }); return;
  }
  const status = error instanceof InputError ? error.status : 503;
  if (!(error instanceof InputError)) console.error('[Community] Storage or service unavailable');
  res.status(status).json({ message: error instanceof InputError ? error.message : 'Layanan belum tersedia. Silakan coba lagi.' });
}
