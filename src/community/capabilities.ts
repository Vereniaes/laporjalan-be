/* Explain community readiness without publishing configuration values.
Todo:
-> separate reading, writing and email readiness
*/
import { ENV } from '../config/env.js';
import { appOrigin, originAllowed } from './auth.js';
import { database } from './db.js';
import { analysisCapability, disabledAnalysis, type AnalysisPolicy } from './analyses.js';

// login = register/sign in with a password (needs storage + origin); emailLink = the optional email link (needs Resend)
function reportCapabilities(origin?: string) {
  if (!ENV.COMMUNITY_REPORTS_ENABLED) return { reports: false, write: false, login: false, emailLink: false, reason: 'disabled' as const };
  try { database(); }
  catch { return { reports: false, write: false, login: false, emailLink: false, reason: 'storage_unavailable' as const }; }
  try { appOrigin(); }
  catch { return { reports: true, write: false, login: false, emailLink: false, reason: 'origin_unconfigured' as const }; }
  // a page on an address the server does not accept could read, but every write would be refused: say so up front
  if (origin && !originAllowed(origin)) return { reports: true, write: false, login: false, emailLink: false, reason: 'origin_not_allowed' as const };
  return { reports: true, write: true, login: true, emailLink: Boolean(ENV.RESEND_API_KEY && ENV.EMAIL_FROM), reason: null };
}
export function communityCapabilities(policy: AnalysisPolicy = disabledAnalysis, origin?: string) {
  const capability = reportCapabilities(origin);
  return { ...capability, analysis: analysisCapability(capability.write ? policy : disabledAnalysis) };
}
