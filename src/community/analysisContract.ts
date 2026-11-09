/* Validate private photo suggestions and reporter decisions, without running a model.
Todo:
-> keep model text bounded and confirmations explicit
*/
import { InputError, uuid } from './db.js';

const kinds = ['pothole', 'crack', 'excavation', 'construction', 'possible_closure', 'no_visible_issue', 'other', 'unknown'] as const;
const flags = ['blurred', 'low_light', 'occluded', 'no_road'] as const;
export type AnalysisOutput = { kindSuggestion: typeof kinds[number]; visibleEvidence: string[];
  qualityFlags: typeof flags[number][]; captionSuggestion: string; needsHumanReview: true };
export type AnalysisReview = { analysisId: string; decision: 'accepted' | 'corrected'; acceptedFields: string[]; correctedFields: string[] };
export type AnalysisReceipt = { requestId: string; fingerprint: string; analysisId: string; decision: 'accepted' | 'corrected' | 'rejected';
  acceptedFields: string[]; correctedFields: string[]; suggestedKind: AnalysisOutput['kindSuggestion']; confirmedKind?: string;
  outputDigest: string; mediaId: string; sourceEntryId: string; storedMediaSha256: string; modelDigest: string;
  promptHash: string; schemaHash: string; preprocessingVersion: string; confirmedAt: string };

export function analysisError(status: number, code: string, message: string): never { throw new InputError(status, message, code); }
export function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    analysisError(400, 'invalid_input', 'Isian pemeriksaan tidak valid.');
  }
  return value as Record<string, unknown>;
}
export function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) analysisError(400, 'invalid_version', 'Versi tidak valid.');
  return value;
}
function outputText(value: unknown, maximum: number) {
  if (typeof value !== 'string' || [...value].length < 1 || [...value].length > maximum) {
    analysisError(400, 'invalid_output', 'Hasil pemeriksaan tidak valid.');
  }
  return value;
}

// model output (P5 schema, without permissive coercion) -------------------------------------------------
// input param : parsed untrusted model JSON
// output : bounded canonical suggestion or input error
export function analysisOutput(value: unknown): AnalysisOutput {
  const row = exactObject(value, ['kindSuggestion', 'visibleEvidence', 'qualityFlags', 'captionSuggestion', 'needsHumanReview']);
  if (!kinds.includes(row.kindSuggestion as any) || row.needsHumanReview !== true || !Array.isArray(row.visibleEvidence) ||
    row.visibleEvidence.length > 4 || !Array.isArray(row.qualityFlags) || row.qualityFlags.length > 4 ||
    row.qualityFlags.some(flag => !flags.includes(flag as any))) analysisError(400, 'invalid_output', 'Hasil pemeriksaan tidak valid.');
  const visibleEvidence = row.visibleEvidence.map(item => outputText(item, 160));
  const qualityFlags = row.qualityFlags as AnalysisOutput['qualityFlags'];
  if (new Set(visibleEvidence).size !== visibleEvidence.length || new Set(qualityFlags).size !== qualityFlags.length) {
    analysisError(400, 'invalid_output', 'Hasil pemeriksaan tidak valid.');
  }
  return { kindSuggestion: row.kindSuggestion as AnalysisOutput['kindSuggestion'], visibleEvidence,
    qualityFlags: [...qualityFlags], captionSuggestion: outputText(row.captionSuggestion, 240), needsHumanReview: true };
}
// end of helper ---------------------------------------------------------------------------------------

export function analysisReview(value: unknown): AnalysisReview | undefined {
  if (value === undefined) return;
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { analysisError(400, 'invalid_review', 'Tinjauan tidak valid.'); }
  const row = exactObject(parsed, ['analysisId', 'decision', 'acceptedFields', 'correctedFields']);
  if (!uuid(row.analysisId) || !['accepted', 'corrected'].includes(String(row.decision))) analysisError(400, 'invalid_review', 'Tinjauan tidak valid.');
  const accepted = row.decision === 'accepted';
  if (JSON.stringify(row.acceptedFields) !== JSON.stringify(accepted ? ['kind'] : []) ||
    JSON.stringify(row.correctedFields) !== JSON.stringify(accepted ? [] : ['kind'])) analysisError(400, 'invalid_review', 'Hanya jenis kondisi yang dapat ditinjau.');
  return { analysisId: row.analysisId as string, decision: accepted ? 'accepted' : 'corrected',
    acceptedFields: accepted ? ['kind'] : [], correctedFields: accepted ? [] : ['kind'] };
}

export const positiveSuggestion = (output: AnalysisOutput) => output.qualityFlags.length === 0 &&
  ['pothole', 'crack', 'excavation', 'construction', 'possible_closure'].includes(output.kindSuggestion);
