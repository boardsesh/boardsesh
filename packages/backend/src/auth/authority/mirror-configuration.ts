type Environment = Readonly<Record<string, string | undefined>>;

export const IDENTITY_MIRROR_ENV = 'AUTH_IDENTITY_MIRROR';

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

/**
 * Dark deployment only. PR9 must delegate web set-password with fresh-auth proof,
 * prove every staged writer mode, and verify the database writer fence before
 * this gate can be removed. Never disable the live web flow to claim coverage.
 */
export function assertIdentityMirrorActivationConfiguration(environment: Environment = process.env): void {
  if (identityMirrorMode(environment) === 'off') return;
  throw new Error(
    'AUTH_IDENTITY_MIRROR activation blocked: backend-owned fresh-auth set-password and complete writer/fence proof required',
  );
}
