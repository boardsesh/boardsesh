import { describe, expect, it } from 'vitest';
import { AURA_GPU_FAMILIES, auraGpuRolloutEnabled, parseAuraGpuRollout } from '../gpu-rollout';

const policy = (enabledFamilies: readonly string[] = [], disabledFamilies: readonly string[] = []) =>
  parseAuraGpuRollout({ version: 1, enabledFamilies, disabledFamilies });

describe('Aura GPU rollout', () => {
  it('fails open for the shipped Homewall path only', () => {
    const unresolved = parseAuraGpuRollout(undefined);
    expect(
      auraGpuRolloutEnabled({
        userEnabled: true,
        flag: undefined,
        policy: unresolved,
        boardName: 'kilter',
        layoutId: 8,
      }),
    ).toBe(true);
    for (const boardName of AURA_GPU_FAMILIES) {
      expect(auraGpuRolloutEnabled({ userEnabled: true, flag: true, policy: unresolved, boardName, layoutId: 1 })).toBe(
        false,
      );
    }
  });

  it.each(AURA_GPU_FAMILIES)('enables %s independently while the global switch wins', (boardName) => {
    const selected = policy([boardName]);
    expect(auraGpuRolloutEnabled({ userEnabled: true, flag: true, policy: selected, boardName, layoutId: 1 })).toBe(
      true,
    );
    expect(auraGpuRolloutEnabled({ userEnabled: true, flag: false, policy: selected, boardName, layoutId: 1 })).toBe(
      false,
    );
    for (const other of AURA_GPU_FAMILIES.filter((family) => family !== boardName)) {
      expect(
        auraGpuRolloutEnabled({ userEnabled: true, flag: true, policy: selected, boardName: other, layoutId: 1 }),
      ).toBe(false);
    }
  });

  it('lets a family disable override both legacy availability and explicit enables', () => {
    expect(
      auraGpuRolloutEnabled({
        userEnabled: true,
        flag: true,
        policy: policy(['kilter'], ['kilter']),
        boardName: 'kilter',
        layoutId: 8,
      }),
    ).toBe(false);
    expect(
      auraGpuRolloutEnabled({
        userEnabled: true,
        flag: true,
        policy: policy(['tension'], ['tension']),
        boardName: 'tension',
        layoutId: 1,
      }),
    ).toBe(false);
  });

  it('does not use an allowlist without a resolved positive global value', () => {
    for (const flag of [undefined, 'unknown-variant']) {
      expect(
        auraGpuRolloutEnabled({
          userEnabled: true,
          flag,
          policy: policy(['tension']),
          boardName: 'tension',
          layoutId: 1,
        }),
      ).toBe(false);
      expect(
        auraGpuRolloutEnabled({
          userEnabled: true,
          flag,
          policy: policy(['tension']),
          boardName: 'kilter',
          layoutId: 8,
        }),
      ).toBe(true);
    }
  });

  it.each([
    null,
    true,
    'all',
    [],
    {},
    { version: 2, enabledFamilies: ['tension'] },
    { version: 1, enabledFamilies: true },
    { version: 1, enabledFamilies: ['spray'] },
    { version: 1, enabledFamilies: ['tension'], disabledFamilies: 'kilter' },
    { version: 1, enabledFamilies: Array(2) },
    { version: 1, enabledFamilies: Array(9).fill('tension') },
  ])('cannot widen eligibility with malformed payload %j', (payload) => {
    expect(parseAuraGpuRollout(payload)).toEqual(policy());
  });

  it('normalizes duplicates/order and accepts an omitted optional disable list', () => {
    expect(parseAuraGpuRollout({ version: 1, enabledFamilies: ['woods', 'kilter', 'woods'] })).toEqual(
      policy(['kilter', 'woods']),
    );
  });

  it('never enables custom or unknown wall families', () => {
    expect(
      auraGpuRolloutEnabled({
        userEnabled: true,
        flag: true,
        policy: policy(AURA_GPU_FAMILIES),
        boardName: 'spray',
        layoutId: 8,
      }),
    ).toBe(false);
  });

  describe('climber GPU acceleration switch', () => {
    const everyBoard = [...AURA_GPU_FAMILIES, 'spray', 'unknown'];

    it('turns every board off even when the flag and family are enabled', () => {
      const allEnabled = policy([...AURA_GPU_FAMILIES]);
      for (const boardName of everyBoard) {
        for (const layoutId of [1, 8, undefined]) {
          expect(
            auraGpuRolloutEnabled({ flag: true, policy: allEnabled, userEnabled: false, boardName, layoutId }),
          ).toBe(false);
        }
      }
      expect(auraGpuRolloutEnabled({ flag: undefined, policy: allEnabled, userEnabled: false })).toBe(false);
      expect(
        auraGpuRolloutEnabled({
          flag: undefined,
          policy: allEnabled,
          userEnabled: false,
          boardName: 'kilter',
          layoutId: 8,
        }),
      ).toBe(false);
    });

    it('leaves the rollout result unchanged when on', () => {
      const selected = policy(['tension']);
      expect(
        auraGpuRolloutEnabled({ flag: true, policy: selected, userEnabled: true, boardName: 'tension', layoutId: 1 }),
      ).toBe(true);
      expect(
        auraGpuRolloutEnabled({ flag: true, policy: selected, userEnabled: true, boardName: 'woods', layoutId: 1 }),
      ).toBe(false);
      expect(
        auraGpuRolloutEnabled({
          flag: undefined,
          policy: selected,
          userEnabled: true,
          boardName: 'kilter',
          layoutId: 8,
        }),
      ).toBe(true);
      expect(auraGpuRolloutEnabled({ flag: true, policy: selected, userEnabled: true })).toBe(true);
    });

    it('never forces the GPU on: the remote kill switch still wins', () => {
      const selected = policy(['tension']);
      expect(
        auraGpuRolloutEnabled({ flag: false, policy: selected, userEnabled: true, boardName: 'tension', layoutId: 1 }),
      ).toBe(false);
      expect(auraGpuRolloutEnabled({ flag: false, policy: selected, userEnabled: true })).toBe(false);
      expect(
        auraGpuRolloutEnabled({ flag: true, policy: policy(), userEnabled: true, boardName: 'tension', layoutId: 1 }),
      ).toBe(false);
    });
  });
});
