import React from 'react';
import { ImageResponse } from '@vercel/og';
import type { NextRequest } from 'next/server';
import { darkTokens, themeTokens } from '@/app/theme/theme-config';
import { FONT_GRADE_COLORS, getGradeColorWithOpacity } from '@/app/lib/grade-colors';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import { createOgImageHeaders, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';
import { getSessionOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { trackServer } from '@/app/lib/analytics.server';
import { OG_BOT_DISTINCT_ID } from '@boardsesh/shared-schema';

export const runtime = 'nodejs';

const DIFFICULTY_TO_GRADE: Record<number, string> = Object.fromEntries(
  BOULDER_GRADES.map((g) => [g.difficulty_id, g.font_grade]),
);

const GRADE_ORDER: string[] = BOULDER_GRADES.map((g) => g.font_grade);

function buildGradeBars(gradeRows: Array<{ difficulty: number; count: number }>) {
  const gradeBars: Array<{ grade: string; count: number; color: string }> = [];

  for (const row of gradeRows) {
    const grade = DIFFICULTY_TO_GRADE[row.difficulty];
    if (!grade) continue;

    const hex = FONT_GRADE_COLORS[grade.toLowerCase()];
    const color = hex ? getGradeColorWithOpacity(hex, 0.72) : 'rgba(209, 213, 219, 0.65)';
    gradeBars.push({ grade, count: row.count, color });
  }

  gradeBars.sort((a, b) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade));
  return gradeBars;
}

function buildJoinHeadline(leaderName: string | null) {
  return leaderName ? `Join ${leaderName} on the wall` : 'Join the crew on the wall';
}

export async function GET(request: NextRequest) {
  const routeT0 = performance.now();

  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const variant = searchParams.get('variant');
    const version = searchParams.get('v');

    if (!sessionId) {
      return new Response('Missing sessionId parameter', { status: 400 });
    }

    const dbT0 = performance.now();
    const summary = await getSessionOgSummary(sessionId);
    const dbMs = performance.now() - dbT0;

    if (!summary.found) {
      return new Response('Session not found', { status: 404 });
    }

    trackServer('OG Image Requested', {
      distinctId: OG_BOT_DISTINCT_ID,
      properties: {
        kind: 'session',
        sessionId,
        variant: variant ?? null,
        userAgent: request.headers.get('user-agent') ?? null,
      },
    });

    const sessionName = summary.sessionName;
    const participantNames = summary.participantNames.join(', ');
    const gradeBars = buildGradeBars(summary.gradeRows);
    const maxCount = Math.max(...gradeBars.map((b) => b.count), 1);
    const isJoinVariant = variant === 'join';
    const renderMs = performance.now() - routeT0 - dbMs;
    const joinHeadline = buildJoinHeadline(summary.leaderName);
    const boardInfoLine = summary.boardLabel
      ? `${summary.boardLabel}${summary.boardAngle != null ? ` • ${summary.boardAngle}°` : ''}`
      : 'Boardsesh session';
    const statsLine =
      summary.participantCount > 0
        ? `${summary.participantCount} climber${summary.participantCount !== 1 ? 's' : ''} • ${summary.totalSends} send${summary.totalSends !== 1 ? 's' : ''} so far`
        : 'No one is here yet';
    const previewUrl = summary.boardPreviewPath
      ? new URL(summary.boardPreviewPath, request.nextUrl.origin).toString()
      : null;

    const image = isJoinVariant ? (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          overflow: 'hidden',
          background: darkTokens.semantic.background,
          color: darkTokens.neutral[900],
          padding: '42px',
          gap: '34px',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '-110px',
              left: '-70px',
              width: '310px',
              height: '310px',
              borderRadius: '999px',
              background: themeTokens.colors.accentGreen,
              opacity: 0.18,
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: '-100px',
              bottom: '-120px',
              width: '360px',
              height: '360px',
              borderRadius: '999px',
              background: themeTokens.colors.accentRose,
              opacity: 0.18,
            }}
          />
        </div>

        <div
          style={{
            width: '366px',
            height: '546px',
            borderRadius: '28px',
            background: darkTokens.semantic.surfaceElevated,
            border: `1px solid ${darkTokens.neutral[300]}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
            boxShadow: darkTokens.shadows.lg,
            flexShrink: 0,
          }}
        >
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt=""
              width={366}
              height={546}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '32px',
                color: darkTokens.neutral[600],
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '22px', fontWeight: 700 }}>{summary.boardLabel || 'Board ready'}</div>
              <div style={{ fontSize: '18px' }}>
                {summary.boardAngle != null ? `${summary.boardAngle}°` : 'Session invite'}
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            flex: 1,
            minWidth: 0,
            gap: '22px',
            position: 'relative',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div
              style={{
                fontSize: '20px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: darkTokens.neutral[500],
              }}
            >
              {boardInfoLine}
            </div>
            <div
              style={{
                fontSize: '62px',
                fontWeight: 700,
                lineHeight: 1.04,
                color: darkTokens.neutral[900],
              }}
            >
              {joinHeadline}
            </div>
            <div
              style={{
                fontSize: '27px',
                color: darkTokens.neutral[700],
                lineHeight: 1.35,
              }}
            >
              {sessionName && sessionName !== 'Climbing Session' ? sessionName : statsLine}
            </div>
            {sessionName && sessionName !== 'Climbing Session' && (
              <div
                style={{
                  fontSize: '22px',
                  color: darkTokens.neutral[600],
                }}
              >
                {statsLine}
              </div>
            )}
            {participantNames && (
              <div
                style={{
                  fontSize: '19px',
                  color: darkTokens.neutral[500],
                }}
              >
                {participantNames}
              </div>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              borderRadius: '24px',
              padding: '24px 26px',
              background: darkTokens.semantic.surface,
              border: `1px solid ${darkTokens.neutral[300]}`,
              boxShadow: darkTokens.shadows.md,
            }}
          >
            <div
              style={{
                fontSize: '22px',
                fontWeight: 700,
                color: darkTokens.neutral[900],
              }}
            >
              {/* i18n-ignore-next-line -- OG image, English-only */}
              Grades climbed so far
            </div>

            {gradeBars.length > 0 ? (
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  width: '100%',
                  height: '190px',
                }}
              >
                {gradeBars.map((bar) => (
                  <div
                    key={bar.grade}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      flex: 1,
                      height: '100%',
                      justifyContent: 'flex-end',
                      alignItems: 'stretch',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-end',
                        width: '100%',
                        height: '156px',
                        borderBottom: `1px solid ${darkTokens.neutral[300]}`,
                        paddingBottom: '10px',
                      }}
                    >
                      <div
                        style={{
                          width: '100%',
                          height: `${Math.max((bar.count / maxCount) * 100, 7)}%`,
                          backgroundColor: bar.color,
                          borderRadius: '10px 10px 0 0',
                        }}
                      />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        width: '100%',
                        paddingTop: '10px',
                        fontSize: '17px',
                        fontWeight: 700,
                        textAlign: 'center',
                        color: darkTokens.neutral[700],
                      }}
                    >
                      {bar.grade}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  fontSize: '20px',
                  color: darkTokens.neutral[600],
                }}
              >
                {/* i18n-ignore-next-line -- OG image, English-only */}
                No sends yet.
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: '24px',
            right: '34px',
            fontSize: '18px',
            color: darkTokens.neutral[500],
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          {/* i18n-ignore-next-line -- OG image, brand-only text */}
          boardsesh.com
        </div>
      </div>
    ) : (
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
          gap: '32px',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            width: '100%',
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
            {sessionName}
          </div>
          {participantNames && (
            <div
              style={{
                fontSize: '24px',
                color: themeTokens.neutral[500],
              }}
            >
              {participantNames}
            </div>
          )}
          <div
            style={{
              fontSize: '20px',
              color: themeTokens.neutral[400],
            }}
          >
            {summary.totalSends > 0
              ? `${summary.totalSends} send${summary.totalSends !== 1 ? 's' : ''}`
              : 'No sends yet'}
          </div>
        </div>

        {gradeBars.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: '4px',
                height: '180px',
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
      </div>
    );

    return new ImageResponse(image, {
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      headers: createOgImageHeaders({
        contentType: 'image/png',
        version,
        serverTiming: `db;dur=${dbMs.toFixed(1)}, render;dur=${renderMs.toFixed(1)}, route;dur=${(performance.now() - routeT0).toFixed(1)}`,
      }),
    });
  } catch (error) {
    console.error('Error generating session OG image:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Error generating image: ${message}`, { status: 500 });
  }
}
