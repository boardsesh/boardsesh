import React from 'react';
import { ImageResponse } from '@vercel/og';
import type { NextRequest } from 'next/server';
import { dbz, executeRows } from '@/app/lib/db/db';
import { sql } from 'drizzle-orm';
import { themeTokens } from '@/app/theme/theme-config';
import { FONT_GRADE_COLORS, getGradeColorWithOpacity } from '@/app/lib/grade-colors';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import { createOgImageHeaders, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';
import { getSetterOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { trackServer } from '@/app/lib/analytics.server';

export const runtime = 'nodejs';

// Maps difficulty ID to Font grade name for OG image labels.
// OG images are static server-rendered PNGs — they always use Font grades
// since we can't access the user's display preference here.
const DIFFICULTY_TO_GRADE: Record<number, string> = Object.fromEntries(
  BOULDER_GRADES.map((g) => [g.difficulty_id, g.font_grade]),
);

const GRADE_ORDER: string[] = BOULDER_GRADES.map((g) => g.font_grade);

export async function GET(request: NextRequest) {
  const routeT0 = performance.now();

  try {
    const { searchParams } = new URL(request.url);
    const username = searchParams.get('username');
    const version = searchParams.get('v');

    if (!username) {
      return new Response('Missing username parameter', { status: 400 });
    }

    const dbT0 = performance.now();
    const [summary, gradeResult] = await Promise.all([
      getSetterOgSummary(username),
      executeRows<{
        difficulty: number;
        cnt: number;
      }>(
        dbz,
        sql`
        SELECT bt.difficulty, COUNT(*) as cnt
        FROM boardsesh_ticks bt
        JOIN board_climbs bc ON bc.uuid = bt.climb_uuid
        WHERE bc.setter_username = ${username}
          AND bt.status IN ('flash', 'send')
          AND bt.difficulty IS NOT NULL
        GROUP BY bt.difficulty
        ORDER BY bt.difficulty
      `,
      ),
    ]);
    const dbMs = performance.now() - dbT0;
    const gradeRows = gradeResult;

    trackServer('OG Image Requested', {
      distinctId: 'og-bot',
      properties: {
        kind: 'setter',
        username,
        userAgent: request.headers.get('user-agent') ?? null,
      },
    });

    const displayName = summary.displayName;
    const origin = process.env.VERCEL_URL ? 'https://www.boardsesh.com' : 'http://localhost:3000';
    const rawAvatarUrl = summary.avatarUrl || null;
    const avatarUrl = rawAvatarUrl && !rawAvatarUrl.startsWith('http') ? `${origin}${rawAvatarUrl}` : rawAvatarUrl;

    // Build grade bars from ascents of climbs this setter created
    const gradeBars: Array<{ grade: string; count: number; color: string }> = [];
    let totalAscents = 0;

    for (const row of gradeRows) {
      const difficulty = Number(row.difficulty);
      const count = Number(row.cnt);
      const grade = DIFFICULTY_TO_GRADE[difficulty];
      if (!grade) continue;

      totalAscents += count;
      const hex = FONT_GRADE_COLORS[grade.toLowerCase()];
      const color = hex ? getGradeColorWithOpacity(hex, 0.5) : 'rgba(200, 200, 200, 0.5)';
      gradeBars.push({ grade, count, color });
    }

    // Sort by grade order
    gradeBars.sort((a, b) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade));

    const maxCount = Math.max(...gradeBars.map((b) => b.count), 1);
    const renderMs = performance.now() - routeT0 - dbMs;

    return new ImageResponse(
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          background: '#FFFFFF',
          padding: '60px 80px',
          gap: '40px',
        }}
      >
        {/* Top section: Avatar + Name */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '32px',
            width: '100%',
          }}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              width={120}
              height={120}
              style={{
                borderRadius: '60px',
                objectFit: 'cover',
              }}
            />
          ) : (
            <div
              style={{
                width: '120px',
                height: '120px',
                borderRadius: '60px',
                background: themeTokens.neutral[200],
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '48px',
                color: themeTokens.neutral[500],
              }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                fontSize: '48px',
                fontWeight: 'bold',
                color: themeTokens.neutral[900],
                lineHeight: 1.2,
              }}
            >
              {displayName}
            </div>
            <div
              style={{
                fontSize: '24px',
                color: themeTokens.neutral[500],
              }}
            >
              {totalAscents > 0
                ? `${totalAscents} ascent${totalAscents !== 1 ? 's' : ''} on created climbs`
                : 'Boardsesh setter'}
            </div>
          </div>
        </div>

        {/* Grade chart */}
        {gradeBars.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              gap: '8px',
            }}
          >
            {/* Bars */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: '4px',
                height: '160px',
                width: '100%',
              }}
            >
              {gradeBars.map((bar) => (
                <div
                  key={bar.grade}
                  style={{
                    flex: 1,
                    height: `${Math.max((bar.count / maxCount) * 100, 5)}%`,
                    backgroundColor: bar.color,
                    borderRadius: '3px 3px 0 0',
                  }}
                />
              ))}
            </div>
            {/* Labels */}
            <div
              style={{
                display: 'flex',
                gap: '4px',
                width: '100%',
              }}
            >
              {gradeBars.map((bar) => (
                <div
                  key={bar.grade}
                  style={{
                    flex: 1,
                    fontSize: '14px',
                    textAlign: 'center',
                    color: themeTokens.neutral[400],
                  }}
                >
                  {bar.grade}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Branding */}
        <div
          style={{
            position: 'absolute',
            bottom: '24px',
            right: '40px',
            fontSize: '20px',
            color: themeTokens.neutral[300],
            fontWeight: 600,
          }}
        >
          {/* i18n-ignore-next-line -- OG image, brand-only text */}
          boardsesh.com
        </div>
      </div>,
      {
        width: OG_IMAGE_WIDTH,
        height: OG_IMAGE_HEIGHT,
        headers: createOgImageHeaders({
          contentType: 'image/png',
          version,
          serverTiming: `db;dur=${dbMs.toFixed(1)}, render;dur=${renderMs.toFixed(1)}, route;dur=${(performance.now() - routeT0).toFixed(1)}`,
        }),
      },
    );
  } catch (error) {
    console.error('Error generating setter OG image:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Error generating image: ${message}`, { status: 500 });
  }
}
