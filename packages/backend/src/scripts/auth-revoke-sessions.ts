import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { authEmailProjection, authSubjectCutoffs, users } from '@boardsesh/db/schema/auth';
import { operatorClient, operatorConnectionOptions, parseOperatorArguments } from './auth-fence/operator';
import { digestKey, keyedDigest, privateText } from './auth-identities/private-state';
import { revokeAdministrativeCredentials } from '../auth/authority/admin-revocation';
import { assertNativeGenerationRevocationActivation } from '../auth/authority/native-revocation-configuration';

/** Explicit operator connection only. Outputs contain counts and keyed digests. */
export async function runRevokeSessions(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const options = parseOperatorArguments(arguments_, ['plan', 'apply'], ['--subject-file', '--key-file']);
  const subjectFile = options.options.get('--subject-file');
  const keyFile = options.options.get('--key-file');
  if (!subjectFile || !keyFile) throw new Error('PRIVATE_SUBJECT_AND_KEY_REQUIRED');
  const userId = privateText(subjectFile).trim();
  if (!userId || userId.length > 256 || /\s/.test(userId)) throw new Error('INVALID_SUBJECT_FILE');
  const key = digestKey(keyFile);
  const connection = operatorConnectionOptions(environment, options.confirmHost, options.command === 'apply');
  const client = operatorClient(environment, options.confirmHost, options.command === 'apply');
  const database = drizzle(client, { schema });
  try {
    const [manifest] = await database.select().from(authEmailProjection).where(eq(authEmailProjection.isCurrent, true));
    const [subject] = await database.select({ id: users.id }).from(users).where(eq(users.id, userId));
    const [cutoff] = await database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId));
    if (!manifest || manifest.phase !== 'enforced' || !subject || cutoff?.deletedAt)
      throw new Error('ACTIVE_SUBJECT_AND_AUTHORITY_REQUIRED');
    const generation = cutoff?.generation ?? 0;
    const planDigest = keyedDigest(key, [
      'admin-revoke-v1',
      connection.host.toLowerCase(),
      connection.port,
      connection.database,
      userId,
      generation,
      manifest.projectionId,
      manifest.writerEpoch,
    ]);
    if (options.command === 'plan') return { status: 'planned', subjects: 1, planDigest };
    if (options.planSha256 !== planDigest) throw new Error('PLAN_DIGEST_MISMATCH');
    assertNativeGenerationRevocationActivation();
    await revokeAdministrativeCredentials(
      database,
      {
        expectedProjectionId: manifest.projectionId,
        expectedNormalizerVersion: manifest.normalizerVersion,
        expectedWriterEpoch: manifest.writerEpoch,
      },
      userId,
      generation,
    );
    return { status: 'revoked', subjects: 1, planDigest };
  } finally {
    await client.end({ timeout: 5 });
  }
}
async function main() {
  try {
    process.stdout.write(`${JSON.stringify(await runRevokeSessions(process.argv.slice(2)))}\n`);
  } catch {
    process.stderr.write(
      'Session revocation refused; check private input, explicit operator connection and plan digest.\n',
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
