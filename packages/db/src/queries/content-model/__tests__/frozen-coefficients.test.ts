import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hydrateFrozenGradeCoefficients } from '../frozen-coefficients';

void describe('hydrateFrozenGradeCoefficients', () => {
  void test('hydrates persisted rows from one immutable version', () => {
    const coefficients = hydrateFrozenGradeCoefficients([
      { coeff_version: 'v1', kind: 'echo_fraction', key: 'kilter', payload: { lambda: 0.85 } },
      {
        coeff_version: 'v1',
        kind: 'board_offset',
        key: 'kilter',
        payload: { offset: -1.2, sd: 0.4, users: 50, looMaxDelta: 0.1 },
      },
    ]);

    assert.ok(coefficients);
    assert.equal(coefficients.coeffVersion, 'v1');
    assert.equal(coefficients.echoFraction.kilter, 0.85);
    assert.equal(coefficients.boardOffset.kilter.offset, -1.2);
  });

  void test('rejects rows from different coefficient versions', () => {
    assert.throws(
      () =>
        hydrateFrozenGradeCoefficients([
          { coeff_version: 'v1', kind: 'echo_fraction', key: 'kilter', payload: { lambda: 0.85 } },
          { coeff_version: 'v2', kind: 'echo_fraction', key: 'tension', payload: { lambda: 0.8 } },
        ]),
      /mixed coefficient-version/,
    );
  });
});
