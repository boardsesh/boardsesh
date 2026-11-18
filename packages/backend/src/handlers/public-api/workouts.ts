import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import {
  CreateWorkoutSchema,
  WorkoutListQuerySchema,
  WorkoutListSchema,
  WorkoutConflictSchema,
} from '@boardsesh/public-api';
import {
  AppWorkoutError,
  createPartnerWorkout,
  readPartnerWorkout,
  listPartnerWorkouts,
  cancelPartnerWorkout,
} from '../../services/public-api/workouts';
import { errorOutcome, unauthorized, CHALLENGE_INVALID_TOKEN, type ApiOutcome } from './outcome';
import type { PublicApiRequestRoute } from './http';
import type { PartnerRuntime } from './router';
import type { PartnerApiPrincipal } from '../../auth/partner/bearer';

export class WorkoutBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
let bodyReads = 0;
const readsByAddress = new Map<string, number>();

/** Buffer before a database/admission permit is held. */
export async function readWorkoutBody(req: IncomingMessage, address: string): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new WorkoutBodyError(400, 'Send an application/json body.');
  if (Number(req.headers['content-length']) > 65_536)
    throw new WorkoutBodyError(413, 'Request body must not exceed 64 KB.');
  if (bodyReads >= 128 || (readsByAddress.get(address) ?? 0) >= 8)
    throw new WorkoutBodyError(503, 'The server is busy. Try again shortly.');
  bodyReads += 1;
  readsByAddress.set(address, (readsByAddress.get(address) ?? 0) + 1);
  let body: Buffer;
  try {
    body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      const timer = setTimeout(() => finish(new WorkoutBodyError(408, 'Request body timed out.')), 5000);
      timer.unref();
      const finish = (result: Buffer | Error) => {
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('close', onClose);
        if (result instanceof Buffer) resolve(result);
        else reject(result);
      };
      const onData = (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65_536) finish(new WorkoutBodyError(413, 'Request body must not exceed 64 KB.'));
        else chunks.push(chunk);
      };
      const onEnd = () => finish(Buffer.concat(chunks));
      const onError = () => finish(new WorkoutBodyError(400, 'Unable to read request body.'));
      const onClose = () => {
        if (!req.complete) finish(new WorkoutBodyError(400, 'Incomplete request body.'));
      };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  } finally {
    bodyReads -= 1;
    const remaining = (readsByAddress.get(address) ?? 1) - 1;
    if (remaining) readsByAddress.set(address, remaining);
    else readsByAddress.delete(address);
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new WorkoutBodyError(400, 'Body is not valid JSON.');
  }
}

export async function serveWorkoutRoute(
  runtime: PartnerRuntime,
  principal: PartnerApiPrincipal,
  route: PublicApiRequestRoute,
  req: IncomingMessage,
  requestId: string,
  body?: unknown,
): Promise<ApiOutcome> {
  const scope =
    route.kind === 'workouts-create' || route.kind === 'workout-cancel' ? 'workouts:write' : 'workouts:read';
  if (!principal.scopes.includes(scope))
    return errorOutcome(403, 'insufficient_scope', `This call needs ${scope}.`, requestId, {
      headers: { 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}"` },
    });
  try {
    switch (route.kind) {
      case 'workouts-create': {
        const key = z.uuid().safeParse(req.headers['idempotency-key']);
        if (!key.success)
          return errorOutcome(400, 'invalid_request', 'Idempotency-Key must be a UUID.', requestId, {
            field: 'Idempotency-Key',
          });
        const spec = CreateWorkoutSchema.safeParse(body);
        if (!spec.success) {
          const issue = spec.error.issues[0];
          return errorOutcome(422, 'invalid_block', issue.message, requestId, {
            field: issue.path.join('.') || 'body',
          });
        }
        return {
          status: 201,
          body: await createPartnerWorkout(
            runtime.database,
            principal,
            spec.data,
            key.data,
            new Date(),
            runtime.configuration.resource,
          ),
        };
      }
      case 'workout-get':
        return {
          status: 200,
          body: await readPartnerWorkout(
            runtime.database,
            principal,
            route.workoutId ?? '',
            runtime.configuration.resource,
          ),
        };
      case 'workouts-list': {
        const query = WorkoutListQuerySchema.safeParse(
          Object.fromEntries(new URL(req.url ?? '', 'https://api.boardsesh.com').searchParams),
        );
        if (!query.success) return errorOutcome(400, 'invalid_request', 'Invalid workout query.', requestId);
        return {
          status: 200,
          body: WorkoutListSchema.parse(
            await listPartnerWorkouts(runtime.database, principal, query.data, runtime.configuration.resource),
          ),
        };
      }
      case 'workout-cancel':
        await cancelPartnerWorkout(runtime.database, principal, route.workoutId ?? '', runtime.configuration.resource);
        return { status: 204 };
      default:
        throw new Error('Not a workout route.');
    }
  } catch (error) {
    if (!(error instanceof AppWorkoutError)) throw error;
    if (error.code === 'invalid_token') return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, 'changed_under_lock');
    const outcome = errorOutcome(error.status, error.code, error.message, requestId, { field: error.field });
    return error.existing
      ? { ...outcome, body: WorkoutConflictSchema.parse({ ...outcome.body, existing: error.existing }) }
      : outcome;
  }
}
