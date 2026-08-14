// NATIVE FORK — a constant module. Native never relaxes the auth gate.
//
// This file is what keeps the store fleet's behaviour identical across the OTA
// that ships the web relaxation. Every merge to `main` touching
// `packages/mobile/**` auto-publishes a production OTA, and a JS-only diff keeps
// the same `fingerprint` runtimeVersion, so it lands on every installed binary
// within hours. A `Platform.OS === 'web'` check inside the gate would put the
// web behaviour in the native bundle and leave one boolean between the fleet and
// an anonymous route tree. A separate fork cannot drift that way: on native
// there is nothing to drift.
//
// `anonymous-auth-gate.web.ts` is the fork Metro picks for the browser export.
// Both forks export the same four symbols; a parity test compares their export
// keys so a symbol added to one can never go missing from the other.

/** Native serves no route anonymously, so nothing here is ever relaxed. */
export const RELAXES_ANONYMOUS_ROUTES = false;

/** Constant `false`: the location is not consulted at all on native. */
export function isAnonymousReadOnlyLocation(): boolean {
  return false;
}

/** Constant: the bare login route the native gate has always redirected to. */
export function buildLoginHrefWithReturn(): string {
  return '/auth/login';
}

/** Constant `null`: native has no address bar, so there is no `?next=` to read. */
export function readPostLoginReturnHref(): string | null {
  return null;
}
