import { describe, expect, it } from 'vitest';

import { mapAcceptedVersions } from '../mobile-auto-version-bump';

describe('mapAcceptedVersions', () => {
  it('maps an attached build to its build number', () => {
    const out = mapAcceptedVersions({
      data: [
        {
          type: 'appStoreVersions',
          id: 'v1',
          attributes: { versionString: '2.1.0', appStoreState: 'READY_FOR_SALE' },
          relationships: { build: { data: { type: 'builds', id: 'b1' } } },
        },
      ],
      included: [{ type: 'builds', id: 'b1', attributes: { version: '42' } }],
    });
    expect(out).toEqual([{ versionString: '2.1.0', buildNumber: 42 }]);
  });

  it('yields buildNumber null when the relationship is explicitly null or absent', () => {
    const out = mapAcceptedVersions({
      data: [
        {
          type: 'appStoreVersions',
          id: 'v2',
          attributes: { versionString: '2.0.9', appStoreState: 'PROCESSING_FOR_APP_STORE' },
          relationships: { build: { data: null } },
        },
        {
          type: 'appStoreVersions',
          id: 'v3',
          attributes: { versionString: '2.2.0', appStoreState: 'PENDING_APPLE_RELEASE' },
        },
      ],
      included: [],
    });
    expect(out).toEqual([
      { versionString: '2.0.9', buildNumber: null },
      { versionString: '2.2.0', buildNumber: null },
    ]);
  });

  it('yields buildNumber null when the referenced build is missing from included', () => {
    const out = mapAcceptedVersions({
      data: [
        {
          type: 'appStoreVersions',
          id: 'v1',
          attributes: { versionString: '2.1.0', appStoreState: 'READY_FOR_SALE' },
          relationships: { build: { data: { type: 'builds', id: 'ghost' } } },
        },
      ],
      included: [],
    });
    expect(out).toEqual([{ versionString: '2.1.0', buildNumber: null }]);
  });

  it('ignores non-build included resources (their ids must not shadow build ids)', () => {
    const out = mapAcceptedVersions({
      data: [
        {
          type: 'appStoreVersions',
          id: 'v1',
          attributes: { versionString: '2.1.0', appStoreState: 'READY_FOR_SALE' },
          relationships: { build: { data: { type: 'builds', id: 'shared-id' } } },
        },
      ],
      // A non-build resource sharing the build's id must not be mapped as a build.
      included: [
        { type: 'appStoreVersionSubmissions', id: 'shared-id', attributes: { version: '999' } },
        { type: 'builds', id: 'shared-id', attributes: { version: '42' } },
      ],
    });
    expect(out).toEqual([{ versionString: '2.1.0', buildNumber: 42 }]);
  });

  it('treats a non-numeric build version as null', () => {
    const out = mapAcceptedVersions({
      data: [
        {
          type: 'appStoreVersions',
          id: 'v1',
          attributes: { versionString: '2.1.0', appStoreState: 'READY_FOR_SALE' },
          relationships: { build: { data: { type: 'builds', id: 'b1' } } },
        },
      ],
      included: [{ type: 'builds', id: 'b1', attributes: { version: 'abc' } }],
    });
    expect(out).toEqual([{ versionString: '2.1.0', buildNumber: null }]);
  });

  it('drops versions without a usable versionString', () => {
    const out = mapAcceptedVersions({
      data: [
        { type: 'appStoreVersions', id: 'v0', attributes: { versionString: '', appStoreState: 'READY_FOR_SALE' } },
        { type: 'appStoreVersions', id: 'v1', attributes: { appStoreState: 'READY_FOR_SALE' } },
        {
          type: 'appStoreVersions',
          id: 'v2',
          attributes: { versionString: '3.0.0', appStoreState: 'READY_FOR_SALE' },
          relationships: { build: { data: { type: 'builds', id: 'b9' } } },
        },
      ],
      included: [{ type: 'builds', id: 'b9', attributes: { version: '7' } }],
    });
    expect(out).toEqual([{ versionString: '3.0.0', buildNumber: 7 }]);
  });
});
