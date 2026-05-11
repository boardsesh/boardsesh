import React from 'react';
import { ImageResponse } from '@vercel/og';
import type { NextRequest } from 'next/server';
import { themeTokens } from '@/app/theme/theme-config';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { createOgImageHeaders, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';
import { getPlaylistOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { trackServer } from '@/app/lib/analytics.server';

export const runtime = 'nodejs';

const PLAYLIST_NAME_MAX_LENGTH = 34;
const PLAYLIST_DESCRIPTION_MAX_LENGTH = 120;

function truncateOgText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function getPlaylistFallbackMark(icon: string | null, name: string, boardLabel: string): string {
  const normalizedIcon = icon?.trim() || '';
  const safeIcon = normalizedIcon.replace(/[^A-Za-z0-9!?#+&]/g, '').toUpperCase();
  if (safeIcon) {
    return safeIcon.slice(0, 2);
  }

  const fallbackSource = `${name} ${boardLabel}`.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return fallbackSource.slice(0, 2) || 'PL';
}

export async function GET(request: NextRequest) {
  const routeT0 = performance.now();

  try {
    const { searchParams } = new URL(request.url);
    const uuid = searchParams.get('uuid');
    const version = searchParams.get('v');

    if (!uuid) {
      return new Response('Missing uuid parameter', { status: 400 });
    }

    const dbT0 = performance.now();
    const playlist = await getPlaylistOgSummary(uuid);
    const dbMs = performance.now() - dbT0;

    if (!playlist) {
      return new Response('Playlist not found', { status: 404 });
    }

    if (!playlist.isPublic) {
      return new Response('Playlist is private', { status: 404 });
    }

    trackServer('OG Image Requested', {
      distinctId: 'og-bot',
      properties: {
        kind: 'playlist',
        playlistUuid: uuid,
        boardName: playlist.boardType,
        userAgent: request.headers.get('user-agent') ?? null,
      },
    });

    const name = playlist.name || 'Playlist';
    const description = playlist.description?.trim() || null;
    const color = playlist.color?.trim() || themeTokens.colors.primary;
    const icon = playlist.icon?.trim() || null;
    const boardType = playlist.boardType;
    const climbCount = playlist.climbCount;
    const boardLabel = formatBoardDisplayName(boardType);
    const displayName = truncateOgText(name, PLAYLIST_NAME_MAX_LENGTH);
    const displayDescription = description ? truncateOgText(description, PLAYLIST_DESCRIPTION_MAX_LENGTH) : null;
    const displayMark = getPlaylistFallbackMark(icon, name, boardLabel);

    return new ImageResponse(
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          background: '#FFFFFF',
          padding: '60px 80px',
          gap: '48px',
        }}
      >
        {/* Left: Colored square with icon */}
        <div
          style={{
            width: '280px',
            height: '280px',
            borderRadius: '32px',
            backgroundColor: color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: '120px',
              lineHeight: 1,
              color: '#FFFFFF',
            }}
          >
            {displayMark}
          </div>
        </div>

        {/* Right: Info */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            flex: 1,
            minWidth: 0,
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

          {displayDescription && (
            <div
              style={{
                fontSize: '24px',
                color: themeTokens.neutral[500],
                lineHeight: 1.4,
              }}
            >
              {displayDescription}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: '24px',
              marginTop: '8px',
            }}
          >
            <div
              style={{
                fontSize: '28px',
                color: themeTokens.neutral[600],
                fontWeight: 600,
              }}
            >
              {`${climbCount} ${climbCount === 1 ? 'climb' : 'climbs'}`}
            </div>
            <div
              style={{
                fontSize: '28px',
                color: themeTokens.neutral[400],
              }}
            >
              {boardLabel}
            </div>
          </div>
        </div>

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
          serverTiming: `db;dur=${dbMs.toFixed(1)}, render;dur=${(performance.now() - routeT0 - dbMs).toFixed(1)}, route;dur=${(performance.now() - routeT0).toFixed(1)}`,
        }),
      },
    );
  } catch (error) {
    console.error('Error generating playlist OG image:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Error generating image: ${message}`, { status: 500 });
  }
}
