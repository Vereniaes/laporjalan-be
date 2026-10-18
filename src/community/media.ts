/* Validate and stream public attachments from MongoDB GridFS.
Todo:
-> bound uploads and keep unreferenced files private
*/
import mongoose from 'mongoose';
import multer from 'multer';
import { once } from 'node:events';
import type { Request, Response } from 'express';
import { database, InputError } from './db.js';

export interface Attachment { id: string; mime: string; size: number }
const bucket = () => new mongoose.mongo.GridFSBucket(database(), { bucketName: 'citizen_media' });
const supported = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
export const upload = multer({ storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3, fields: 12, fieldSize: 6000, parts: 15 },
  fileFilter: (_req, file, done) => supported.includes(file.mimetype) ? done(null, true) : done(new InputError(400, 'Gunakan JPEG, PNG, WebP, MP4, atau WebM.')),
}).array('media', 3);

export function validateMedia(files: Express.Multer.File[]) {
  for (const file of files) {
    const b = file.buffer;
    const hex = b.subarray(0, 12).toString('hex');
    const matches = file.mimetype === 'image/jpeg' ? hex.startsWith('ffd8ff') :
      file.mimetype === 'image/png' ? hex.startsWith('89504e470d0a1a0a') :
      file.mimetype === 'image/webp' ? b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' :
      file.mimetype === 'video/mp4' ? b.subarray(4, 8).toString() === 'ftyp' :
      file.mimetype === 'video/webm' && hex.startsWith('1a45dfa3');
    if (!matches || b.length < 12 || b.length > 10 * 1024 * 1024) throw new InputError(400, 'Isi atau ukuran lampiran tidak valid.');
  }
}
export async function saveMedia(files: Express.Multer.File[]) {
  const saved: Attachment[] = [];
  try {
    for (const file of files) {
      const stream = bucket().openUploadStream('attachment', { metadata: { mime: file.mimetype } });
      saved.push({ id: stream.id.toHexString(), mime: file.mimetype, size: file.size });
      const finished = once(stream, 'finish');
      stream.end(file.buffer);
      await finished;
    }
    return saved;
  } catch (error) { await removeMedia(saved); throw error; }
}
export async function removeMedia(files: Attachment[]) {
  await Promise.allSettled(files.map(file => bucket().delete(new mongoose.mongo.ObjectId(file.id))));
}

// attachment response (single byte range supports video seeking) ---------------------------------------
// input param : a file already referenced by a public report
// output : media bytes; no filesystem paths or upstream redirects
export async function serveMedia(req: Request, res: Response, file: Attachment) {
  const id = new mongoose.mongo.ObjectId(file.id);
  const stored = await bucket().find({ _id: id }).next();
  if (!stored) throw new InputError(404, 'Lampiran tidak ditemukan.');
  let start = 0, end = stored.length - 1;
  const range = req.get('Range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${stored.length}`); res.status(416).end(); return; }
    if (!match[1]) start = Math.max(0, stored.length - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stored.length) {
      res.setHeader('Content-Range', `bytes */${stored.length}`); res.status(416).end(); return;
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${stored.length}`);
  }
  res.set({ 'Content-Type': file.mime, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'public, max-age=3600', 'Content-Disposition': 'inline; filename="attachment"' });
  const stream = bucket().openDownloadStream(id, { start, end: end + 1 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
// end of helper ---------------------------------------------------------------------------------------
