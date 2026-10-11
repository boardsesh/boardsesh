import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  CONSENT_COOKIE_REGION_DEFAULT_PART,
  CONSENT_VERSION,
  isAnalyticsGranted,
  isCurrentConsentRecord,
  isRegionDefaultConsent,
  parseConsentCookieValue,
  serializeConsentCookieValue,
  type ConsentRecord,
} from '@boardsesh/consent';

let initialized = false;
let currentRecord: ConsentRecord | null = null;
let lastCookieValue: string | null = null;
let accountResolved = false;
/**
 * This page load's region lookup said no prompt is needed here (and the browser
 * sends no Global Privacy Control). A region-default cookie counts as "on" only
 * once it has, so it sends nothing before the lookup answers or when it fails.
 */
let regionConfirmed = false;
const listeners = new Set<() => void>();
function consentCookieValue(): string | null {
  if (typeof document === 'undefined') return null;
  const raw = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${CONSENT_COOKIE_NAME}=`));
  return raw?.slice(CONSENT_COOKIE_NAME.length + 1) ?? null;
}
export function readConsentCookie(): ConsentRecord | null {
  return parseConsentCookieValue(consentCookieValue());
}
export function getWebConsentRecord(): ConsentRecord | null {
  if (!initialized && typeof document !== 'undefined') {
    initialized = true;
    lastCookieValue = consentCookieValue();
    currentRecord = parseConsentCookieValue(lastCookieValue);
  }
  return currentRecord;
}
export function hasAnalyticsConsent(): boolean {
  // Cookies are shared across origins, unlike BroadcastChannel. A www/app withdrawal must
  // stop a background tab's next capture/request even before its next focus event.
  refreshWebConsent();
  return accountResolved && isConsentRecordAuthorized(getWebConsentRecord());
}
/**
 * An analytics "on" this page load may act on: an explicit Allow, or the region
 * default once this page load's region lookup confirmed it.
 */
export function isConsentRecordAuthorized(record: ConsentRecord | null): boolean {
  return isAnalyticsGranted(record) && (!isRegionDefaultConsent(record) || regionConfirmed);
}
export function isConsentRegionConfirmed(): boolean {
  return regionConfirmed;
}
export function setConsentRegionConfirmed(confirmed: boolean): void {
  if (regionConfirmed === confirmed) return;
  regionConfirmed = confirmed;
  listeners.forEach((listener) => listener());
}
/** Global Privacy Control as the page's script sees it (Firefox, Brave, DuckDuckGo, some extensions). */
export function isGlobalPrivacyControlEnabled(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl === true;
}
export function setConsentAccountResolved(resolved: boolean): void {
  if (accountResolved === resolved) return;
  accountResolved = resolved;
  listeners.forEach((listener) => listener());
}
export function subscribeWebConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(record: ConsentRecord | null, authorityChanged = false): void {
  initialized = true;
  if (JSON.stringify(currentRecord) === JSON.stringify(record) && !authorityChanged) return;
  currentRecord = record;
  if (typeof document !== 'undefined') {
    if (isCurrentConsentRecord(record)) document.documentElement.dataset.consent = record.analytics;
    else delete document.documentElement.dataset.consent;
  }
  listeners.forEach((listener) => listener());
}
export function refreshWebConsent(): void {
  const cookieValue = consentCookieValue();
  if (initialized && cookieValue === lastCookieValue) return;
  lastCookieValue = cookieValue;
  const record = parseConsentCookieValue(cookieValue);
  // Block before notifying the SDK, flags subscribers, or React. A grant written
  // on another origin might belong to another signed-in account.
  const authorityChanged = accountResolved && isAnalyticsGranted(record);
  if (isAnalyticsGranted(record)) accountResolved = false;
  publish(record, authorityChanged);
}
export function writeWebConsent(record: ConsentRecord | null): void {
  if (typeof document !== 'undefined') {
    const hostname = window.location.hostname;
    const sharedDomain =
      hostname === 'boardsesh.com' || hostname === 'www.boardsesh.com' || hostname === 'app.boardsesh.com';
    const suffix = `; Path=/; SameSite=Lax${sharedDomain ? '; Domain=.boardsesh.com' : ''}${window.location.protocol === 'https:' ? '; Secure' : ''}`;
    document.cookie = `${CONSENT_COOKIE_NAME}=${record ? serializeConsentCookieValue(record) : ''}; Max-Age=${record ? CONSENT_COOKIE_MAX_AGE_SECONDS : 0}${suffix}`;
  }
  lastCookieValue = record ? serializeConsentCookieValue(record) : null;
  publish(record);
}
// Same validation as the shared parser, emitted without request-cookie branching.
// A fifth `region` part (the region default, always a grant) hides the banner too.
export const CONSENT_PREPAINT_SCRIPT = `(function(){try{var c=document.cookie.split(';').map(function(s){return s.trim()}).find(function(s){return s.indexOf('${CONSENT_COOKIE_NAME}=')===0});if(!c)return;var p=c.slice(${CONSENT_COOKIE_NAME.length + 1}).split('.');if((p.length!==4&&!(p.length===5&&p[4]==='${CONSENT_COOKIE_REGION_DEFAULT_PART}'&&p[1]==='granted'))||!/^v[1-9][0-9]{0,5}$/.test(p[0])||Number(p[0].slice(1))<${CONSENT_VERSION}||! /^(granted|denied)$/.test(p[1])||! /^[0-9]{1,12}$/.test(p[2])||Number(p[2])>253402300799||! /^(web|ios|android)$/.test(p[3]))return;document.documentElement.dataset.consent=p[1]}catch(e){}})();`;
