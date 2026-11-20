import { describe, expect, it } from 'vitest';
import {
  railwayStateForHosting,
  CLICKHOUSE_SERVICE_NAME,
  OTA_SERVICE_NAME,
  OTA_POSTGRES_SERVICE_NAME,
  POSTGRES_PRIMARY_SERVICE_NAME,
} from '../infra/railway/config';
import { OTA_IMAGE, OTA_SERVER_VERSION } from '../infra/ota/server';
import { OTA_BACKUP_LIFECYCLE_RULE, desiredR2Buckets, otaDnsRecords } from '../infra/cloudflare/config';
import { EOAS_PACKAGE_SPEC } from './lib/eoas';

describe('OTA hosting ownership', () => {
  it('pins an immutable release and keeps CLI parity', () => {
    expect(OTA_IMAGE).toMatch(/^ghcr\.io\/mercuretechnologies\/expo-open-ota@sha256:[0-9a-f]{64}$/);
    expect(EOAS_PACKAGE_SPEC).toBe(`eoas@${OTA_SERVER_VERSION}`);
  });

  it('leaves all OTA resources unmanaged after homelab takes ownership', () => {
    const railway = railwayStateForHosting('railway');
    const homelab = railwayStateForHosting('homelab');
    const otaNames = [OTA_SERVICE_NAME, CLICKHOUSE_SERVICE_NAME, OTA_POSTGRES_SERVICE_NAME];
    expect(railway.services.filter((service) => otaNames.includes(service.name))).toHaveLength(3);
    expect(homelab.services.filter((service) => otaNames.includes(service.name))).toEqual([]);
    expect(homelab.services).toEqual(railway.services.filter((service) => !otaNames.includes(service.name)));
    expect(homelab.services.some((service) => service.name === POSTGRES_PRIMARY_SERVICE_NAME)).toBe(true);
    expect(homelab.services.some((service) => service.name === 'Redis')).toBe(true);
    expect(homelab.clickhouseRetention).toEqual([]);
  });

  it('leaves DNS untouched in preparation and requires a real tunnel for cutover', () => {
    expect(otaDnsRecords('railway')).toEqual([]);
    expect(() => otaDnsRecords('homelab', null)).toThrow('tunnel UUID');
    expect(() => otaDnsRecords('homelab', 'placeholder')).toThrow('tunnel UUID');
    expect(otaDnsRecords('homelab', '11111111-2222-3333-4444-555555555555')).toEqual([
      {
        management: 'full',
        name: 'updates.boardsesh.com',
        type: 'CNAME',
        content: '11111111-2222-3333-4444-555555555555.cfargotunnel.com',
        ttl: 1,
        proxied: true,
      },
    ]);
  });

  it('keeps database backups private and only expires scheduled backups', () => {
    const bucket = desiredR2Buckets.find((entry) => entry.name === 'boardsesh-ota-backups')!;
    expect(bucket.customDomain).toBeNull();
    expect(bucket.r2DevDomainEnabled).toBe(false);
    expect(bucket.cors).toBeUndefined();
    expect(bucket.lifecycleRule).toEqual(OTA_BACKUP_LIFECYCLE_RULE);
    expect(OTA_BACKUP_LIFECYCLE_RULE.conditions.prefix).toBe('scheduled/');
    expect(OTA_BACKUP_LIFECYCLE_RULE.deleteObjectsTransition?.condition?.maxAge).toBe(14 * 86400);
  });
});
