import React from 'react';
import { Metadata } from 'next';
import { sql } from '@/app/lib/db/db';
import ProfilePageContent from './profile-page-content';

type PageProps = {
  params: Promise<{ user_id: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { user_id } = await params;

  try {
    const rows = await sql`
      SELECT u.name, p.display_name, p.avatar_url, p.is_private
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = ${user_id}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return {
        title: 'Profile | Boardsesh',
        description: 'View climbing profile and stats',
      };
    }

    const row = rows[0];

    if (row.is_private) {
      return {
        title: 'Private profile | Boardsesh',
        robots: { index: false, follow: false },
      };
    }

    const displayName = (row.display_name as string) || (row.name as string) || 'Crusher';
    const description = `${displayName}'s climbing profile on Boardsesh`;

    const ogImageUrl = new URL('/api/og/profile', 'https://boardsesh.com');
    ogImageUrl.searchParams.set('user_id', user_id);

    return {
      title: `${displayName} | Boardsesh`,
      description,
      openGraph: {
        title: `${displayName} | Boardsesh`,
        description,
        type: 'profile',
        url: `/crusher/${user_id}`,
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
