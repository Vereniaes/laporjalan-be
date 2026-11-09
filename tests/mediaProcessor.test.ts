/* Verify real photo/video decoding without external delivery or application data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { processMedia } from '../src/community/mediaProcessor.js';
import { InputError } from '../src/community/db.js';

const execute = promisify(execFile);
const file = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype, size: buffer.length }) as Express.Multer.File;

test('media is decoded and re-encoded before publication', async t => {
  await t.test('JPEG orientation is applied and source EXIF/XMP metadata is removed', async () => {
    const original = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'red' } })
      .jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Artist: 'Private author' } } })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Private author"/></rdf:RDF></x:xmpmeta>').toBuffer();
    assert.ok((await sharp(original).metadata()).exif);
    assert.ok((await sharp(original).metadata()).xmp);
    const [output] = await processMedia([file(original, 'image/jpeg')]);
    const metadata = await sharp(output.buffer).metadata();
    assert.equal(metadata.width, 2); assert.equal(metadata.height, 4);
    for (const key of ['exif', 'xmp', 'iptc', 'orientation'] as const) assert.equal(metadata[key], undefined);
    assert.equal(output.mimetype, 'image/jpeg'); assert.equal(output.size, output.buffer.length);
    assert.equal(output.processedVersion, 1);
    assert.equal(output.buffer.includes(Buffer.from('Private author')), false);
  });
  await t.test('WebP is decoded to JPEG and corrupt images are rejected', async () => {
    const webp = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'blue' } }).webp().toBuffer();
    const [output] = await processMedia([file(webp, 'image/webp')]);
    assert.equal(output.mimetype, 'image/jpeg'); assert.equal((await sharp(output.buffer).metadata()).height, 3);
    await assert.rejects(processMedia([file(Buffer.from('ffd8ff000000000000000000', 'hex'), 'image/jpeg')]), (error: any) => error instanceof InputError && error.status === 400);
  });
  await t.test('oversized decoded images and concurrent processing are rejected without raw fallback', async () => {
    const enormous = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: 'white' } }).png().toBuffer();
    await assert.rejects(processMedia([file(enormous, 'image/png')]), (error: any) => error.status === 400);
    const small = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'green' } }).png().toBuffer();
    const pending = processMedia([file(small, 'image/png')]);
    await assert.rejects(processMedia([file(small, 'image/png')]), (error: any) => error.status === 429);
    await pending;
  });
  await t.test('video is re-encoded to MP4, preserving audio and rotation while removing source metadata', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'laporjalan-video-test-'));
    try {
      const initial = path.join(directory, 'initial.mp4'), input = path.join(directory, 'input.mp4'), output = path.join(directory, 'output.mp4');
      await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=blue:s=16x24:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-metadata', 'title=Private title', '-metadata', 'comment=Private comment',
        '-metadata', 'location=+40.0000+010.0000/', initial], { timeout: 10000 });
      await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', initial, '-c', 'copy', '-metadata:s:v:0', 'rotate=90', input], { timeout: 10000 });
      const [processed] = await processMedia([file(await readFile(input), 'video/mp4')]);
      assert.equal(processed.mimetype, 'video/mp4'); assert.equal(processed.processedVersion, 1);
      await writeFile(output, processed.buffer);
      const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { timeout: 10000 });
      const metadata = JSON.parse(stdout), video = metadata.streams.find((track: any) => track.codec_type === 'video');
      assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 24); assert.equal(video.height, 16);
      assert.ok(metadata.streams.some((track: any) => track.codec_type === 'audio' && track.codec_name === 'aac'));
      assert.ok(Number(metadata.format.duration) >= 0.9);
      assert.equal(stdout.includes('Private'), false); assert.equal(stdout.includes('40.0000'), false);
      for (const key of ['title', 'comment', 'location', 'location-eng']) assert.equal(metadata.format.tags?.[key], undefined);
      for (const track of metadata.streams) assert.equal(track.side_data_list?.some((entry: any) => entry.rotation && entry.rotation !== 0) ?? false, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await t.test('WebM video and larger phone frames are accepted with bounded output dimensions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'laporjalan-webm-test-'));
    try {
      const input = path.join(directory, 'input.webm'), output = path.join(directory, 'output.mp4');
      await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        'color=c=green:s=2000x1200:r=10:d=0.2', '-c:v', 'libvpx-vp9', '-threads', '1', input], { timeout: 10000 });
      const [processed] = await processMedia([file(await readFile(input), 'video/webm')]);
      await writeFile(output, processed.buffer);
      const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { timeout: 10000 });
      const track = JSON.parse(stdout).streams[0];
      assert.equal(processed.mimetype, 'video/mp4');
      assert.equal(track.width, 1800); assert.equal(track.height, 1080);
      assert.equal(track.codec_name, 'h264');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await t.test('missing processor fails closed and a failed batch releases capacity', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/laporjalan-test-no-executables';
    try {
      await assert.rejects(processMedia([file(Buffer.from('000000186674797069736f6d00000000', 'hex'), 'video/mp4')]), (error: any) => error.status === 503);
    } finally { process.env.PATH = originalPath; }
    assert.deepEqual(await processMedia([]), []);
  });
});

