import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { OwnedDatabase } from './database';
import { identityInvariant } from './invariants';
import type { RehearsalWorker } from './processes';
import { keyedReference, RehearsalSafetyError } from './target-guard';

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new RehearsalSafetyError(code);
}
async function socket(port: number, credential: string) {
  const connection = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
  let acknowledged = false;
  let closedCode: number | undefined;
  connection.on('error', () => {});
  connection.on('close', (code) => {
    closedCode = code;
  });
  connection.on('message', (frame) => {
    const buffer = Array.isArray(frame) ? Buffer.concat(frame) : Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    const message: unknown = JSON.parse(buffer.toString('utf8'));
    if (message && typeof message === 'object' && 'type' in message && message.type === 'connection_ack')
      acknowledged = true;
  });
  const deadline = Date.now() + 5000;
  while (connection.readyState === WebSocket.CONNECTING && Date.now() < deadline) await pause(10);
  ensure(connection.readyState === WebSocket.OPEN, 'OWNED_WS_OPEN_FAILED');
  connection.send(JSON.stringify({ type: 'connection_init', payload: { authToken: credential } }));
  return {
    async admitted() {
      while (!acknowledged && closedCode === undefined && Date.now() < deadline) await pause(10);
      ensure(acknowledged, 'OWNED_WS_ACK_REQUIRED');
    },
    async denied() {
      const closeDeadline = Date.now() + 5000;
      while (closedCode === undefined && Date.now() < closeDeadline) await pause(10);
      ensure(closedCode === 4401, 'OWNED_WS_CUTOFF_REQUIRED');
    },
    close() {
      connection.terminate();
    },
    get acknowledged() {
      return acknowledged;
    },
  };
}

/** Actual product helpers/handlers in independent processes; never claims a writer-switch rehearsal. */
export async function runRaces(database: OwnedDatabase, first: RehearsalWorker, second: RehearsalWorker) {
  await database.assertMarker();
  const subjects = Array.from({ length: 5 }, () => randomUUID());
  const projectionId = randomUUID();
  await database.client`INSERT INTO auth_email_projection (projection_id,is_current,normalizer_version,phase,writer_epoch,prepared_at)
    VALUES (${projectionId}, true, 'js-trim-lower-v1', 'enforced', 1, now())`;
  for (const [index, subject] of subjects.entries()) {
    await database.client`INSERT INTO users (id,email,name,"emailVerified") VALUES (${subject}, ${`${subject}@example.invalid`}, 'Synthetic rehearsal', ${index === 0 ? new Date() : null})`;
    await database.client`INSERT INTO user_credentials (user_id,password_hash) VALUES (${subject}, 'synthetic-original')`;
  }
  await database.client`INSERT INTO accounts ("userId",type,provider,"providerAccountId") VALUES (${subjects[2]}, 'oauth', 'fixture-provider', ${randomUUID()})`;
  const refreshToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
  await database.client`INSERT INTO mobile_refresh_tokens (user_id,token_hash,expires_at,subject_generation,native_generation)
    VALUES (${subjects[1]}, ${tokenHash}, now() + interval '1 day', 0, 0)`;
  const baseline = await identityInvariant(database);
  const baselinePasswords = await database.client<
    { user_id: string; password_hash: string }[]
  >`SELECT user_id,password_hash FROM user_credentials ORDER BY user_id`;
  const credentials: string[] = [];
  for (const subject of subjects) {
    const reply = await first.command('cookie', { userId: subject, authSessionId: randomUUID(), generation: 0 });
    ensure(typeof reply.result.credential === 'string', 'OWNED_COOKIE_REQUIRED');
    credentials.push(reply.result.credential);
  }
  const bridgeControl = await first.command('bridge', { credential: credentials[1] });
  ensure(
    bridgeControl.result.status === 'bridged' && typeof bridgeControl.result.canonicalToken === 'string',
    'OWNED_SUCCESSFUL_BRIDGE_REQUIRED',
  );
  const bridgedAdmission = await second.command('canonical-read', { credential: bridgeControl.result.canonicalToken });
  ensure(
    bridgedAdmission.result.status === 'admitted' && bridgedAdmission.result.subject === subjects[1],
    'OWNED_PERSISTED_BRIDGE_REQUIRED',
  );
  const controlRefreshToken = randomBytes(32).toString('hex');
  const controlTokenHash = createHash('sha256').update(controlRefreshToken).digest('hex');
  await database.assertMarker();
  await database.client`INSERT INTO mobile_refresh_tokens (user_id,token_hash,expires_at,subject_generation,native_generation)
    VALUES (${subjects[2]}, ${controlTokenHash}, now() + interval '1 day', 0, 0)`;
  const successfulRefresh = await first.command('refresh', { refreshToken: controlRefreshToken });
  ensure(
    successfulRefresh.result.status === 200 &&
      !!successfulRefresh.result.body &&
      typeof successfulRefresh.result.body === 'object',
    'OWNED_SUCCESSFUL_REFRESH_REQUIRED',
  );
  const controlBody = successfulRefresh.result.body as Record<string, unknown>;
  ensure(
    typeof controlBody.jwt === 'string' && typeof controlBody.refreshToken === 'string',
    'OWNED_REFRESH_CHILD_PROOFS_REQUIRED',
  );
  ensure(
    (await second.command('native-read', { credential: controlBody.jwt })).result.admitted === true,
    'OWNED_REFRESH_CHILD_ADMISSION_REQUIRED',
  );
  ensure(
    (await second.command('native-revoke', { tokenHash: controlTokenHash })).result.revoked === false,
    'OWNED_CONSUMED_PARENT_REFUSAL_REQUIRED',
  );
  const controlChildHash = createHash('sha256').update(controlBody.refreshToken).digest('hex');
  ensure(
    (await second.command('native-revoke', { tokenHash: controlChildHash })).result.revoked === true,
    'OWNED_REFRESH_CHILD_REVOCATION_REQUIRED',
  );
  const controlAdmissions = await Promise.all([
    first.command('native-read', { credential: controlBody.jwt }),
    second.command('native-read', { credential: controlBody.jwt }),
  ]);
  ensure(
    controlAdmissions.every((reply) => reply.result.admitted === false),
    'OWNED_REVOKED_REFRESH_CHILD_ACCESS_FORBIDDEN',
  );
  const measurements: { race: string; durationMs: number; outcome: string }[] = [];
  let started = performance.now();
  const bridgeReset = await Promise.all([
    first.command('bridge', { credential: credentials[0] }),
    second.command('reset', { userId: subjects[0] }),
  ]);
  ensure(['bridged', 'denied'].includes(String(bridgeReset[0].result.status)), 'OWNED_BRIDGE_RACE_REFUSED');
  ensure(
    (await first.command('read', { credential: credentials[0] })).result.status === 'denied',
    'OWNED_RESET_MUST_DENY_OLD_PROOF',
  );
  ensure(
    (await second.command('bridge', { credential: credentials[0] })).result.status === 'denied',
    'OWNED_RESET_OLD_BRIDGE_REFUSAL_REQUIRED',
  );
  if (bridgeReset[0].result.status === 'bridged') {
    ensure(typeof bridgeReset[0].result.canonicalToken === 'string', 'OWNED_RACE_CANONICAL_PROOF_REQUIRED');
    ensure(
      (await second.command('canonical-read', { credential: bridgeReset[0].result.canonicalToken })).result.status ===
        'denied',
      'OWNED_RESET_OLD_CANONICAL_FORBIDDEN',
    );
  }
  measurements.push({ race: 'bridge-reset', durationMs: performance.now() - started, outcome: 'old-proof-denied' });

  const initialNative = await first.command('native-token', { userId: subjects[1] });
  ensure(typeof initialNative.result.jwt === 'string', 'OWNED_NATIVE_PROOF_REQUIRED');
  ensure(
    (await second.command('native-read', { credential: initialNative.result.jwt })).result.admitted === true,
    'OWNED_VALID_NATIVE_PROOF_REQUIRED',
  );
  started = performance.now();
  const refreshSignout = await Promise.all([
    first.command('refresh', { refreshToken }),
    second.command('native-revoke', { tokenHash }),
  ]);
  const refreshed = refreshSignout[0].result;
  const signedOut = refreshSignout[1].result.revoked === true;
  ensure(refreshed.status === 200 || refreshed.status === 401, 'OWNED_REFRESH_RACE_REFUSED');
  if (!signedOut) {
    // The consumed parent cannot ACK signout. Its returned live descendant must be revocable.
    ensure(
      refreshed.status === 200 && !!refreshed.body && typeof refreshed.body === 'object',
      'OWNED_UNACKNOWLEDGED_SIGNOUT_REQUIRED',
    );
    const body = refreshed.body as Record<string, unknown>;
    ensure(typeof body.refreshToken === 'string', 'OWNED_LIVE_REFRESH_CHILD_REQUIRED');
    const childHash = createHash('sha256').update(body.refreshToken).digest('hex');
    ensure(
      (await second.command('native-revoke', { tokenHash: childHash })).result.revoked === true,
      'OWNED_ACKNOWLEDGED_REVOCATION_REQUIRED',
    );
  }
  const rows = await database.client<
    { count: number }[]
  >`SELECT count(*)::integer AS count FROM mobile_refresh_tokens WHERE user_id = ${subjects[1]} AND revoked_at IS NULL`;
  ensure(rows[0].count === 0, 'OWNED_SIGNOUT_LIVE_CHILD_FORBIDDEN');
  const nativeAccessProofs = [initialNative.result.jwt];
  if (refreshed.status === 200) {
    ensure(!!refreshed.body && typeof refreshed.body === 'object', 'OWNED_REFRESH_RESPONSE_REQUIRED');
    const body = refreshed.body as Record<string, unknown>;
    ensure(typeof body.jwt === 'string', 'OWNED_CHILD_ACCESS_PROOF_REQUIRED');
    nativeAccessProofs.push(body.jwt);
  }
  for (const proof of nativeAccessProofs) {
    const admissions = await Promise.all([
      first.command('native-read', { credential: proof }),
      second.command('native-read', { credential: proof }),
    ]);
    ensure(
      admissions.every((reply) => reply.result.admitted === false),
      'OWNED_SIGNOUT_RETURNED_ACCESS_FORBIDDEN',
    );
  }
  ensure(
    (await first.command('read', { credential: credentials[1] })).result.status === 'admitted',
    'OWNED_NATIVE_SIGNOUT_WEB_PROOF_MUST_SURVIVE',
  );
  ensure(
    (await second.command('canonical-read', { credential: bridgeControl.result.canonicalToken })).result.status ===
      'admitted',
    'OWNED_NATIVE_SIGNOUT_WEB_CANONICAL_MUST_SURVIVE',
  );
  measurements.push({
    race: 'refresh-signout',
    durationMs: performance.now() - started,
    outcome: signedOut
      ? 'acknowledged-signout-no-live-child'
      : 'refresh-won-parent-refused-child-revocation-acknowledged',
  });

  started = performance.now();
  const accounts = await Promise.all([
    first.command('read', { credential: credentials[2] }),
    second.command('read', { credential: credentials[3] }),
  ]);
  ensure(
    accounts[0].result.subject === subjects[2] && accounts[1].result.subject === subjects[3],
    'OWNED_ACCOUNT_BINDING_REQUIRED',
  );
  measurements.push({
    race: 'account-switch-server-binding',
    durationMs: performance.now() - started,
    outcome: 'source-identity-preserved-cross-tab-cookie-order-unqualified',
  });

  const activityStartedDay = new Date().toISOString().slice(0, 10);
  const connected = await socket(first.port, credentials[4]);
  try {
    await connected.admitted();
    started = performance.now();
    await second.command('reset', { userId: subjects[4] });
    await connected.denied();
    const reconnect = await socket(second.port, credentials[4]);
    try {
      await reconnect.denied();
      ensure(!reconnect.acknowledged, 'OWNED_RECONNECT_ACK_FORBIDDEN');
    } finally {
      reconnect.close();
    }
    measurements.push({
      race: 'reconnect-websocket',
      durationMs: performance.now() - started,
      outcome: 'live-and-reconnect-denied',
    });
  } finally {
    connected.close();
  }
  const allowedActivityDays = new Set([activityStartedDay, new Date().toISOString().slice(0, 10)]);
  const activityDeadline = Date.now() + 5000;
  let activityRows = await database.client<
    { user_id: string; day: string; platform: string }[]
  >`SELECT user_id,day::text,platform FROM user_activity_days`;
  while (activityRows.length === 0 && Date.now() < activityDeadline) {
    await pause(10);
    activityRows = await database.client<
      { user_id: string; day: string; platform: string }[]
    >`SELECT user_id,day::text,platform FROM user_activity_days`;
  }
  ensure(
    activityRows.length === 1 &&
      activityRows[0].user_id === subjects[4] &&
      activityRows[0].platform === 'unknown' &&
      allowedActivityDays.has(activityRows[0].day),
    'OWNED_WS_ACTIVITY_MUTATION_UNEXPECTED',
  );
  const final = await identityInvariant(database);
  const finalPasswords = await database.client<
    { user_id: string; password_hash: string }[]
  >`SELECT user_id,password_hash FROM user_credentials ORDER BY user_id`;
  ensure(finalPasswords.length === baselinePasswords.length, 'OWNED_PASSWORD_COUNT_CHANGED');
  let intendedHashesChanged = 0;
  let untouchedHashesPreserved = 0;
  for (const previous of baselinePasswords) {
    const current = finalPasswords.find((entry) => entry.user_id === previous.user_id);
    ensure(current, 'OWNED_PASSWORD_SUBJECT_CHANGED');
    if (previous.user_id === subjects[0] || previous.user_id === subjects[4]) {
      ensure(current.password_hash !== previous.password_hash, 'OWNED_INTENDED_PASSWORD_CHANGE_MISSING');
      intendedHashesChanged++;
    } else {
      ensure(current.password_hash === previous.password_hash, 'OWNED_UNEXPECTED_PASSWORD_CHANGE');
      untouchedHashesPreserved++;
    }
  }
  ensure(final.identityDigest === baseline.identityDigest, 'OWNED_IDENTITY_RECORDS_CHANGED');
  ensure(final.referenceDigest === baseline.referenceDigest, 'OWNED_REFERENCE_COUNTS_CHANGED');
  return {
    qualification: 'partial-synthetic',
    fixtureReference: keyedReference(database.target.secrets.reportKey, database.target.runNonce),
    instanceCount: 2,
    controls: {
      persistedBridgeAdmitted: true,
      successfulRefreshChildAdmittedThenRevoked: true,
      nativeProofAdmittedBeforeRevocation: true,
      acknowledgedRevocation: true,
      webProofsSurvivedNativeRevocation: true,
    },
    measurements,
    invariants: {
      ...final,
      intendedHashesChanged,
      untouchedHashesPreserved,
      expectedActivityRows: activityRows.length,
    },
    blockers: [
      'writer-switch-stop-rollback-not-exercised',
      'host-worker-egress-isolation-unqualified',
      'cross-tab-delayed-set-cookie-order-unqualified',
      'owner-test-watch-queue-original-key-real-qa-unqualified',
      'restored-copy-full-reference-audit-not-exercised',
    ],
  };
}
