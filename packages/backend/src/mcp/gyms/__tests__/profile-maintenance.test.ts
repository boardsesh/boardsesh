import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import { db, runWithDatabaseTransaction } from '../../../db/client';
import { findGymMcpTool } from '../registry';
import { getGymImageSource, recordGymImageSource } from '../media-source';

describe('gym MCP partial profile maintenance', () => {
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
});
