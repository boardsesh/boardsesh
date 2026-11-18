import { describe, expect, it } from 'vitest';
import {
  unsanctionedRetries,
  type RetriedAttempt,
} from '../../packages/web/e2e/browser-session/harness-retry-reporter';

function attempt(status: RetriedAttempt['result']['status'], stdout: string[]): RetriedAttempt['result'] {
  return { status, stdout, stderr: [] };
}

describe('browser-session harness retry reporter', () => {
  it('allows a retry only after an attempt that logged a lost WebKit context', () => {
    expect(
      unsanctionedRetries([
        {
          title: 'lost context',
          result: attempt('failed', ['[harness-retry] webkit-network-process-lost: the context lost its cookies\n']),
        },
      ]),
    ).toEqual([]);
  });

  it('refuses a retry after any other failure, timeout included', () => {
    expect(
      unsanctionedRetries([
        { title: 'assertion', result: attempt('failed', ['[webkit] request failed: GET x (internal error)\n']) },
        { title: 'slow', result: attempt('timedOut', []) },
      ]),
    ).toEqual(['assertion', 'slow']);
  });
});
