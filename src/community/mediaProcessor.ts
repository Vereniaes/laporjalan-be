/* Decode photos and videos before publication, with bounded work and no raw fallback.
Todo:
-> remove embedded metadata and keep processing local
*/
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InputError } from './db.js';

const execute = promisify(execFile);
const maximumBytes = 10 * 1024 * 1024;
const maximumPixels = 24_000_000;
const version = 1;
let active = false;
let deadline = 0;
sharp.concurrency(1);
sharp.cache(false);

function remaining() {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new InputError(422, 'Pemrosesan lampiran melewati batas waktu.');
  return ms;
}
async function command(binary: string, args: string[], timeout: number, outputPath?: string) {
  let oversized = false;
  const execution = execute(binary, args, { timeout: Math.min(timeout, remaining()), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true });
  const monitor = outputPath ? setInterval(() => {
    void stat(outputPath).then(file => {
      if (file.size > maximumBytes) { oversized = true; execution.child.kill('SIGKILL'); }
    }).catch(() => {});
  }, 100) : undefined;
  try { return await execution; }
  catch (error: any) {
    if (oversized) throw new InputError(413, 'Hasil pemrosesan lampiran melebihi 10 MB.');
    if (error.code === 'ENOENT') throw new InputError(503, 'Pemrosesan lampiran belum tersedia.');
    if (error.killed) throw new InputError(422, 'Pemrosesan lampiran melewati batas waktu.');
    throw new InputError(400, 'Lampiran tidak dapat diproses.');
  } finally { if (monitor) clearInterval(monitor); }
}
async function photo(file: Express.Multer.File) {
  try {
    const image = sharp(file.buffer, { limitInputPixels: maximumPixels, failOn: 'warning', animated: false }).timeout({ seconds: Math.max(1, Math.min(20, Math.floor(remaining() / 1000))) });
    const metadata = await image.metadata();
    const formats: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
    const expected = formats[file.mimetype];
    if (metadata.format !== expected || (metadata.pages ?? 1) > 1) throw new InputError(400, 'Format foto tidak didukung.');
    const rotated = image.autoOrient();
    const png = file.mimetype === 'image/png';
    return { buffer: await (png ? rotated.png() : rotated.jpeg({ quality: 90 })).toBuffer(), mimetype: png ? 'image/png' : 'image/jpeg' };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, 'Foto tidak dapat dibaca atau melewati batas 24 juta piksel.');
  }
}
async function video(file: Express.Multer.File) {
  const directory = await mkdtemp(path.join(tmpdir(), 'laporjalan-media-'));
  try {
    const input = path.join(directory, 'input'), output = path.join(directory, 'output.mp4');
    await writeFile(input, file.buffer, { mode: 0o600 });
    const probe = await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'mov,matroska,webm', '-show_streams', '-show_format', '-of', 'json', input], 10_000);
    const metadata = JSON.parse(probe.stdout);
    const track = metadata.streams?.find((stream: any) => stream.codec_type === 'video');
    const duration = Number(metadata.format?.duration);
    if (!track || !Number.isInteger(track.width) || !Number.isInteger(track.height) || track.width < 1 || track.height < 1 ||
      track.width > 3840 || track.height > 3840 || track.width * track.height > 3840 * 2160 ||
      !Number.isFinite(duration) || duration <= 0 || duration > 120) {
      throw new InputError(400, 'Video maksimum 4K dan 120 detik.');
    }
    await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864',
      '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-threads', '2', '-i', input,
      '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1',
      '-map_chapters', '-1', '-sn', '-dn', '-filter_threads', '1', '-vf',
      'scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264',
      '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-b:a', '128k',
      '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', output], 60_000, output);
    const outputSize = (await stat(output)).size;
    if (outputSize > maximumBytes) throw new InputError(413, 'Hasil pemrosesan lampiran melebihi 10 MB.');
    return { buffer: await readFile(output), mimetype: 'video/mp4' };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, 'Video tidak dapat diproses.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// One batch prevents parallel decoders from exhausting the API instance.
// input param : validated original upload buffers
// output : re-encoded bytes and authoritative processing version
export async function processMedia(files: Express.Multer.File[]) {
  if (!files.length) return [];
  if (active) throw new InputError(429, 'Pemrosesan lampiran sedang penuh. Silakan coba kembali.');
  active = true;
  deadline = Date.now() + 90_000;
  try {
    const result = [];
    for (const file of files) {
      const processed = await (file.mimetype.startsWith('image/') ? photo(file) : video(file));
      if (!processed.buffer.length || processed.buffer.length > maximumBytes) throw new InputError(413, 'Hasil pemrosesan lampiran melebihi 10 MB.');
      result.push({ ...processed, size: processed.buffer.length, processedVersion: version });
    }
    return result;
  } finally { active = false; }
}
// end of helper ---------------------------------------------------------------------------------------

