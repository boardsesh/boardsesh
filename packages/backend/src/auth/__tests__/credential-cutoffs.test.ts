import { describe, expect, it } from 'vite-plus/test';
import {
  cutoffEnforcement,
  decideCredential,
  isCredentialAdmitted,
  parseCutoffEnforcement,
  type CredentialDecision,
  type PresentedCredential,
  type SubjectCutoffState,
} from '../credential-cutoffs';
import {
  assertCutoffEnforcementConfiguration,
  currentStoreAuthorityConfiguration,
  STAGED_WRITER_MODE_ENV,
} from '../current-store/authority-configuration';

const NOW_MS = Date.UTC(2026, 10, 11, 12);
const SIGNED_IN_AT = Math.floor(NOW_MS / 1000) - 3600;

function subject(generation: number, nativeGeneration = 0, deniedSessionKeys: string[] = []): SubjectCutoffState {
  return { generation, nativeGeneration, deniedSessionKeys: new Set(deniedSessionKeys) };
}
function web(generationClaim: unknown, sessionKeyClaim: unknown = 'login-1', authTimeClaim?: unknown) {
  return { kind: 'web-session', generationClaim, sessionKeyClaim, authTimeClaim } as const;
}
function nativeAccess(generationClaim: unknown, nativeGenerationClaim: unknown, authTimeClaim?: unknown) {
  return { kind: 'native-access', generationClaim, nativeGenerationClaim, authTimeClaim } as const;
}
function refreshRow(subjectGeneration: number | null, nativeGeneration: number | null, authenticatedAt: Date | null) {
  return { kind: 'native-refresh', subjectGeneration, nativeGeneration, authenticatedAt } as const;
}
const denialOf = (credential: PresentedCredential, state: SubjectCutoffState | undefined) =>
  decideCredential(credential, state, NOW_MS).denial;

describe('decideCredential: BA-04 section 4', () => {
  describe('old web JWE (no gen)', () => {
    it('is used while the generation is 0', () => {
      expect(denialOf(web(undefined), subject(0))).toBeNull();
    });
    it('dies once the generation moves', () => {
      expect(denialOf(web(undefined), subject(1))).toBe('generation');
    });
    it('dies when its login is denied', () => {
      expect(denialOf(web(undefined, 'login-1'), subject(0, 0, ['login-1']))).toBe('session-denied');
      expect(denialOf(web(undefined, 'login-2'), subject(0, 0, ['login-1']))).toBeNull();
    });
  });

  describe('new web JWE', () => {
    it('is used while gen equals the generation', () => {
      expect(denialOf(web(3), subject(3))).toBeNull();
    });
    it('dies at any other generation, lower or higher', () => {
      expect(denialOf(web(2), subject(3))).toBe('generation');
      expect(denialOf(web(4), subject(3))).toBe('generation');
    });
    it('is never ended by an app sign-out: the web has no native stamp', () => {
      expect(denialOf(web(3), subject(3, 7))).toBeNull();
    });
    it('dies when its login is denied', () => {
      expect(denialOf(web(3, 'login-1'), subject(3, 0, ['login-1']))).toBe('session-denied');
    });
  });

  describe('native JWT', () => {
    it('old (no gen, no ngen) is used while both generations are 0', () => {
      expect(denialOf(nativeAccess(undefined, undefined), subject(0, 0))).toBeNull();
      expect(denialOf(nativeAccess(undefined, undefined), subject(1, 0))).toBe('generation');
      expect(denialOf(nativeAccess(undefined, undefined), subject(0, 1))).toBe('native-generation');
    });
    it('new is used while gen and ngen both match', () => {
      expect(denialOf(nativeAccess(2, 5), subject(2, 5))).toBeNull();
      expect(denialOf(nativeAccess(2, 5), subject(3, 5))).toBe('generation');
      expect(denialOf(nativeAccess(2, 5), subject(2, 6))).toBe('native-generation');
      // Higher than the current native generation is refused too.
      expect(denialOf(nativeAccess(2, 6), subject(2, 5))).toBe('native-generation');
    });
  });

  describe('refresh row', () => {
    it('old (NULL stamps) is used while both generations are 0', () => {
      expect(denialOf(refreshRow(null, null, null), subject(0, 0))).toBeNull();
      expect(denialOf(refreshRow(null, null, null), subject(1, 0))).toBe('generation');
      expect(denialOf(refreshRow(null, null, null), subject(0, 1))).toBe('native-generation');
    });
    it('new is used while its stamps match', () => {
      expect(denialOf(refreshRow(4, 1, null), subject(4, 1))).toBeNull();
      expect(denialOf(refreshRow(4, 1, null), subject(5, 1))).toBe('generation');
      expect(denialOf(refreshRow(4, 1, null), subject(4, 2))).toBe('native-generation');
      expect(denialOf(refreshRow(4, 2, null), subject(4, 1))).toBe('native-generation');
    });
  });

  it('refuses every credential of a deleted or missing account', () => {
    for (const credential of [web(0), nativeAccess(0, 0), refreshRow(0, 0, null)]) {
      expect(denialOf(credential, undefined)).toBe('subject-inactive');
    }
  });

  it('refuses a present stamp that is not a whole number of at least 0', () => {
    for (const stamp of ['0', -1, 1.5, Number.NaN, true, {}]) {
      expect(denialOf(web(stamp), subject(0))).toBe('malformed-stamp');
      expect(denialOf(nativeAccess(stamp, 0), subject(0))).toBe('malformed-stamp');
      expect(denialOf(nativeAccess(0, stamp), subject(0))).toBe('malformed-stamp');
    }
  });

  describe('authentication age comes from auth_time or authenticated_at alone, never from gen', () => {
    it('is known when auth_time is present, with or without gen', () => {
      expect(decideCredential(web(undefined, 'login-1', SIGNED_IN_AT), subject(0), NOW_MS).authenticatedAt).toBe(
        SIGNED_IN_AT,
      );
      expect(decideCredential(nativeAccess(0, 0, SIGNED_IN_AT), subject(0), NOW_MS).authenticatedAt).toBe(SIGNED_IN_AT);
    });
    it('is unknown for a stamped credential without auth_time (transfer, watch, legacy child)', () => {
      expect(decideCredential(nativeAccess(0, 0), subject(0), NOW_MS).authenticatedAt).toBeNull();
      expect(decideCredential(web(0), subject(0), NOW_MS).authenticatedAt).toBeNull();
      expect(decideCredential(refreshRow(0, 0, null), subject(0), NOW_MS).authenticatedAt).toBeNull();
    });
    it('reads a refresh row from authenticated_at', () => {
      const signedIn = new Date(SIGNED_IN_AT * 1000);
      expect(decideCredential(refreshRow(0, 0, signedIn), subject(0), NOW_MS).authenticatedAt).toBe(SIGNED_IN_AT);
    });
    it('treats a malformed or future auth_time as unknown', () => {
      for (const claim of ['1700000000', 0, -5, 1.5, Math.floor(NOW_MS / 1000) + 3600]) {
        expect(decideCredential(nativeAccess(0, 0, claim), subject(0), NOW_MS).authenticatedAt).toBeNull();
      }
    });
  });
});

describe('AUTH_CUTOFF_ENFORCEMENT', () => {
  const decision = (denial: CredentialDecision['denial']): CredentialDecision => ({ denial, authenticatedAt: null });

  it('defaults to enforce and parses only enforce and observe', () => {
    expect(parseCutoffEnforcement(undefined)).toBe('enforce');
    expect(parseCutoffEnforcement('')).toBe('enforce');
    expect(parseCutoffEnforcement('enforce')).toBe('enforce');
    expect(parseCutoffEnforcement('observe')).toBe('observe');
    expect(() => parseCutoffEnforcement('Observe')).toThrow();
    expect(() => parseCutoffEnforcement('off')).toThrow();
  });

  it('per request, fails closed on anything but exactly observe', () => {
    expect(cutoffEnforcement({})).toBe('enforce');
    expect(cutoffEnforcement({ AUTH_CUTOFF_ENFORCEMENT: 'observe' })).toBe('observe');
    expect(cutoffEnforcement({ AUTH_CUTOFF_ENFORCEMENT: 'observe ' })).toBe('enforce');
    expect(cutoffEnforcement({ AUTH_CUTOFF_ENFORCEMENT: 'off' })).toBe('enforce');
  });

  it('enforce refuses every denial', () => {
    expect(isCredentialAdmitted(decision(null), 'enforce')).toBe(true);
    for (const denial of [
      'subject-inactive',
      'generation',
      'native-generation',
      'session-denied',
      'malformed-stamp',
    ] as const)
      expect(isCredentialAdmitted(decision(denial), 'enforce')).toBe(false);
  });

  it('observe admits a cutoff denial but never a deleted account', () => {
    for (const denial of ['generation', 'native-generation', 'session-denied', 'malformed-stamp'] as const)
      expect(isCredentialAdmitted(decision(denial), 'observe')).toBe(true);
    expect(isCredentialAdmitted(decision('subject-inactive'), 'observe')).toBe(false);
  });
});

describe('staged writers under observe', () => {
  const authority = {
    CURRENT_STORE_AUTH_PROJECTION_ID: 'projection-1',
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    // Every staged mode needs the deleted-address key (#7418), or configuration refuses first.
    CURRENT_STORE_DELETED_EMAIL_KEY: 'cutoff-test-deleted-email-key-0123456789abcdef',
  };

  it('the backend refuses to start with any staged writer mode on', () => {
    for (const modeName of STAGED_WRITER_MODE_ENV) {
      expect(() =>
        assertCutoffEnforcementConfiguration({ AUTH_CUTOFF_ENFORCEMENT: 'observe', [modeName]: 'reserved-staging' }),
      ).toThrow(modeName);
      expect(() =>
        assertCutoffEnforcementConfiguration({ AUTH_CUTOFF_ENFORCEMENT: 'enforce', [modeName]: 'reserved-staging' }),
      ).not.toThrow();
    }
  });

  it('the backend starts under observe while every staged writer is off', () => {
    expect(() => assertCutoffEnforcementConfiguration({ AUTH_CUTOFF_ENFORCEMENT: 'observe' })).not.toThrow();
    expect(() =>
      assertCutoffEnforcementConfiguration({
        AUTH_CUTOFF_ENFORCEMENT: 'observe',
        ...Object.fromEntries(STAGED_WRITER_MODE_ENV.map((modeName) => [modeName, 'legacy'])),
      }),
    ).not.toThrow();
  });

  it('the backend refuses to start with an unknown enforcement value', () => {
    expect(() => assertCutoffEnforcementConfiguration({ AUTH_CUTOFF_ENFORCEMENT: 'off' })).toThrow();
  });

  it('every staged command refuses its authority under observe', () => {
    expect(currentStoreAuthorityConfiguration(authority).expectedWriterEpoch).toBe(1);
    expect(() => currentStoreAuthorityConfiguration({ ...authority, AUTH_CUTOFF_ENFORCEMENT: 'observe' })).toThrow(
      'Staged auth writers need cutoff enforcement',
    );
    expect(() => currentStoreAuthorityConfiguration({ ...authority, AUTH_CUTOFF_ENFORCEMENT: 'bogus' })).toThrow();
  });
});
