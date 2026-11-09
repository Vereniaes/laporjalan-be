/* Todo:
-> /api/community/admin: the handling queue for every report in the database (warga + impor), admins only
    -> admin = an account with role 'admin' (set with scripts/make-admin.ts)
    -> actions append to the report's handling history; moderation of a warga report also sets its visibility
*/
import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { currentAccount } from './auth.js';
import { categories, reports, statuses } from './reportStore.js';
import { database, InputError, route, uuid } from './db.js';
import { ACTION_LABELS, HANDLING_STATUSES, handlings, type Handling, type HandlingAction, type HandlingStatus, type ReportKind } from './handling.js';
import { invalidateImported } from '../services/importedReports.js';

type Row = Record<string, any> & { _id: string };
const imported = () => database().collection<Row>('imported_reports');
const PAGE = 50;

async function requireAdmin(req: Request) {
  const account = await currentAccount(req);
  if ((account as Row).role !== 'admin') throw new InputError(403, 'Halaman ini khusus admin.');
  return account;
}
const kindOf = (value: unknown): ReportKind => { if (value !== 'warga' && value !== 'impor') throw new InputError(400, 'Sumber laporan tidak valid.'); return value; };
const note = (value: unknown) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new InputError(400, 'Catatan tidak valid.');
  const text = value.trim();
  if (text.length > 1000) throw new InputError(400, 'Catatan maksimum 1000 karakter.');
  return text;
};

// --- one queue over both sources ---
// output: rows with the source status, the handling state and the effective unit
async function queue() {
  const [warga, impor, handled] = await Promise.all([
    reports().find({}, { projection: { title: 1, category: 1, status: 1, createdAt: 1, visibility: 1, address: 1, description: 1 } }).toArray(),
    imported().find({}, { projection: { code: 1, category: 1, subcategory: 1, status: 1, unit: 1, createdAt: 1, address: 1, description: 1 } }).toArray(),
    handlings()!.find({}).toArray(),
  ]);
  const byId = new Map(handled.map(row => [row._id, row]));
  const shape = (kind: ReportKind, row: Row, code: string, title: string, sourceStatus: string, unit: string | null) => {
    const handling = byId.get(row._id);
    return { kind, id: row._id, code, title, category: row.category, categoryLabel: categories[row.category as keyof typeof categories] ?? row.category,
      sourceStatus, unit: handling?.unit ?? unit, createdAt: new Date(row.createdAt).toISOString(), excerpt: String(row.description ?? '').slice(0, 140),
      address: String(row.address ?? '').slice(0, 140), ownerWithdrawn: row.visibility === 'withdrawn',
      handling: handling ? { status: handling.status ?? null, hidden: Boolean(handling.hidden), duplicateOf: handling.duplicateOf ?? null, updatedAt: handling.updatedAt } : null };
  };
  return [
    ...warga.map(row => shape('warga', row as Row, 'LJ-' + row._id, row.title, statuses[row.status] ?? row.status, null)),
    ...impor.map(row => shape('impor', row, row.code, row.code, row.status, row.unit ?? null)),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
// --- end of queue ---

export const adminRoutes = Router();

adminRoutes.get('/summary', route(async (req, res) => {
  await requireAdmin(req);
  const rows = await queue();
  const count = (test: (row: typeof rows[number]) => boolean) => rows.filter(test).length;
  res.json({ total: rows.length, unhandled: count(row => !row.handling?.status), hidden: count(row => Boolean(row.handling?.hidden)),
    duplicates: count(row => Boolean(row.handling?.duplicateOf)),
    byStatus: Object.fromEntries(Object.keys(HANDLING_STATUSES).map(status => [status, count(row => row.handling?.status === status)])) });
}));

adminRoutes.get('/reports', route(async (req, res) => {
  await requireAdmin(req);
  const { kind, category, status, view, q } = req.query as Record<string, string | undefined>;
  const page = Math.max(0, Math.min(1000, Number(req.query.page) || 0));
  const term = (q ?? '').trim().toLocaleLowerCase('id').slice(0, 100);
  const rows = (await queue()).filter(row => (!kind || row.kind === kind) && (!category || row.category === category)
    && (!status || (status === 'baru' ? !row.handling?.status : row.handling?.status === status))
    && (!view || (view === 'hidden' ? row.handling?.hidden : view === 'duplicate' ? Boolean(row.handling?.duplicateOf) : true))
    && (!term || `${row.code} ${row.title} ${row.excerpt} ${row.address} ${row.unit ?? ''} ${row.sourceStatus}`.toLocaleLowerCase('id').includes(term)));
  res.json({ total: rows.length, page, pageSize: PAGE, reports: rows.slice(page * PAGE, page * PAGE + PAGE) });
}));

adminRoutes.get('/units', route(async (req, res) => {
  await requireAdmin(req);
  const units = new Set<string>([...await imported().distinct('unit'), ...await imported().distinct('history.unit'), ...await handlings()!.distinct('unit')]
    .filter((unit): unit is string => typeof unit === 'string' && unit.trim() !== ''));
  res.json({ units: [...units].sort((a, b) => a.localeCompare(b, 'id')) });
}));

adminRoutes.get('/reports/:kind/:id', route(async (req, res) => {
  await requireAdmin(req);
  const kind = kindOf(req.params.kind), id = String(req.params.id);
  const handling = await handlings()!.findOne({ _id: id });
  if (kind === 'impor') {
    const row = await imported().findOne({ _id: id });
    if (!row) throw new InputError(404, 'Laporan tidak ditemukan.');
    res.json({ kind, id, code: row.code, title: row.code, category: row.category, subcategory: row.subcategory, sourceStatus: row.status,
      unit: row.unit ?? null, area: row.area ?? null, description: row.description, address: [row.address, row.addressDetail].filter(Boolean).join(' · '),
      lat: row.lat, lng: row.lng, createdAt: new Date(row.createdAt).toISOString(),
      sourceHistory: (row.history ?? []).map((entry: Row) => ({ at: new Date(entry.at).toISOString(), status: entry.status, unit: entry.unit ?? null, note: entry.note ?? '' })),
      handling });
    return;
  }
  const row = await reports().findOne({ _id: id });
  if (!row) throw new InputError(404, 'Laporan tidak ditemukan.');
  res.json({ kind, id, code: 'LJ-' + row._id, title: row.title, category: row.category, subcategory: categories[row.category], sourceStatus: statuses[row.status],
    unit: null, area: null, description: row.description, address: row.address, lat: row.lat, lng: row.lng, createdAt: new Date(row.createdAt).toISOString(),
    visibility: row.visibility ?? 'public',
    sourceHistory: row.updates.map(entry => ({ at: new Date(entry.createdAt).toISOString(), status: statuses[entry.status], unit: null, note: entry.note })),
    handling });
}));

// --- actions ---
adminRoutes.post('/reports/:kind/:id/actions', route(async (req, res) => {
  const admin = await requireAdmin(req);
  const kind = kindOf(req.params.kind), id = String(req.params.id);
  const action = req.body.action as HandlingAction;
  if (!(action in ACTION_LABELS)) throw new InputError(400, 'Tindakan tidak dikenal.');
  const source = kind === 'impor' ? await imported().findOne({ _id: id }) : await reports().findOne({ _id: id });
  if (!source) throw new InputError(404, 'Laporan tidak ditemukan.');
  const current = await handlings()!.findOne({ _id: id });
  const entry: Handling['history'][number] = { id: randomUUID(), at: new Date(), adminId: admin._id, action, note: note(req.body.note) };
  const set: Partial<Handling> = {};
  if (action === 'status') {
    const status = req.body.status as HandlingStatus;
    if (!(status in HANDLING_STATUSES)) throw new InputError(400, 'Status penanganan tidak valid.');
    set.status = status; entry.status = status;
  } else if (action === 'assign') {
    const unit = typeof req.body.unit === 'string' ? req.body.unit.trim() : '';
    if (!unit || unit.length > 160 || /[\u0000-\u001F\u007F]/.test(unit)) throw new InputError(400, 'Unit tidak valid.');
    set.unit = unit; entry.unit = unit;
  } else if (action === 'hide' || action === 'show') {
    set.hidden = action === 'hide';
  } else if (action === 'duplicate') {
    const code = typeof req.body.duplicateOf === 'string' ? req.body.duplicateOf.trim() : '';
    const primary = uuid(code) ? (await imported().findOne({ _id: code }) ?? await reports().findOne({ _id: code }))
      : code.toUpperCase().startsWith('LJ-') ? (await imported().findOne({ code: code.toUpperCase() }) ?? (uuid(code.slice(3)) ? await reports().findOne({ _id: code.slice(3).toLowerCase() }) : null)) : null;
    if (!primary) throw new InputError(400, 'Laporan utama tidak ditemukan. Isi kode LJ- laporan utama.');
    if (primary._id === id) throw new InputError(400, 'Laporan tidak dapat menjadi duplikat dirinya sendiri.');
    set.duplicateOf = { id: primary._id, code: (primary as Row).code ?? 'LJ-' + primary._id }; entry.duplicateOf = set.duplicateOf.code;
  } else set.duplicateOf = null;
  const updated = await handlings()!.findOneAndUpdate({ _id: id }, { $set: { ...set, kind, updatedAt: entry.at }, $push: { history: entry } }, { upsert: true, returnDocument: 'after' });
  // a warga report hidden or merged leaves the map through its own visibility; its earlier state comes back when it returns
  if (kind === 'warga') {
    const suppressed = Boolean(updated!.hidden || updated!.duplicateOf), row = source as Row;
    if (suppressed && row.visibility !== 'hidden') {
      await reports().updateOne({ _id: id }, { $set: { visibility: 'hidden' } });
      await handlings()!.updateOne({ _id: id }, { $set: { previousVisibility: row.visibility ?? 'public' } });
    } else if (!suppressed && row.visibility === 'hidden') {
      await reports().updateOne({ _id: id }, { $set: { visibility: (current?.previousVisibility ?? 'public') as 'public' | 'withdrawn' } });
    }
  }
  invalidateImported();
  res.json({ handling: await handlings()!.findOne({ _id: id }) });
}));
// --- end of actions ---
