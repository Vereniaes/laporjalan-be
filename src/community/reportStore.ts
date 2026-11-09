/* Share report storage and types between observations and private photo review.
Todo:
-> keep private receipts outside public history entries
*/
import { database } from './db.js';
import type { Condition } from './condition.js';
import type { Attachment } from './media.js';
import type { AnalysisReceipt } from './analysisContract.js';

export const categories = { road: 'Jalan', construction: 'Pembangunan', drain: 'Saluran', burning: 'Pembakaran' };
export const statuses = { reported: 'Dilaporkan', unchanged: 'Belum berubah', work_observed: 'Terlihat dikerjakan', resolved_observed: 'Terlihat selesai' };
export type Status = keyof typeof statuses;
type Entry = { id: string; note: string; status: Status; createdAt: string; media: Attachment[]; fingerprint: string; condition?: Condition | null };
type Visibility = 'public' | 'withdrawn' | 'hidden';
export type PublicationChange = { reporterName?: string; nameConsent?: boolean; visibility?: 'public' | 'withdrawn'; withdrawMediaIds?: string[] };
type PublicationAudit = { id: string; fingerprint: string; createdAt: string; change: PublicationChange };
export interface CitizenReport {
  _id: string; ownerId: string; category: keyof typeof categories; title: string; description: string;
  address: string; lat: number; lng: number; createdAt: string; updatedAt: string;
  status: Status; revision: number; updates: Entry[]; condition?: Condition | null;
  reporterName?: string; nameConsent?: boolean; visibility?: Visibility | null; withdrawnMediaIds?: string[];
  consentAudit?: { granted: boolean; createdAt: string }; publicationAudit?: PublicationAudit[]; analysisReceipts?: AnalysisReceipt[];
}
export const reports = () => database().collection<CitizenReport>('citizen_reports');
export const published = (row: CitizenReport) => !row.visibility || row.visibility === 'public';
export const visibleMedia = (row: CitizenReport, media: Attachment[]) => media.filter(file => !row.withdrawnMediaIds?.includes(file.id));
