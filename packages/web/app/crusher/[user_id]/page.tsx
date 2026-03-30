import React from 'react';
import { Metadata } from 'next';
import ProfilePageContent from './profile-page-content';
import { getDb } from '@/app/lib/db/db';
import * as dbSchema from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_PROFILE_STATS,
  type GetUserProfileStatsQueryVariables,
  type GetUserProfileStatsQueryResponse,
} from '@/app/lib/graphql/operations';

// Layout name + color mappings for OG image
const layoutNames: Record<string, string> = {
  'kilter-1': 'Kilter Original',
  'kilter-8': 'Kilter Homewall',
  'tension-9': 'Tension Classic',
  'tension-10': 'Tension 2 Mirror',
  'tension-11': 'Tension 2 Spray',
  'moonboard-1': 'MoonBoard 2010',
  'moonboard-2': 'MoonBoard 2016',
  'moonboard-3': 'MoonBoard 2024',
  'moonboard-4': 'MoonBoard Masters 2017',
  'moonboard-5': 'MoonBoard Masters 2019',
};

const layoutColors: Record<string, string> = {
  'kilter-1': 'rgba(6, 182, 212, 0.85)',
  'kilter-8': 'rgba(57, 255, 20, 0.85)',
  'tension-9': 'rgba(239, 68, 68, 0.85)',
  'tension-10': 'rgba(249, 115, 22, 0.85)',
  'tension-11': 'rgba(234, 179, 8, 0.85)',
  'moonboard-1': 'rgba(255, 215, 0, 0.85)',
  'moonboard-2': 'rgba(255, 165, 0, 0.85)',
  'moonboard-3': 'rgba(255, 140, 0, 0.85)',
  'moonboard-4': 'rgba(255, 193, 7, 0.85)',
  'moonboard-5': 'rgba(255, 152, 0, 0.85)',
};

type PageProps = {
  params: Promise<{ user_id: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { user_id } = await params;

  try {
    const db = getDb();

    // Fetch user + profile
    const [users, profiles] = await Promise.all([
      db.select().from(dbSchema.users).where(eq(dbSchema.users.id, user_id)).limit(1),
      db.select().from(dbSchema.userProfiles).where(eq(dbSchema.userProfiles.userId, user_id)).limit(1),
    ]);

    if (users.length === 0) {
      return {
        title: 'Profile | Boardsesh',
        description: 'View climbing profile and stats',
      };
    }

    const user = users[0];
    const profile = profiles[0] ?? null;
    const displayName = profile?.displayName || user.name || 'Crusher';

    // Fetch profile stats for OG image
    let totalClimbs = 0;
    let layouts: Array<{ name: string; pct: number; color: string }> = [];

    try {
      const client = createGraphQLHttpClient(null);
      const variables: GetUserProfileStatsQueryVariables = { userId: user_id };
      const response = await client.request<GetUserProfileStatsQueryResponse>(
        GET_USER_PROFILE_STATS,
        variables,
      );

      if (response.userProfileStats) {
        totalClimbs = response.userProfileStats.totalDistinctClimbs;
        layouts = response.userProfileStats.layoutStats
          .filter((s) => s.distinctClimbCount > 0)
          .sort((a, b) => b.distinctClimbCount - a.distinctClimbCount)
          .map((s) => ({
            name: layoutNames[s.layoutKey] || s.layoutKey,
            pct: totalClimbs > 0 ? Math.round((s.distinctClimbCount / totalClimbs) * 100) : 0,
            color: layoutColors[s.layoutKey] || 'rgba(150,150,150,0.7)',
          }));
      }
    } catch {
      // Stats fetch failed — still generate metadata without stats
    }

    const description = totalClimbs > 0
      ? `${displayName} has logged ${totalClimbs} distinct climbs on Boardsesh`
      : `${displayName}'s climbing profile on Boardsesh`;

    const baseUrl = process.env.VERCEL_URL
      ? 'https://www.boardsesh.com'
      : 'http://localhost:3000';

    const ogImageUrl = new URL('/api/og/profile', baseUrl);
    ogImageUrl.searchParams.set('name', displayName);
    const avatarUrl = profile?.avatarUrl || user.image;
    if (avatarUrl) {
      ogImageUrl.searchParams.set('avatar', avatarUrl);
    }
    if (totalClimbs > 0) {
      ogImageUrl.searchParams.set('totalClimbs', String(totalClimbs));
    }
    if (layouts.length > 0) {
      ogImageUrl.searchParams.set('layouts', JSON.stringify(layouts));
    }

    return {
      title: `${displayName} | Boardsesh`,
      description,
      openGraph: {
        title: `${displayName} | Boardsesh`,
        description,
        type: 'profile',
        images: [
          {
            url: ogImageUrl.toString(),
            width: 1200,
            height: 630,
            alt: `${displayName}'s climbing profile`,
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title: `${displayName} | Boardsesh`,
        description,
        images: [ogImageUrl.toString()],
      },
    };
  } catch {
    return {
      title: 'Profile | Boardsesh',
      description: 'View climbing profile and stats',
    };
  }
}

export default async function ProfilePage({ params }: PageProps) {
  const { user_id } = await params;
  return <ProfilePageContent userId={user_id} />;
}
