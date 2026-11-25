import { parseBrowserSessionMode } from '@boardsesh/auth-protocol/browser-session-mode';
import { setPasswordMode } from '@boardsesh/auth-protocol';
import { parseCutoffEnforcement } from '../credential-cutoffs';
import { passwordChangeEvidenceEnabled } from '../password-change-evidence';
import { currentStoreRpcSecret } from './authority-configuration';

type Environment = Readonly<Record<string, string | undefined>>;
const scopeKeys = [
  'AUTH_BROWSER_SESSION_MODE',
  'CURRENT_STORE_SET_PASSWORD_MODE',
  'AUTH_IDENTITY_MIRROR',
  'AUTH_CUTOFF_ENFORCEMENT',
  'DEBUG_SQL',
  'AUTH_PASSWORD_CHANGE_EVIDENCE_MODE',
  'NEXTAUTH_SECRET',
  'CURRENT_STORE_AUTH_RPC_SECRET',
  'AUTH_IDENTITY_DATABASE_URL',
  'AUTH_IDENTITY_DATABASE_CONTRACT',
  'DATABASE_URL',
] as const;
export class SetPasswordCompatibilityUnavailable extends Error {
  constructor() {
    super('Set-password compatibility unavailable');
    this.name = 'SetPasswordCompatibilityUnavailable';
  }
}
export type SetPasswordCompatibilityScope = Readonly<{
  environment: Readonly<Partial<Record<(typeof scopeKeys)[number], string>>>;
  secret: string;
  rpcSecret: string;
  evidenceEnabled: boolean;
}>;

/** Backend-owned scope; neither a legacy bearer nor caller metadata selects the writer. */
export function captureSetPasswordCompatibilityScope(
  environment: Environment = process.env,
): SetPasswordCompatibilityScope {
  try {
    if (
      parseBrowserSessionMode(environment.AUTH_BROWSER_SESSION_MODE) !== 'legacy' ||
      setPasswordMode(environment) !== 'legacy' ||
      ![undefined, '', 'off'].includes(environment.AUTH_IDENTITY_MIRROR) ||
      parseCutoffEnforcement(environment.AUTH_CUTOFF_ENFORCEMENT) !== 'enforce' ||
      ![undefined, '', 'false'].includes(environment.DEBUG_SQL) ||
      !environment.NEXTAUTH_SECRET
    )
      throw new SetPasswordCompatibilityUnavailable();
    const held: Partial<Record<(typeof scopeKeys)[number], string>> = {};
    for (const name of scopeKeys) if (environment[name] !== undefined) held[name] = environment[name];
    return Object.freeze({
      environment: Object.freeze(held),
      secret: environment.NEXTAUTH_SECRET,
      rpcSecret: currentStoreRpcSecret(environment),
      evidenceEnabled: passwordChangeEvidenceEnabled(environment),
    });
  } catch {
    throw new SetPasswordCompatibilityUnavailable();
  }
}
export function revalidateSetPasswordCompatibilityScope(
  scope: SetPasswordCompatibilityScope,
  environment: Environment = process.env,
): void {
  const current = captureSetPasswordCompatibilityScope(environment);
  if (scopeKeys.some((name) => current.environment[name] !== scope.environment[name]))
    throw new SetPasswordCompatibilityUnavailable();
}
