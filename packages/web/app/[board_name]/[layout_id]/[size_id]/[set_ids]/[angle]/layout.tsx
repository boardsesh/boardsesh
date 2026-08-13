import React, { type PropsWithChildren } from 'react';
import { headers } from 'next/headers';
import type { BoardRouteParameters } from '@/app/lib/types';
import {
  constructClimbListWithSlugs,
  layoutOwnsNumericSlugRedirect,
  tryConstructSlugListUrl,
} from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import { PATHNAME_HEADER } from '@/app/lib/request-pathname-header';
import { permanentRedirect } from 'next/navigation';
import { getBoardDetailsForBoard, generateBoardTitle } from '@/app/lib/board-utils';
import BoardSeshHeader from '@/app/components/board-page/header';
import { GraphQLQueueProvider } from '@/app/components/graphql-queue';
import { ConnectionSettingsProvider } from '@/app/components/connection-manager/connection-settings-context';
import { WebSocketConnectionProvider } from '@/app/components/connection-manager/websocket-connection-provider';
import { BoardSessionBridge } from '@/app/components/persistent-session';
import type { Metadata } from 'next';
import { UISearchParamsProvider } from '@/app/components/queue-control/ui-searchparams-provider';
import { QueueBridgeInjector } from '@/app/components/queue-control/queue-bridge-context';
import LastUsedBoardTracker from '@/app/components/board-page/last-used-board-tracker';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { themeTokens } from '@/app/theme/theme-config';

export async function generateMetadata(props: { params: Promise<BoardRouteParameters> }): Promise<Metadata> {
  const params = await props.params;

  try {
    const { parsedParams } = await parseRouteParams(params);
    const boardDetails = getBoardDetailsForBoard(parsedParams);
    const title = generateBoardTitle(boardDetails);

    return {
      title,
    };
  } catch {
    // Fallback title if metadata generation fails
    const boardName = params.board_name.charAt(0).toUpperCase() + params.board_name.slice(1);
    return {
      title: `${boardName} | Boardsesh`,
    };
  }
}

type BoardLayoutProps = {
  params: Promise<BoardRouteParameters>;
};

export default async function BoardLayout(props: PropsWithChildren<BoardLayoutProps>) {
  const params = await props.params;

  const { children } = props;

  const { parsedParams, isNumericFormat } = await parseRouteParams(params);

  // Redirect old numeric URLs to new slug format — but not for the /view and
  // /play child routes, whose own pages redirect while preserving the climb
  // uuid. Redirecting those to the bare list here would drop the climb.
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  if (isNumericFormat && layoutOwnsNumericSlugRedirect(pathname)) {
    const boardDetails = getBoardDetailsForBoard(parsedParams);

    if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
      // Id-aware first: the name-based builder only knows the bare size slug, so
      // a numeric URL for a size that shares one with another on the same layout
      // (Kilter layout 1 sizes 10/27) would 308 — and the browser caches that
      // permanently — onto the other board. Names remain the fallback for a
      // board the static tables don't carry.
      const newUrl =
        tryConstructSlugListUrl(
          parsedParams.board_name,
          parsedParams.layout_id,
          parsedParams.size_id,
          parsedParams.set_ids,
          parsedParams.angle,
        ) ??
        constructClimbListWithSlugs(
          boardDetails.board_name,
          boardDetails.layout_name,
          boardDetails.size_name,
          boardDetails.size_description,
          boardDetails.set_names,
          parsedParams.angle,
        );

      permanentRedirect(newUrl);
    }
  }

  const { angle } = parsedParams;

  // Fetch the board details server-side
  const boardDetails = getBoardDetailsForBoard(parsedParams);

  // Compute the list URL for last-used-board tracking. Persisted and navigated
  // to later, so it takes the id-aware builder for the same reason the redirect
  // above does — a bare size slug would send the climber back to a board that
  // isn't the one they were on.
  const listUrl =
    tryConstructSlugListUrl(
      parsedParams.board_name,
      parsedParams.layout_id,
      parsedParams.size_id,
      parsedParams.set_ids,
      angle,
    ) ??
    (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names
      ? constructClimbListWithSlugs(
          boardDetails.board_name,
          boardDetails.layout_name,
          boardDetails.size_name,
          boardDetails.size_description,
          boardDetails.set_names,
          angle,
        )
      : `/${boardDetails.board_name}`);

  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'climbs', 'session', 'boards', 'profile', 'feed']}>
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          background: 'var(--semantic-surface)',
        }}
      >
        <LastUsedBoardTracker
          url={listUrl}
          boardName={boardDetails.board_name}
          layoutName={boardDetails.layout_name || ''}
          sizeName={boardDetails.size_name || ''}
          sizeDescription={boardDetails.size_description}
          setNames={boardDetails.set_names || []}
          angle={angle}
        />
        <BoardSessionBridge boardDetails={boardDetails} parsedParams={parsedParams}>
          <ConnectionSettingsProvider>
            <WebSocketConnectionProvider>
              <GraphQLQueueProvider parsedParams={parsedParams} boardDetails={boardDetails}>
                <UISearchParamsProvider>
                  <QueueBridgeInjector boardDetails={boardDetails} angle={angle} />

                  <main
                    id="content-for-scrollable"
                    style={{
                      flex: 1,
                      paddingLeft: `${themeTokens.spacing[2]}px`,
                      paddingRight: `${themeTokens.spacing[2]}px`,
                      paddingTop: 'var(--global-header-height)',
                      paddingBottom: 'var(--bottom-bar-height)',
                    }}
                  >
                    <BoardSeshHeader boardDetails={boardDetails} angle={angle} />
                    {children}
                  </main>
                </UISearchParamsProvider>
              </GraphQLQueueProvider>
            </WebSocketConnectionProvider>
          </ConnectionSettingsProvider>
        </BoardSessionBridge>
      </div>
    </I18nProvider>
  );
}
