import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type AndroidEarlyEdgeToEdgePlugin = {
  addEarlyAndroidEdgeToEdge(contents: string): string;
  HELPER_NAME: string;
};

const plugin = require('../../../plugins/with-android-early-edge-to-edge.js') as AndroidEarlyEdgeToEdgePlugin;

function mainActivitySource(): string {
  return [
    'package com.boardsesh.app',
    '',
    'import android.os.Bundle',
    'import com.facebook.react.ReactActivity',
    '',
    'class MainActivity : ReactActivity() {',
    '  override fun onCreate(savedInstanceState: Bundle?) {',
    '    setTheme(R.style.AppTheme)',
    '    super.onCreate(null)',
    '  }',
    '}',
    '',
  ].join('\n');
}

describe('with-android-early-edge-to-edge', () => {
  it('enables edge-to-edge before ReactActivity onCreate attaches the root view', () => {
    const result = plugin.addEarlyAndroidEdgeToEdge(mainActivitySource());

    expect(result).toContain('import androidx.core.view.WindowCompat');
    expect(result).toContain('import com.facebook.react.views.view.setEdgeToEdgeFeatureFlagOn');
    expect(result).toContain(`private fun ${plugin.HELPER_NAME}()`);
    expect(result.indexOf(`    ${plugin.HELPER_NAME}()`)).toBeLessThan(result.indexOf('    super.onCreate(null)'));
  });

  it('keeps AppTheme setup before the early edge-to-edge call', () => {
    const result = plugin.addEarlyAndroidEdgeToEdge(mainActivitySource());

    expect(result.indexOf('    setTheme(R.style.AppTheme)')).toBeLessThan(
      result.indexOf(`    ${plugin.HELPER_NAME}()`),
    );
  });

  it('is idempotent', () => {
    const once = plugin.addEarlyAndroidEdgeToEdge(mainActivitySource());
    const twice = plugin.addEarlyAndroidEdgeToEdge(once);

    expect(twice).toBe(once);
    expect(twice.match(new RegExp(`private fun ${plugin.HELPER_NAME}`, 'g'))).toHaveLength(1);
    expect(twice.match(new RegExp(`    ${plugin.HELPER_NAME}\\(\\)`, 'g'))).toHaveLength(1);
  });
});
