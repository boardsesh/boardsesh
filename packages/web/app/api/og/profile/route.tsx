import React from 'react';
import { ImageResponse } from '@vercel/og';
import { NextRequest } from 'next/server';
import { themeTokens } from '@/app/theme/theme-config';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const displayName = searchParams.get('name') || 'Crusher';
    const avatarUrl = searchParams.get('avatar') || null;
    const totalClimbs = parseInt(searchParams.get('totalClimbs') || '0', 10);
    const layoutsParam = searchParams.get('layouts');
    let layouts: Array<{ name: string; pct: number; color: string }> = [];
    if (layoutsParam && layoutsParam.length < 2000) {
      try {
        const parsed: unknown = JSON.parse(layoutsParam);
        if (Array.isArray(parsed)) {
          layouts = parsed.slice(0, 10).filter(
            (item): item is { name: string; pct: number; color: string } =>
              typeof item === 'object' && item !== null &&
              typeof item.name === 'string' && typeof item.pct === 'number' && typeof item.color === 'string',
          );
        }
      } catch {
        // Invalid JSON — render without layout bar
      }
    }

    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            background: '#ffffff',
            padding: '60px',
            gap: '40px',
          }}
        >
          {/* Top section: Avatar + Name */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '32px',
            }}
          >
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                width={120}
                height={120}
                style={{ borderRadius: '50%', objectFit: 'cover' }}
              />
            ) : (
              <div
                style={{
                  width: 120,
                  height: 120,
                  borderRadius: '50%',
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
              {totalClimbs > 0 && (
                <div
                  style={{
                    fontSize: '28px',
                    color: themeTokens.neutral[500],
                  }}
                >
                  {totalClimbs} distinct climb{totalClimbs !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          </div>

          {/* Board percentage bar */}
          {layouts.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                maxWidth: '900px',
                gap: '16px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  height: '40px',
                  borderRadius: '12px',
                  overflow: 'hidden',
                  background: themeTokens.neutral[100],
                  width: '100%',
                }}
              >
                {layouts.map((layout) => (
                  <div
                    key={layout.name}
                    style={{
                      width: `${layout.pct}%`,
                      background: layout.color,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {layout.pct >= 18 && (
                      <span
                        style={{
                          color: 'white',
                          fontSize: '16px',
                          fontWeight: 600,
                          textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                        }}
                      >
                        {layout.name} {layout.pct}%
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Legend */}
              <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                {layouts.map((layout) => (
                  <div
                    key={layout.name}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                  >
                    <div
                      style={{
                        width: '14px',
                        height: '14px',
                        borderRadius: '4px',
                        background: layout.color,
                      }}
                    />
                    <span style={{ fontSize: '18px', color: themeTokens.neutral[600] }}>
                      {layout.name} ({layout.pct}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Boardsesh branding */}
          <div
            style={{
              fontSize: '24px',
              color: themeTokens.neutral[400],
              position: 'absolute',
              bottom: '30px',
              right: '40px',
            }}
          >
            boardsesh.com
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
        },
      },
    );
  } catch (error) {
    console.error('Error generating profile OG image:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Error generating image: ${message}`, { status: 500 });
  }
}
