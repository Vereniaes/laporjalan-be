/* Todo:
-> admin handling of any report (owner choice, 10 Nov): status + note, moderation, assigned unit, duplicate
    -> kept in its own collection, keyed by report id, so a rerun of the importer never overwrites it
    -> the public sees the handling status, unit and notes as "Pengelola LaporJalan"; never which admin
*/
import mongoose from 'mongoose';

export const HANDLING_STATUSES = { diterima: 'Diterima', diproses: 'Diproses', selesai: 'Selesai', ditolak: 'Ditolak' } as const;
export type HandlingStatus = keyof typeof HANDLING_STATUSES;
export type ReportKind = 'warga' | 'impor';
export type HandlingAction = 'status' | 'assign' | 'hide' | 'show' | 'duplicate' | 'unduplicate';
export const ACTION_LABELS: Record<HandlingAction, string> = { status: 'Status penanganan', assign: 'Ditugaskan', hide: 'Disembunyikan', show: 'Ditampilkan kembali', duplicate: 'Ditandai duplikat', unduplicate: 'Bukan duplikat' };
export interface HandlingEntry { id: string; at: Date; adminId: string; action: HandlingAction; status?: HandlingStatus; unit?: string; duplicateOf?: string; note: string }
export interface Handling {
  _id: string; kind: ReportKind; status?: HandlingStatus; unit?: string; hidden?: boolean;
  duplicateOf?: { id: string; code: string } | null; previousVisibility?: string | null; history: HandlingEntry[]; updatedAt: Date;
}

const db = () => mongoose.connection.readyState === 1 ? mongoose.connection.db ?? null : null;
export const handlings = () => db()?.collection<Handling>('report_handling') ?? null;

// reports that must not appear in public: hidden by an admin or marked as a duplicate
export async function suppressedIds(kind: ReportKind) {
  const collection = handlings();
  if (!collection) return new Set<string>();
  const rows = await collection.find({ kind, $or: [{ hidden: true }, { duplicateOf: { $ne: null, $exists: true } }] }, { projection: { _id: 1 } }).toArray();
  return new Set(rows.map(row => row._id));
}

// what the public card shows; null when nothing has been handled yet
export function publicHandling(row: Handling | null) {
  if (!row || row.hidden || row.duplicateOf) return null;
  const history = row.history.filter(entry => entry.action === 'status' || entry.action === 'assign')
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map(entry => ({ at: new Date(entry.at).toISOString(), action: ACTION_LABELS[entry.action], status: entry.status ? HANDLING_STATUSES[entry.status] : null, unit: entry.unit ?? null, note: entry.note }));
  if (!row.status && !row.unit && !history.length) return null;
  return { status: row.status ? HANDLING_STATUSES[row.status] : null, unit: row.unit ?? null, updatedAt: new Date(row.updatedAt).toISOString(), history };
}
export async function handlingFor(id: string) {
  return (await handlings()?.findOne({ _id: id })) ?? null;
}
