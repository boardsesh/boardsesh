import { describe, expect, it } from 'vitest';
import { parseOperatorArgs } from '../operator-args';

const role = 'interactive-import' as const;
const runId = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const otherRunId = '6f1c1e7a-9d8b-4c3a-8e2f-5a4b3c2d1e0f';

describe('parseOperatorArgs', () => {
  it('parses enqueue with an optional payload and --id', () => {
    expect(parseOperatorArgs(['enqueue', 'worker-probe'], role)).toEqual({
      action: 'enqueue',
      family: 'worker-probe',
      payload: {},
      runId: undefined,
    });
    expect(parseOperatorArgs(['enqueue', 'worker-probe', '{}', '--id', runId], role)).toEqual({
      action: 'enqueue',
      family: 'worker-probe',
      payload: {},
      runId,
    });
    expect(parseOperatorArgs(['enqueue', '--id', runId, 'worker-probe'], role)).toMatchObject({ runId });
  });

  it('refuses a family the role does not serve and a payload its schema rejects', () => {
    expect(() => parseOperatorArgs(['enqueue', 'no-such-family'], role)).toThrow('UNKNOWN_FAMILY');
    expect(() => parseOperatorArgs(['enqueue', 'worker-probe', '{"sql":"DROP TABLE users"}'], role)).toThrow(
      'INVALID_PAYLOAD',
    );
    expect(() => parseOperatorArgs(['enqueue', 'worker-probe', 'not json'], role)).toThrow('INVALID_PAYLOAD');
    expect(() => parseOperatorArgs(['enqueue', 'worker-probe', '[]'], role)).toThrow('INVALID_PAYLOAD');
  });

  it('parses status, replay and probe', () => {
    expect(parseOperatorArgs(['status', runId], role)).toEqual({ action: 'status', runId });
    expect(parseOperatorArgs(['replay', runId], role)).toEqual({ action: 'replay', runId, newRunId: undefined });
    expect(parseOperatorArgs(['replay', runId, '--id', otherRunId], role)).toEqual({
      action: 'replay',
      runId,
      newRunId: otherRunId,
    });
    expect(parseOperatorArgs(['probe'], role)).toEqual({ action: 'probe', runId: undefined });
    expect(parseOperatorArgs(['probe', runId], role)).toEqual({ action: 'probe', runId });
  });

  it.each([
    [[]],
    [['drop']],
    [['enqueue']],
    [['enqueue', 'worker-probe', '{}', 'extra']],
    [['status']],
    [['status', runId, '--id', otherRunId]],
    [['replay']],
    [['probe', runId, otherRunId]],
    [['probe', '--id']],
    [['probe', '--id', runId, '--id', otherRunId]],
    [['probe', '--queue', 'pgboss.job']],
  ])('rejects %j', (argumentList) => {
    expect(() => parseOperatorArgs(argumentList, role)).toThrow();
  });

  it('rejects run IDs that are not UUIDs', () => {
    expect(() => parseOperatorArgs(['status', "1' OR 1=1"], role)).toThrow('INVALID_RUN_ID');
    expect(() => parseOperatorArgs(['enqueue', 'worker-probe', '--id', 'abc'], role)).toThrow('INVALID_RUN_ID');
  });
});
