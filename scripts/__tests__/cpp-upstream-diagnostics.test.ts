import { describe, expect, it } from 'vitest';
import { formatCppUpstreamDiagnostic, type CppUpstreamDiagnosticInput } from '../lib/cpp-upstream-diagnostics';
import { parseScreenshotBackendLogLine } from '../lib/screenshot-fixtures';

const diagnostic: CppUpstreamDiagnosticInput = {
  operationName: 'SearchClimbs',
  documentHash: 'a'.repeat(64),
  variablesHash: 'b'.repeat(16),
  phase: 'response',
  elapsedMs: 21000.4,
  status: 200,
};

describe('CPP upstream diagnostics', () => {
  it('records late success timing without changing the existing backend audit', () => {
    const line = formatCppUpstreamDiagnostic(diagnostic);
    expect(line).toContain('operation=SearchClimbs phase=response elapsedMs=21000 status=200');
    expect(line).toContain('documentHash=' + diagnostic.documentHash);
    expect(line).toContain('variablesHash=' + diagnostic.variablesHash);
    expect(parseScreenshotBackendLogLine(line)).toBeNull();
  });

  it('collects only allowlisted cause and aggregate network codes', () => {
    const error = Object.assign(new Error('Bearer SECRET https://private.example/account'), {
      code: 'SECRET',
      cause: Object.assign(new Error('SECRET cookie'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      errors: [
        { code: 'ENOTFOUND', message: 'SECRET' },
        { code: 'ECONNRESET', headers: 'SECRET' },
      ],
    });
    const line = formatCppUpstreamDiagnostic({ ...diagnostic, phase: 'fetch-error', error, status: undefined });
    expect(line).toContain('codes=ECONNRESET,ENOTFOUND,UND_ERR_CONNECT_TIMEOUT');
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('private.example');
    expect(line).not.toContain('Bearer');
    expect(parseScreenshotBackendLogLine(line)).toBeNull();
  });

  it('bounds cyclic cause traversal and avoids invoking diagnostic getters', () => {
    let getterCalls = 0;
    const error: { cause?: unknown; code?: string } = {
      get code(): string {
        getterCalls += 1;
        throw new Error('SECRET');
      },
    };
    error.cause = error;
    expect(formatCppUpstreamDiagnostic({ ...diagnostic, error })).toContain('codes=UNKNOWN');
    expect(getterCalls).toBe(0);
  });

  it('ignores throwing indexed getters in aggregate causes', () => {
    let getterCalls = 0;
    const errors: unknown[] = [];
    Object.defineProperty(errors, '0', {
      get() {
        getterCalls += 1;
        throw new Error('SECRET');
      },
    });
    const line = formatCppUpstreamDiagnostic({ ...diagnostic, error: { errors } });
    expect(line).toContain('codes=UNKNOWN');
    expect(getterCalls).toBe(0);
  });

  it('keeps revoked aggregate proxies from replacing the original error', () => {
    const aggregate = Proxy.revocable([], {});
    aggregate.revoke();
    const line = formatCppUpstreamDiagnostic({ ...diagnostic, error: { errors: aggregate.proxy } });
    expect(line).toContain('codes=UNKNOWN');
  });

  it.each(['fetch-error', 'body-error', 'client-closed', 'response'] as const)('keeps %s diagnostic-only', (phase) => {
    const line = formatCppUpstreamDiagnostic({ ...diagnostic, phase });
    expect(line).toContain('phase=' + phase);
    expect(parseScreenshotBackendLogLine(line)).toBeNull();
  });

  it('rejects unsafe labels, hashes and numeric fields from diagnostic text', () => {
    const line = formatCppUpstreamDiagnostic({
      operationName: 'Bearer SECRET\nurl',
      documentHash: 'SECRET',
      variablesHash: 'https://private.example/SECRET',
      phase: 'SECRET' as unknown as CppUpstreamDiagnosticInput['phase'],
      elapsedMs: Number.POSITIVE_INFINITY,
      status: Number.NaN,
      error: { code: 'UND_ERR_SECRET' },
    });
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('private.example');
    expect(line).not.toContain('\n');
    expect(line).toContain('operation=anonymous phase=UNKNOWN elapsedMs=UNKNOWN status=UNKNOWN');
  });
});
