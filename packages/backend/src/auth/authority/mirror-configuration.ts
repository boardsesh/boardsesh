type Environment = Readonly<Record<string, string | undefined>>;

export const IDENTITY_MIRROR_ENV = 'AUTH_IDENTITY_MIRROR';

/** Unset, empty or `off` is off; `on` is on; anything else refuses. Startup checks live in mirror-activation.ts. */
export function identityMirrorMode(environment: Environment = process.env): 'off' | 'on' {
  const mode = environment[IDENTITY_MIRROR_ENV];
  if (mode === undefined || mode === '' || mode === 'off') return 'off';
  if (mode === 'on') return 'on';
  throw new Error('Invalid AUTH_IDENTITY_MIRROR configuration');
}

/** A legacy native writer cannot participate in the authority gate/user-lock protocol. */
export function assertMirroredNativeWriterMode(mode: 'legacy' | 'reserved-staging', environment: Environment): void {
  if (identityMirrorMode(environment) === 'on' && mode !== 'reserved-staging') {
    throw new Error('AUTH_IDENTITY_MIRROR requires staged native identity writers');
  }
}
