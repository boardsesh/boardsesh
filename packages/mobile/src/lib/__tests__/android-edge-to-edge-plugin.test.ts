import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type GradleProp = { type: string; key?: string; value?: string };
type AndroidEdgeToEdgePlugin = {
  applyEdgeToEdge(gradleProps: GradleProp[]): GradleProp[];
  PROPS: Record<string, string>;
};

const plugin = require('../../../plugins/with-android-edge-to-edge.js') as AndroidEdgeToEdgePlugin;

describe('with-android-edge-to-edge', () => {
  it('appends edgeToEdgeEnabled=true when the property is absent', () => {
    const result = plugin.applyEdgeToEdge([{ type: 'property', key: 'org.gradle.parallel', value: 'false' }]);

    expect(result).toContainEqual({ type: 'property', key: 'edgeToEdgeEnabled', value: 'true' });
    // Existing properties are preserved.
    expect(result).toContainEqual({ type: 'property', key: 'org.gradle.parallel', value: 'false' });
  });

  it('upserts an existing edgeToEdgeEnabled property instead of duplicating it', () => {
    const result = plugin.applyEdgeToEdge([{ type: 'property', key: 'edgeToEdgeEnabled', value: 'false' }]);

    const entries = result.filter((entry) => entry.key === 'edgeToEdgeEnabled');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('true');
  });

  it('enables edge-to-edge (RN 0.86 built-in + nav-bar module requirement)', () => {
    expect(plugin.PROPS.edgeToEdgeEnabled).toBe('true');
  });
});
