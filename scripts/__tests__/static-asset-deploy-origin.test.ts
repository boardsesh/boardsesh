/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATIC_ASSET_ORIGIN } from '../../packages/shared/static-assets/src';

describe('static asset production origin', () => {
  it('keeps both browser builds aligned with the uploader validation origin', () => {
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');

    expect(workflow).toContain(`EXPO_PUBLIC_STATIC_ASSET_BASE_URL: ${STATIC_ASSET_ORIGIN}`);
    expect(workflow).toContain(`NEXT_PUBLIC_STATIC_ASSET_BASE_URL: ${STATIC_ASSET_ORIGIN}`);
  });
});
