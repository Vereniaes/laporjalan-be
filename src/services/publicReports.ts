/* Read public road reports from CRM, tanpa menyimpan identitas.
Todo:
-> validate public metadata and limit upstream requests
*/

const SOURCE_URL = 'https://crm.jakarta.go.id/peta/';
const ENDPOINT = 'https://crm.jakarta.go.id/api/public/dashboard/distribution-map';
const ROAD_CATEGORY = '6330b1db-fba5-4fde-9dbf-8458ac58a9c5';
const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_MS = 5 * 60_000;

export interface PublicReport {
  id: string;
  code: string;
  lat: number;
  lng: number;
  category: 'road';
  sourceCategory: 'Jalan';
  createdAt: string;
  sourceStatus: string | null;
}

export interface PublicReportsSnapshot {
  reports: PublicReport[];
  source: { name: string; url: string; retrievedAt: string; dateStart: string; dateEnd: string };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const shortText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export function sourceDates(now: number) {
  const jakartaDate = (time: number) => new Date(time + 7 * 60 * 60_000).toISOString().slice(0, 10);
  return { dateStart: jakartaDate(now - 24 * 60 * 60_000), dateEnd: jakartaDate(now) };
}

// data handling (keep only safe, public road metadata) --------------------------------------------------
// input param : upstream JSON
// output : validated reports, without free text or personal fields
export function normalizePublicReports(payload: unknown): PublicReport[] {
  if (!Array.isArray(payload) || payload.length > 20_000) throw new Error('Invalid source response');
  const seen = new Set<string>();
  const reports: PublicReport[] = [];
  for (const value of payload) {
    const row = record(value);
    const category = record(row.complaintCategory);
    if (row.isPrivacy !== false || category.id !== ROAD_CATEGORY || category.name !== 'Jalan') continue;
    if (!shortText(row.id, 100) || !shortText(row.code, 80) || seen.has(row.id)) continue;
    if (typeof row.lng !== 'number' || typeof row.lat !== 'number' ||
      !Number.isFinite(row.lng) || !Number.isFinite(row.lat) ||
      Math.abs(row.lng) > 180 || Math.abs(row.lat) > 85.051129) continue;
    if (!shortText(row.createdAt, 40) || !Number.isFinite(Date.parse(row.createdAt))) continue;
    const status = record(row.tstatus).name;
    reports.push({ id: row.id, code: row.code, lat: row.lat, lng: row.lng, category: 'road',
      sourceCategory: 'Jalan', createdAt: new Date(row.createdAt).toISOString(),
      sourceStatus: shortText(status, 100) ? status : null });
    seen.add(row.id);
  }
  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
// end of helper ---------------------------------------------------------------------------------------

async function readLimitedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json') ||
    Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) {
    throw new Error('Source unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error('Source response too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// source reader (one request for concurrent callers, fixed origin and short cache) ----------------------
// input param : fetch and clock; injectable for isolated tests
// output : current snapshot or explicit failure; never sample reports
export function createPublicReportsReader(fetcher: typeof fetch = fetch, clock = Date.now) {
  let cache: PublicReportsSnapshot | undefined;
  let expiresAt = 0;
  let retryAt = 0;
  let pending: Promise<PublicReportsSnapshot> | undefined;
  return async (): Promise<PublicReportsSnapshot> => {
    const now = clock();
    const dates = sourceDates(now);
    if (cache && now < expiresAt && cache.source.dateEnd === dates.dateEnd) return cache;
    if (pending) return pending;
    if (now < retryAt) throw new Error('Source unavailable');
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({ ...dates, isPrivacy: '0' }).toString();
        const response = await fetcher(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        const reports = normalizePublicReports(await readLimitedJson(response));
        cache = { reports, source: { name: 'CRM Jakarta · JAKI', url: SOURCE_URL,
          ...dates, retrievedAt: new Date(clock()).toISOString() } };
        expiresAt = clock() + CACHE_MS;
        return cache;
      } catch {
        retryAt = clock() + 30_000;
        throw new Error('Source unavailable');
      } finally {
        clearTimeout(timeout);
        pending = undefined;
      }
    })();
    return pending;
  };
}
// end of helper ---------------------------------------------------------------------------------------
