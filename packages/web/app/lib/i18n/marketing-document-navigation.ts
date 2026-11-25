import { detectLocale } from './detect-locale';
import { isAppGuidePath } from './published-locales';
import { getSessionInboundCampaign } from '../inbound-campaign';

function usesMarketingDocument(path: string): boolean {
  const pathname = new URL(path, 'https://www.boardsesh.com').pathname;
  const { strippedPath } = detectLocale(pathname);
  return strippedPath === '/' || isAppGuidePath(strippedPath);
}

/** Layout providers belong to one document and cannot change during a soft navigation. */
export function needsMarketingDocumentNavigation(sourcePath: string, destinationPath: string): boolean {
  return usesMarketingDocument(sourcePath) !== usesMarketingDocument(destinationPath);
}

/** Carry bounded campaign labels across an intentional document swap without storing ad IDs. */
export function withMarketingNavigationCampaign(destination: URL): URL {
  const target = new URL(destination);
  const campaign = getSessionInboundCampaign();
  for (const [name, label] of Object.entries(campaign ?? {})) {
    if (name.startsWith('utm_') && !target.searchParams.has(name)) target.searchParams.set(name, label);
  }
  return target;
}

export function navigateAcrossMarketingDocument(destination: string, replace = false, sourcePath?: string): boolean {
  if (typeof window === 'undefined') return false;
  const target = new URL(destination, window.location.href);
  if (
    target.origin !== window.location.origin ||
    !needsMarketingDocumentNavigation(sourcePath ?? window.location.pathname, target.pathname)
  ) {
    return false;
  }
  const attributedTarget = withMarketingNavigationCampaign(target);
  if (replace) window.location.replace(attributedTarget);
  else window.location.assign(attributedTarget);
  return true;
}
