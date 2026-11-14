import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import {
  bindProviderSecurityFlow,
  createProviderSecurityIntent,
  readProviderSecurityMethods,
} from '../provider-security-intents';
import { reauthenticateProviderWithGoogle } from '../provider-security-reauthentication';
import { prepareProviderSecurityMutation } from '../provider-security-finalizer';
import { providerTokenHash } from '../provider-security-context';

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
let duringVerification: (() => Promise<void>) | undefined;
const keyId = 'operation-bound-actual-google-key';
async function start(selected: 'current-store' | 'better-auth', unlink = false) {
  const subject = randomUUID();
  const owner = await environment.actor(selected, 'canonical-token', { provider: 'google', subject, password: false });
  const methods = await readProviderSecurityMethods(environment.database, environment.runtime, owner.actor);
  expect(methods.googleReauthenticationAvailable).toBe(true);
  const intent = await createProviderSecurityIntent(environment.database, environment.runtime, {
    actor: owner.actor,
    action: unlink ? 'unlink' : 'link',
    provider: unlink ? 'google' : 'apple',
    methodId: unlink ? methods.providers.find((method) => method.provider === 'google')!.methodId : null,
  });
  const nonce = randomBytes(32).toString('base64url');
  const flowHash = randomBytes(32).toString('hex');
  const bound = { actor: owner.actor, intentToken: intent.intentToken, browserIntentToken: intent.browserIntentToken };
  await bindProviderSecurityFlow(environment.database, environment.runtime, {
    ...bound,
    flowHash,
    nonceHash: providerTokenHash(nonce),
  });
  return { ...intent, ...owner, ...bound, nonce, flowHash, subject };
}
async function signed(subject: string, nonce: string, authenticatedAt?: number) {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: 'owned-google-client',
    sub: subject,
    nonce,
    auth_time: authenticatedAt ?? seconds - 60,
    iat: seconds,
    exp: seconds + 600,
  })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .sign(pair.privateKey);
}
function actualGoogleKeys() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const address = input instanceof Request ? input.url : String(input);
    if (address !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('Unexpected provider test URL');
    await duringVerification?.();
    return Response.json({ keys: [{ ...publicKey, kid: keyId, alg: 'RS256', use: 'sig' }] });
  });
}
async function intentState(token: string) {
  const [intent] = await environment.database
    .select()
    .from(authProviderSecurityIntents)
    .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(token)));
  return intent;
}
async function noProof(token: string) {
  expect(
    await environment.database
      .select()
      .from(authProviderReauthenticationReceipts)
      .where(eq(authProviderReauthenticationReceipts.intentHash, providerTokenHash(token))),
  ).toHaveLength(0);
}

describe('durable qualified Google authentication proof with actual provider signatures', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    pair = await generateKeyPair('RS256');
    publicKey = await exportJWK(pair.publicKey);
  });
  afterEach(() => {
    duringVerification = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: waits for an already-uncommitted provider owner update before writing any reauthentication receipt`, async () => {
      const command = await start(selected);
      const foreign = await environment.actor(selected, 'canonical-token');
      const before = await intentState(command.intentToken);
      const address = new URL(
        process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
      );
      address.pathname = `/${environment.client.options.database}`;
      const observer = postgres(address.toString(), { max: 2, onnotice: () => {} });
      let release = () => {};
      let ready = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let holding: Promise<unknown> | undefined;
      duringVerification = async () => {
        duringVerification = undefined;
        holding = observer.begin(async (transaction) => {
          if (selected === 'better-auth')
            await transaction`UPDATE auth_account SET user_id = ${foreign.userId}
            WHERE provider_id = 'google' AND account_id = ${command.subject}`;
          else
            await transaction`UPDATE accounts SET "userId" = ${foreign.userId}
            WHERE provider = 'google' AND "providerAccountId" = ${command.subject}`;
          ready();
          await released;
        });
        await started;
      };
      actualGoogleKeys();
      let completed = false;
      const pending = reauthenticateProviderWithGoogle(environment.database, environment.runtime, {
        ...command,
        idToken: await signed(command.subject, command.nonce),
      })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          completed = true;
        });
      try {
        await started;
        let observedWait = false;
        const until = Date.now() + 2000;
        while (!completed && !observedWait && Date.now() < until) {
          const [state] = await observer<{ waiting: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
              AND wait_event_type = 'Lock' AND query ILIKE '%for update%'
              AND (query ILIKE '%auth_account%' OR query ILIKE '%accounts%')
          ) AS waiting`;
          observedWait = state.waiting;
          if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observedWait).toBe(true);
        expect(completed).toBe(false);
        release();
        await holding;
        expect(await pending).toMatchObject({ error: { outcome: 'identity_changed', code: 'invalid_proof' } });
        await noProof(command.intentToken);
        expect(await intentState(command.intentToken)).toEqual(before);
      } finally {
        release();
        await holding;
        await pending;
        await observer.end({ timeout: 5 });
      }
    });
    it(`${selected}: recent signed Google event authorizes the Apple operation without changing original session age`, async () => {
      const command = await start(selected);
      actualGoogleKeys();
      const seconds = Math.floor(Date.now() / 1000);
      const before = await intentState(command.intentToken);
      const proof = await reauthenticateProviderWithGoogle(environment.database, environment.runtime, {
        ...command,
        idToken: await signed(command.subject, command.nonce, seconds - 60),
      });
      const [stored] = await environment.database
        .select()
        .from(authProviderReauthenticationReceipts)
        .where(eq(authProviderReauthenticationReceipts.receiptHash, providerTokenHash(proof.reauthenticationToken)));
      expect(stored).toMatchObject({
        method: 'google-auth-time',
        proofProviderSubject: command.subject,
        authenticatedAt: new Date((seconds - 60) * 1000),
        consumedAt: null,
      });
      expect(stored.expiresAt.getTime()).toBe((seconds + 240) * 1000);
      expect(await intentState(command.intentToken)).toEqual(before);
    });
    it(`${selected}: a fresh token for a foreign or unowned Google subject never becomes an owned reauthentication method`, async () => {
      const command = await start(selected);
      const foreignSubject = randomUUID();
      await environment.actor(selected, 'canonical-token', { provider: 'google', subject: foreignSubject });
      actualGoogleKeys();
      const before = await intentState(command.intentToken);
      for (const subject of [foreignSubject, randomUUID()])
        await expect(
          reauthenticateProviderWithGoogle(environment.database, environment.runtime, {
            ...command,
            idToken: await signed(subject, command.nonce),
          }),
        ).rejects.toMatchObject({ outcome: 'identity_changed' });
      await noProof(command.intentToken);
      expect(await intentState(command.intentToken)).toEqual(before);
    });
    it(`${selected}: new token issuance cannot renew an old Google authentication event`, async () => {
      const command = await start(selected);
      actualGoogleKeys();
      const before = await intentState(command.intentToken);
      await expect(
        reauthenticateProviderWithGoogle(environment.database, environment.runtime, {
          ...command,
          idToken: await signed(command.subject, command.nonce, Math.floor(Date.now() / 1000) - 301),
        }),
      ).rejects.toMatchObject({ outcome: 'reauthentication_required' });
      await noProof(command.intentToken);
      expect(await intentState(command.intentToken)).toEqual(before);
    });
    it(`${selected}: selected provider generation is re-read after external cryptographic verification`, async () => {
      const command = await start(selected);
      const before = await intentState(command.intentToken);
      duringVerification = async () => {
        duringVerification = undefined;
        if (selected === 'better-auth')
          await environment.database
            .update(authAccount)
            .set({ sourceGeneration: 1 })
            .where(and(eq(authAccount.providerId, 'google'), eq(authAccount.accountId, command.subject)));
        else {
          const { authSubjectCutoffs } = await import('@boardsesh/db/schema/auth');
          await environment.database.insert(authSubjectCutoffs).values({
            userId: command.userId,
            generation: 1,
            revokedThrough: new Date(),
            lastOperationId: randomUUID(),
          });
        }
      };
      actualGoogleKeys();
      await expect(
        reauthenticateProviderWithGoogle(environment.database, environment.runtime, {
          ...command,
          idToken: await signed(command.subject, command.nonce),
        }),
      ).rejects.toMatchObject({ outcome: selected === 'better-auth' ? 'identity_changed' : 'unauthenticated' });
      await noProof(command.intentToken);
      expect(await intentState(command.intentToken)).toEqual(before);
    });
    it(`${selected}: an authority switch during real provider verification refuses without consuming either flow`, async () => {
      const command = await start(selected);
      const before = await intentState(command.intentToken);
      duringVerification = async () => {
        duringVerification = undefined;
        await environment.selectAuthority(selected === 'current-store' ? 'better-auth' : 'current-store');
      };
      actualGoogleKeys();
      await expect(
        reauthenticateProviderWithGoogle(environment.database, environment.runtime, {
          ...command,
          idToken: await signed(command.subject, command.nonce),
        }),
      ).rejects.toThrow('STALE_AUTHORITY');
      await noProof(command.intentToken);
      expect(await intentState(command.intentToken)).toEqual(before);
    });
    it(`${selected}: unlink last usable method spends only the validated intent after actual Google reauthentication`, async () => {
      const command = await start(selected, true);
      actualGoogleKeys();
      const proof = await reauthenticateProviderWithGoogle(environment.database, environment.runtime, {
        ...command,
        idToken: await signed(command.subject, command.nonce),
      });
      expect(
        await prepareProviderSecurityMutation(environment.database, environment.runtime, {
          ...command,
          reauthenticationToken: proof.reauthenticationToken,
          flowHash: null,
          providerProof: null,
        }),
      ).toMatchObject({ outcome: 'denied', code: 'last_usable_method' });
      expect((await intentState(command.intentToken)).phase).toBe('terminal');
      const linked =
        selected === 'better-auth'
          ? await environment.database
              .select()
              .from(authAccount)
              .where(and(eq(authAccount.userId, command.userId), eq(authAccount.accountId, command.subject)))
          : await environment.database
              .select()
              .from(accounts)
              .where(and(eq(accounts.userId, command.userId), eq(accounts.providerAccountId, command.subject)));
      expect(linked).toHaveLength(1);
      const [receipt] = await environment.database
        .select()
        .from(authProviderReauthenticationReceipts)
        .where(eq(authProviderReauthenticationReceipts.receiptHash, providerTokenHash(proof.reauthenticationToken)));
      expect(receipt.consumedAt).toBeNull();
    });
  }
});
