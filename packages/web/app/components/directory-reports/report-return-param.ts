/**
 * The `?report=` parameter that carries a Report a problem tap across a social
 * sign-in. OAuth leaves the page, so the dialog the climber was opening has to
 * survive in the URL, the way `?claim=1` carries the claim (gym-claim-cta-logic.ts).
 *
 * The value names what was being reported: {@link GYM_REPORT_KEY} for the gym
 * itself, a board's uuid for a board. Anything else is ignored.
 */
export const REPORT_PARAM = 'report';

/** The `?report=` value for a report about the gym listing itself. */
export const GYM_REPORT_KEY = 'gym';

/** A uuid or `gym`. Bounded so a crafted URL cannot hand the page an arbitrary string. */
const REPORT_KEY_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Where sign-in sends the climber back: the page they were on, plus the report they were opening. */
export function buildReportReturnPath(pathname: string, search: string, key: string): string {
  const params = new URLSearchParams(search);
  params.set(REPORT_PARAM, key);
  return `${pathname}?${params.toString()}`;
}

/** The report a return from sign-in asks to reopen, or null. */
export function readReportReturnKey(search: string): string | null {
  const values = new URLSearchParams(search).getAll(REPORT_PARAM);
  // A repeated param is a crafted or double-appended URL; it opens nothing.
  if (values.length !== 1) return null;
  const [value] = values;
  return REPORT_KEY_PATTERN.test(value) ? value : null;
}

/** The same URL without `?report=`, path-relative, for `history.replaceState`. */
export function stripReportParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(REPORT_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
