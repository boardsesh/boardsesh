export type CppUpstreamDiagnosticPhase = 'fetch-error' | 'body-error' | 'client-closed' | 'response';

export interface CppUpstreamDiagnosticInput {
  operationName: string | null;
  documentHash: string;
  variablesHash: string;
  phase: CppUpstreamDiagnosticPhase;
  elapsedMs: number;
  status?: number;
  error?: unknown;
}

const PHASES = new Set(['fetch-error', 'body-error', 'client-closed', 'response']);
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ABORT_ERR',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'UND_ERR_DESTROYED',
  'UND_ERR_CLOSED',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
]);

function ownProperty(error: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function aggregateCauses(errors: unknown): unknown[] {
  try {
    if (!Array.isArray(errors)) return [];
  } catch {
    return [];
  }
  const length = ownProperty(errors, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return [];
  const causes: unknown[] = [];
  for (let index = 0; index < Math.min(length, 16); index += 1) {
    causes.push(ownProperty(errors, String(index)));
  }
  return causes;
}

function networkCodes(error: unknown): string[] {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  const codes = new Set<string>();
  while (pending.length > 0 && visited.size < 16) {
    const currentError = pending.shift();
    if (typeof currentError !== 'object' || currentError === null || visited.has(currentError)) continue;
    visited.add(currentError);
    const code = ownProperty(currentError, 'code');
    if (typeof code === 'string' && NETWORK_CODES.has(code)) codes.add(code);
    pending.push(ownProperty(currentError, 'cause'));
    const errors = ownProperty(currentError, 'errors');
    pending.push(...aggregateCauses(errors));
  }
  return [...codes].sort();
}

/** Diagnostic-only: no messages, stacks, URLs, headers, bodies or account fields. */
export function formatCppUpstreamDiagnostic(input: CppUpstreamDiagnosticInput): string {
  const operation =
    input.operationName !== null && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input.operationName)
      ? input.operationName
      : 'anonymous';
  const hash = (digest: string) => (/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(digest) ? digest : 'UNKNOWN');
  const elapsed =
    Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0 && Number.isSafeInteger(Math.round(input.elapsedMs))
      ? String(Math.round(input.elapsedMs))
      : 'UNKNOWN';
  const status =
    input.status !== undefined && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
      ? String(input.status)
      : 'UNKNOWN';
  return [
    '[screenshot-backend] CPP-UPSTREAM',
    'operation=' + operation,
    'phase=' + (PHASES.has(input.phase) ? input.phase : 'UNKNOWN'),
    'elapsedMs=' + elapsed,
    'status=' + status,
    'documentHash=' + hash(input.documentHash),
    'variablesHash=' + hash(input.variablesHash),
    'codes=' + (networkCodes(input.error).join(',') || 'UNKNOWN'),
  ].join(' ');
}
