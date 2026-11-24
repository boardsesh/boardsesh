import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import { db, runWithDatabaseTransaction } from '../../../db/client';
import { findGymMcpTool } from '../registry';
import { getGymImageSource, gymImageAttributionSchema, recordGymImageSource } from '../media-source';

beforeEach(async () => {
  await db
    .insert(tables.users)
    .values({
      id: 'test-source-owner',
      email: 'test-source-owner@example.test',
      name: 'Source editor',
    })
    .onConflictDoNothing();
});

describe('gym MCP partial profile maintenance', () => {
  it('clears a deleted editor identity while retaining the current image source credit', async () => {
    const gymUuid = randomUUID();
    const source = { imageUrl: 'https://gym.example/photo.jpg', attribution: { credit: 'Gym photographer' } };
    await recordGymImageSource({
      gymId: 8150,
      gymUuid,
      actorUserId: 'test-source-owner',
      kind: 'photo',
      previousUrl: null,
      storedUrl: '/static/gym-photos/credited.jpg',
      source,
    });
    await db.delete(tables.users).where(eq(tables.users.id, 'test-source-owner'));
    const [audit] = await db
      .select()
      .from(tables.gymDirectoryRepairAudit)
      .where(eq(tables.gymDirectoryRepairAudit.gymUuid, gymUuid));
    expect(audit.actorUserId).toBeNull();
    expect(await getGymImageSource(gymUuid, 'photo', '/static/gym-photos/credited.jpg')).toMatchObject({ source });
    await db.delete(tables.gymDirectoryRepairAudit).where(eq(tables.gymDirectoryRepairAudit.gymUuid, gymUuid));
  });
  it('saves requested fields and reads them back without changing ownership, membership or visibility', async () => {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    await db.insert(tables.users).values([
      { id: ownerId, email: `${ownerId}@example.test`, name: 'Owner' },
      { id: memberId, email: `${memberId}@example.test`, name: 'Member' },
    ]);
    const [gym] = await db
      .insert(tables.gyms)
      .values({
        uuid: randomUUID(),
        name: 'Original gym',
        slug: `profile-${randomUUID()}`,
        ownerId,
        description: 'Original description',
        address: 'Existing address',
        hours: 'Mon–Fri 9–22',
        website: 'https://gym.example',
        websiteVouchedByOwner: true,
        contactEmail: 'hello@gym.example',
        contactPhone: '+31 123456789',
        isPublic: false,
        isListed: false,
        imageUrl: '/existing-photo.jpg',
        logoUrl: '/existing-logo.png',
      })
      .returning();
    await db.insert(tables.gymMembers).values({ gymId: gym.id, userId: memberId, role: 'member' });
    const context = { connectionId: randomUUID(), transport: 'http' as const, userId: ownerId, isAuthenticated: true };
    await runWithDatabaseTransaction(() =>
      findGymMcpTool('update_gym_profile')!.run(
        {
          gymUuid: gym.uuid,
          idempotencyKey: randomUUID(),
          changes: { description: 'Fresh description' },
        },
        context,
      ),
    );
    const [saved] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, gym.id));
    expect(saved).toMatchObject({
      ownerId,
      name: gym.name,
      slug: gym.slug,
      description: 'Fresh description',
      address: gym.address,
      hours: gym.hours,
      hoursUpdatedAt: gym.hoursUpdatedAt,
      website: gym.website,
      websiteVouchedByOwner: true,
      contactEmail: gym.contactEmail,
      contactPhone: gym.contactPhone,
      isPublic: false,
      isListed: false,
      imageUrl: gym.imageUrl,
      logoUrl: gym.logoUrl,
    });
    expect(await db.select().from(tables.gymMembers).where(eq(tables.gymMembers.gymId, gym.id))).toMatchObject([
      { userId: memberId, role: 'member' },
    ]);
    expect(await findGymMcpTool('get_gym')!.run({ gymUuid: gym.uuid }, context)).toMatchObject({
      gym: { uuid: gym.uuid, description: 'Fresh description' },
    });
    await expect(
      runWithDatabaseTransaction(() =>
        findGymMcpTool('update_gym_profile')!.run(
          {
            gymUuid: gym.uuid,
            idempotencyKey: randomUUID(),
            changes: { description: 'Unauthorized' },
          },
          { ...context, userId: memberId },
        ),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('retains source credit independently of retry receipt expiry and only returns it for the current image', async () => {
    const gymUuid = randomUUID();
    const source = {
      imageUrl: 'https://gym.example/photo.jpg',
      attribution: { credit: 'Gym photographer', pageUrl: 'https://gym.example/about' },
    };
    await recordGymImageSource({
      gymId: 8150,
      gymUuid,
      actorUserId: 'test-source-owner',
      kind: 'photo',
      previousUrl: null,
      storedUrl: '/static/gym-photos/current.jpg',
      source,
    });
    expect(await getGymImageSource(gymUuid, 'photo', '/static/gym-photos/current.jpg')).toMatchObject({ source });
    expect(await getGymImageSource(gymUuid, 'logo', '/static/gym-photos/current.jpg')).toMatchObject({ source: null });
    expect(await getGymImageSource(gymUuid, 'photo', '/replacement-from-web.jpg')).toMatchObject({ source: null });
    expect(await getGymImageSource(gymUuid, 'photo', null)).toMatchObject({ source: null });
    await db.delete(tables.gymDirectoryRepairAudit).where(eq(tables.gymDirectoryRepairAudit.gymUuid, gymUuid));
  });

  it('keeps signed fetch and source-page credentials out of durable attribution and readback', async () => {
    const gymUuid = randomUUID();
    await recordGymImageSource({
      gymId: 8150,
      gymUuid,
      actorUserId: 'test-source-owner',
      kind: 'photo',
      previousUrl: 'https://legacy-user:legacy-password@legacy.example/logo.png?legacy-secret=token#legacy-secret',
      storedUrl: '/static/gym-photos/credited.jpg',
      source: {
        imageUrl: 'https://cdn.example/photo.jpg?X-Amz-Signature=secret-fetch-token#private-fragment',
        attribution: {
          credit: 'Gym photographer',
          pageUrl: 'https://private-user:private-password@gym.example/about?token=secret-page-token#secret-anchor',
        },
      },
    });
    const result = await getGymImageSource(gymUuid, 'photo', '/static/gym-photos/credited.jpg');
    expect(result.source).toEqual({
      imageUrl: 'https://cdn.example/photo.jpg',
      attribution: { credit: 'Gym photographer', pageUrl: 'https://gym.example/about' },
    });
    const [audit] = await db
      .select()
      .from(tables.gymDirectoryRepairAudit)
      .where(eq(tables.gymDirectoryRepairAudit.gymUuid, gymUuid));
    expect(JSON.stringify(audit)).not.toMatch(/secret-|private-|X-Amz-Signature|token=/);
    expect(audit.before).toEqual({ storedUrl: 'https://legacy.example/logo.png' });
    expect(JSON.stringify(audit)).not.toMatch(/legacy-user|legacy-password|legacy-secret/);
    expect(gymImageAttributionSchema.safeParse({ credit: 'Gym', pageUrl: 'invalid-url' }).success).toBe(false);
    expect(gymImageAttributionSchema.safeParse({ credit: 'Gym', pageUrl: 'file:///private/photo' }).success).toBe(
      false,
    );
    await db.delete(tables.gymDirectoryRepairAudit).where(eq(tables.gymDirectoryRepairAudit.gymUuid, gymUuid));
  });

  it('allows image removal when a historical URL is malformed', async () => {
    const gymUuid = randomUUID();
    await recordGymImageSource({
      gymId: 8150,
      gymUuid,
      actorUserId: 'test-source-owner',
      kind: 'logo',
      previousUrl: 'invalid legacy URL',
      storedUrl: null,
      source: null,
    });
    const [audit] = await db
      .select()
      .from(tables.gymDirectoryRepairAudit)
      .where(eq(tables.gymDirectoryRepairAudit.gymUuid, gymUuid));
    expect(audit.before).toEqual({ storedUrl: null });
    await db.delete(tables.gymDirectoryRepairAudit).where(eq(tables.gymDirectoryRepairAudit.gymUuid, gymUuid));
  });
});
