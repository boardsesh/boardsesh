import { describe, expect, it } from 'vite-plus/test';
import {
  EXPIRED_BROWSER_BINDING_BROWSER_PATHS,
  expiredBrowserBindingBrowserPrepareSchema,
  expiredBrowserBindingBrowserControlSchema,
  expiredBrowserBindingBrowserPreparationReplySchema,
} from '../expired-browser-binding-browser-v1';

const command = {
  operationKey: 'e'.repeat(64),
  sourceCursor: { bindingId: 'a'.repeat(64), version: 3 },
  targetCursor: { bindingId: 'b'.repeat(64), version: 0 },
};
describe('explicit browser sign-in control metadata', () => {
  it('uses only the three fixed canonical coordinator POST paths', () => {
    expect(EXPIRED_BROWSER_BINDING_BROWSER_PATHS).toEqual({
      prepare: '/api/internal/auth/browser-coordinator/signin/prepare',
      commit: '/api/internal/auth/browser-coordinator/signin/commit',
      confirm: '/api/internal/auth/browser-coordinator/signin/confirm',
    });
  });
  it('prepares only from the actually presented cookies, never caller metadata', () => {
    expect(expiredBrowserBindingBrowserPrepareSchema.parse({})).toEqual({});
    for (const extra of ['bindingToken', 'sourceCursor', 'userId', 'expectedVersion', 'operationKey'])
      expect(expiredBrowserBindingBrowserPrepareSchema.safeParse({ [extra]: 'caller' }).success).toBe(false);
  });
  it('accepts only distinct source and anonymous-zero target control cursors', () => {
    expect(expiredBrowserBindingBrowserControlSchema.parse(command)).toEqual(command);
    expect(expiredBrowserBindingBrowserPreparationReplySchema.parse({ status: 'prepared', ...command })).toEqual({
      status: 'prepared',
      ...command,
    });
  });
  it.each(['bindingToken', 'targetBindingToken', 'operationToken', 'preparation', 'userId'])(
    'rejects private or identity field %s on both browser envelopes',
    (field) => {
      expect(expiredBrowserBindingBrowserControlSchema.safeParse({ ...command, [field]: 'private' }).success).toBe(
        false,
      );
      expect(
        expiredBrowserBindingBrowserPreparationReplySchema.safeParse({
          status: 'prepared',
          ...command,
          [field]: 'private',
        }).success,
      ).toBe(false);
    },
  );
  it.each(['same-binding', 'target-version', 'source-version', 'target-deadline', 'operation-key'])(
    'rejects malformed %s metadata',
    (field) => {
      const malformed =
        field === 'same-binding'
          ? { ...command, targetCursor: { ...command.targetCursor, bindingId: command.sourceCursor.bindingId } }
          : field === 'target-version'
            ? { ...command, targetCursor: { ...command.targetCursor, version: 1 } }
            : field === 'source-version'
              ? { ...command, sourceCursor: { ...command.sourceCursor, version: 2_147_483_648 } }
              : field === 'target-deadline'
                ? { ...command, targetCursor: { ...command.targetCursor, bindingExpiresAt: '2099-01-01T00:00:00Z' } }
                : { ...command, operationKey: 'E'.repeat(64) };
      expect(expiredBrowserBindingBrowserControlSchema.safeParse(malformed).success).toBe(false);
      expect(
        expiredBrowserBindingBrowserPreparationReplySchema.safeParse({ status: 'prepared', ...malformed }).success,
      ).toBe(false);
    },
  );
  it.each(['conflict', 'proof-required', 'unavailable'] as const)('retains ordinary %s refusal', (status) => {
    expect(expiredBrowserBindingBrowserPreparationReplySchema.parse({ status })).toEqual({ status });
  });
  it('permits ready metadata without treating it as an identity or installed-cookie proof', () => {
    expect(
      expiredBrowserBindingBrowserPreparationReplySchema.parse({ status: 'ready', cursor: command.sourceCursor }),
    ).toEqual({ status: 'ready', cursor: command.sourceCursor });
    expect(
      expiredBrowserBindingBrowserPreparationReplySchema.safeParse({
        status: 'ready',
        cursor: command.sourceCursor,
        userId: 'caller',
      }).success,
    ).toBe(false);
  });
});
