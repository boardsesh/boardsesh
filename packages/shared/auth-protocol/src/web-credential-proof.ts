import { z } from 'zod';

/** Negotiated extension: old request/reply shapes remain byte-compatible when off. */
export const WEB_CREDENTIAL_PROOF_VERSION = 1;
export const WEB_CREDENTIAL_PROOF_ENV = 'CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE';
export function webCredentialProofMode(
  environment: Readonly<Record<string, string | undefined>> = {},
): 'off' | 'compatible' | 'required' {
  const mode = environment[WEB_CREDENTIAL_PROOF_ENV];
  if (mode === undefined || mode === '' || mode === 'off') return 'off';
  if (mode === 'required' || mode === 'compatible') return mode;
  throw new Error('Invalid web credential proof mode');
}

export const webCredentialProofSchema = z
  .object({
    version: z.literal(WEB_CREDENTIAL_PROOF_VERSION),
    userId: z.string().min(1).max(1024),
    authSessionId: z.string().min(1).max(1024),
    generation: z.number().int().nonnegative().max(2_147_483_647),
    authenticatedAt: z.iso.datetime().nullable(),
    linkGuarded: z.boolean(),
    /** The source login had no stable identifier before renewal assigned one. */
    requiresAccountCutoff: z.literal(true).optional(),
  })
  .strict();
export type WebCredentialProof = z.infer<typeof webCredentialProofSchema>;

export const SET_PASSWORD_MODE_ENV = 'CURRENT_STORE_SET_PASSWORD_MODE';
export function setPasswordMode(
  environment: Readonly<Record<string, string | undefined>> = {},
): 'legacy' | 'backend-staging' {
  const mode = environment[SET_PASSWORD_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'legacy') {
    if (environment.AUTH_IDENTITY_MIRROR === 'on') throw new Error('Mirroring requires delegated set-password');
    return 'legacy';
  }
  if (mode !== 'backend-staging' || webCredentialProofMode(environment) !== 'required')
    throw new Error('Invalid staged set-password configuration');
  return mode;
}

export const WEB_SIGNOUT_MODE_ENV = 'CURRENT_STORE_WEB_SIGNOUT_MODE';
/** A session denial writer is independent of bridge/cohort rollback. */
export function webSignOutMode(
  environment: Readonly<Record<string, string | undefined>> = {},
): 'legacy' | 'backend-staging' {
  const mode = environment[WEB_SIGNOUT_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode === 'backend-staging') return mode;
  throw new Error('Invalid web sign-out mode');
}

export function requiresWebSignOutForwarding(environment: Readonly<Record<string, string | undefined>> = {}): boolean {
  const staged = webSignOutMode(environment) === 'backend-staging';
  if (!staged && environment.AUTH_LEGACY_BRIDGE_MODE === 'on')
    throw new Error('The legacy bridge requires the web SID denial writer');
  return staged;
}
