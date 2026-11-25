import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CATALOG_ADMISSION_PATH,
  CATALOG_PROOF_HEADER,
  verifyCatalogRequest,
} from '@boardsesh/crypto/catalog-request-proof';
import { CATALOG_SNAPSHOT_MANIFEST_URL } from '@boardsesh/shared-schema/catalog-access-policy';
import {
  CatalogRateLimitError,
  reserveCatalogAccess,
  releaseCatalogAccess,
  type CatalogAccessLease,
} from '../utils/catalog-budget';
import { sendJson } from './http-utils';

const MAX_BODY_BYTES = 2048;
const BODY_DEADLINE_MS = 2000;

// Only the backend chooses the work charge and maximum result reservation.
// Setter stats already limits its grouped result to 50 rows in the shared query.
const REST_CATALOG_COSTS = {
  restclimb: { requestedRows: 1, workUnits: 2 },
  reststats: { requestedRows: 181, workUnits: 3 },
  restsetters: { requestedRows: 50, workUnits: 10 },
} as const;

class AdmissionBodyError extends Error {
  constructor(readonly status: number) {
    super('Invalid catalog admission body');
  }
}

function readAdmissionBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    return Promise.reject(new AdmissionBodyError(413));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const timer = setTimeout(() => finish(new AdmissionBodyError(408)), BODY_DEADLINE_MS);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.pause();
        finish(new AdmissionBodyError(413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new AdmissionBodyError(400));
    const onAborted = () => finish(new AdmissionBodyError(400));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function isLease(candidate: unknown): candidate is CatalogAccessLease {
  if (!isRecord(candidate) || Object.keys(candidate).length !== 5) return false;
  return (
    typeof candidate.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.id) &&
    Number.isSafeInteger(candidate.expiresAt) &&
    (candidate.expiresAt as number) >= 0 &&
    Number.isSafeInteger(candidate.requestedRows) &&
    (candidate.requestedRows as number) >= 0 &&
    (candidate.requestedRows as number) <= 181 &&
    candidate.lane === 'interactive' &&
    (candidate.mode === 'redis' || candidate.mode === 'local')
  );
}

/** Internal reservation protocol; it neither authenticates a user nor runs a catalog query. */
export async function handleCatalogAdmission(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== CATALOG_ADMISSION_PATH) return false;
  const proof = req.headers[CATALOG_PROOF_HEADER];
  if (req.method !== 'POST' || req.headers.origin !== undefined || typeof proof !== 'string') {
    sendJson(res, 403, { error: 'Catalog admission requires a server proof' });
    return true;
  }
  try {
    const body = await readAdmissionBody(req);
    const command: unknown = JSON.parse(body);
    if (!isRecord(command) || (command.action !== 'reserve' && command.action !== 'release')) {
      throw new AdmissionBodyError(400);
    }
    const attribution = verifyCatalogRequest(
      proof,
      { purpose: command.action, method: 'POST', pathname, body },
      process.env.NEXTAUTH_SECRET,
    );
    if (!attribution) {
      sendJson(res, 403, { error: 'Invalid catalog admission proof' });
      return true;
    }
    if (command.action === 'reserve') {
      if (
        Object.keys(command).length !== 2 ||
        typeof command.operation !== 'string' ||
        !Object.hasOwn(REST_CATALOG_COSTS, command.operation)
      ) {
        throw new AdmissionBodyError(400);
      }
      const operation = command.operation as keyof typeof REST_CATALOG_COSTS;
      const lease = await reserveCatalogAccess(
        { trustedClientIp: attribution.clientIp },
        { operation, lane: 'interactive', ...REST_CATALOG_COSTS[operation] },
      );
      sendJson(res, 200, { lease });
    } else {
      if (
        Object.keys(command).length !== 3 ||
        !isLease(command.lease) ||
        (command.actualRows !== null &&
          (!Number.isSafeInteger(command.actualRows) ||
            (command.actualRows as number) < 0 ||
            (command.actualRows as number) > command.lease.requestedRows))
      ) {
        throw new AdmissionBodyError(400);
      }
      await releaseCatalogAccess(
        command.lease,
        command.actualRows === null ? undefined : (command.actualRows as number),
      );
      sendJson(res, 200, { released: true });
    }
  } catch (error) {
    if (error instanceof CatalogRateLimitError) {
      sendJson(
        res,
        429,
        {
          error: 'Catalog request budget exceeded. Use the daily snapshots for bulk downloads.',
          code: error.code,
          retryAfterSeconds: error.retryAfterSeconds,
          snapshotManifestUrl: CATALOG_SNAPSHOT_MANIFEST_URL,
        },
        { 'Retry-After': String(Math.max(1, error.retryAfterSeconds)) },
      );
    } else if (error instanceof AdmissionBodyError || error instanceof SyntaxError) {
      sendJson(res, error instanceof AdmissionBodyError ? error.status : 400, {
        error: 'Invalid catalog admission body',
      });
    } else {
      sendJson(res, 503, { error: 'Catalog admission is temporarily unavailable' }, { 'Retry-After': '1' });
    }
  }
  return true;
}
