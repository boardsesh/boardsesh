import { hash } from 'bcryptjs';
import { beforeAll, expect, it } from 'vite-plus/test';
import {
  requireProviderReauthenticationEvidence,
  verifyProviderPasswordReauthentication,
  type ProviderReauthenticationBinding,
  type ProviderReauthenticationEvidence,
} from '../provider-reauthentication-evidence';

const startedAt = new Date('2026-11-13T12:00:00Z');
const binding: ProviderReauthenticationBinding = {
  intentHash: '1'.repeat(64),
  actorCredentialHash: '2'.repeat(64),
  userId: 'requesting-climber',
  actorSessionId: 'original-session',
  actorGeneration: 8,
  operation: 'unlink',
  provider: 'apple',
  unlinkSubject: 'owned-apple-subject',
  authority: { projectionId: 'selected-projection', normalizerVersion: '1', authority: 'better-auth', epoch: 4 },
  expiresAt: new Date('2026-11-13T12:15:00Z'),
};
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hash(' exact password bytes ', 4);
});

async function actualPasswordProof() {
  const evidence = await verifyProviderPasswordReauthentication({
    binding,
    password: { userId: binding.userId, generation: binding.actorGeneration, passwordHash },
    submittedPassword: ' exact password bytes ',
    databaseStartedAt: startedAt,
  });
  expect(evidence).not.toBeNull();
  return evidence!;
}

it('requires actual bcrypt over the exact password bytes, independently of the requesting credential age', async () => {
  expect(
    await verifyProviderPasswordReauthentication({
      binding,
      password: { userId: binding.userId, generation: binding.actorGeneration, passwordHash },
      submittedPassword: 'exact password bytes',
      databaseStartedAt: startedAt,
    }),
  ).toBeNull();
  const evidence = await actualPasswordProof();
  const verified = requireProviderReauthenticationEvidence(evidence, binding, new Date(startedAt.getTime() + 1));
  expect(verified).toMatchObject({
    method: 'password',
    authenticatedAt: startedAt,
    expiresAt: new Date('2026-11-13T12:05:00Z'),
    password: { passwordHash, generation: 8, userId: binding.userId },
  });
  expect(JSON.stringify(evidence)).toBe('{}');
});

it('does not let serialization, object copying or a claimed recent time mint authentication evidence', async () => {
  const evidence = await actualPasswordProof();
  for (const forged of [{}, { ...evidence }, JSON.parse(JSON.stringify(evidence)) as unknown]) {
    expect(() =>
      requireProviderReauthenticationEvidence(forged as ProviderReauthenticationEvidence, binding, startedAt),
    ).toThrow('PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID');
  }
});

it.each([
  ['different intent', { intentHash: '3'.repeat(64) }],
  ['different exact source', { actorCredentialHash: '3'.repeat(64) }],
  ['different actor', { userId: 'another-climber' }],
  ['different session', { actorSessionId: 'another-session' }],
  ['later generation', { actorGeneration: 9 }],
  ['different operation', { operation: 'link' as const }],
  ['different provider', { provider: 'google' as const }],
  ['different provider subject', { unlinkSubject: 'another-apple-subject' }],
  ['later intent deadline', { expiresAt: new Date('2026-11-13T12:16:00Z') }],
  ['different selected authority', { authority: { ...binding.authority, authority: 'current-store' as const } }],
  ['later authority epoch', { authority: { ...binding.authority, epoch: 5 } }],
  ['different projection', { authority: { ...binding.authority, projectionId: 'other-projection' } }],
] as const)('refuses proof reuse for a %s', async (_label, changed) => {
  const evidence = await actualPasswordProof();
  expect(() => requireProviderReauthenticationEvidence(evidence, { ...binding, ...changed }, startedAt)).toThrow(
    'PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID',
  );
});

it('counts the five-minute password deadline from the database clock before bcrypt', async () => {
  const evidence = await actualPasswordProof();
  expect(() => requireProviderReauthenticationEvidence(evidence, binding, new Date('2026-11-13T12:05:00Z'))).toThrow(
    'PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID',
  );
  expect(() => requireProviderReauthenticationEvidence(evidence, binding, new Date('2026-11-13T11:59:59Z'))).toThrow(
    'PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID',
  );
});

it.each([
  ['invalid binding expiry', new Date(Number.NaN), startedAt],
  ['expired binding', new Date('2026-11-13T11:59:59Z'), startedAt],
  ['zero binding expiry', new Date(0), startedAt],
  ['invalid database clock', binding.expiresAt, new Date(Number.NaN)],
  ['zero database clock', binding.expiresAt, new Date(0)],
] as const)('does not mint evidence with %s', async (_label, expiresAt, databaseStartedAt) => {
  expect(
    await verifyProviderPasswordReauthentication({
      binding: { ...binding, expiresAt },
      password: { userId: binding.userId, generation: binding.actorGeneration, passwordHash },
      submittedPassword: ' exact password bytes ',
      databaseStartedAt,
    }),
  ).toBeNull();
});

it('refuses malformed verifier-use clocks and deadlines instead of accepting NaN comparisons', async () => {
  const evidence = await actualPasswordProof();
  expect(() => requireProviderReauthenticationEvidence(evidence, binding, new Date(Number.NaN))).toThrow(
    'PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID',
  );
  expect(() =>
    requireProviderReauthenticationEvidence(evidence, { ...binding, expiresAt: new Date(Number.NaN) }, startedAt),
  ).toThrow('PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID');
  expect(() => requireProviderReauthenticationEvidence(evidence, binding, new Date('2027-11-13T12:00:00Z'))).toThrow(
    'PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID',
  );
});

it('captures all actor, authority and password primitives before awaiting real bcrypt', async () => {
  const mutableBinding = { ...binding, authority: { ...binding.authority }, expiresAt: new Date(binding.expiresAt) };
  const mutablePassword = { userId: binding.userId, generation: binding.actorGeneration, passwordHash };
  const mutableStartedAt = new Date(startedAt);
  const pending = verifyProviderPasswordReauthentication({
    binding: mutableBinding,
    password: mutablePassword,
    databaseStartedAt: mutableStartedAt,
    submittedPassword: ' exact password bytes ',
  });
  mutableBinding.actorSessionId = 'forged-session';
  mutableBinding.authority.epoch = 99;
  mutableBinding.expiresAt.setUTCFullYear(2099);
  mutablePassword.passwordHash = 'unqualified';
  mutableStartedAt.setUTCFullYear(2099);
  const evidence = await pending;
  expect(evidence).not.toBeNull();
  expect(requireProviderReauthenticationEvidence(evidence!, binding, startedAt).authenticatedAt).toEqual(startedAt);
  expect(() => requireProviderReauthenticationEvidence(evidence!, mutableBinding, startedAt)).toThrow(
    'PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID',
  );
});
