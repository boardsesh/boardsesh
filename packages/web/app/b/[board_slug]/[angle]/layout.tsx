import React, { type PropsWithChildren } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveBoardBySlug, boardToRouteParams } from '@/app/lib/board-slug-utils';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import BoardSeshHeader from '@/app/components/board-page/header';
import { GraphQLQueueProvider } from '@/app/components/graphql-queue';
import { ConnectionSettingsProvider } from '@/app/components/connection-manager/connection-settings-context';
import { WebSocketConnectionProvider } from '@/app/components/connection-manager/websocket-connection-provider';
import { PartyProvider } from '@/app/components/party-manager/party-context';
import { BoardSessionBridge } from '@/app/components/persistent-session';
import { UISearchParamsProvider } from '@/app/components/queue-control/ui-searchparams-provider';
import { BoardProvider } from '@/app/components/board-provider/board-provider-context';
import { QueueBridgeInjector } from '@/app/components/queue-control/queue-bridge-context';
import LastUsedBoardTracker from '@/app/components/board-page/last-used-board-tracker';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getLocale } from '@/app/lib/i18n/get-locale';

import { constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';

type BoardSlugRouteParams = {
  board_slug: string;
  angle: string;
};

export async function generateMetadata(props: { params: Promise<BoardSlugRouteParams> }): Promise<Metadata> {
  const params = await props.params;

  try {
    const board = await resolveBoardBySlug(params.board_slug);
    if (!board) {
      return { title: 'Board Not Found | Boardsesh' };
    }

    return {
      title: `${board.name} | Boardsesh`,
    };
  } catch {
    return { title: 'Boardsesh' };
  }
}

export default async function BoardSlugLayout(props: PropsWithChildren<{ params: Promise<BoardSlugRouteParams> }>) {
  const params = await props.params;
  const { children } = props;

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  const angle = Number(params.angle);
  const parsedParams = boardToRouteParams(board, angle);

  const boardDetails = getBoardDetailsForBoard(parsedParams);

  const listUrl = constructBoardSlugListUrl(board.slug, angle);
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
          boardSlug={board.slug}
        />
        <BoardProvider boardName={parsedParams.board_name} boardUuid={board.uuid}>
          <BoardSessionBridge boardDetails={boardDetails} parsedParams={parsedParams}>
            <ConnectionSettingsProvider>
              <WebSocketConnectionProvider>
                <GraphQLQueueProvider parsedParams={parsedParams} boardDetails={boardDetails}>
                  <PartyProvider>
                    <UISearchParamsProvider>
                      <QueueBridgeInjector boardDetails={boardDetails} angle={angle} boardUuid={board.uuid} />

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
                        <BoardSeshHeader
                          boardDetails={boardDetails}
                          angle={angle}
                          isAngleAdjustable={board.isAngleAdjustable}
                        />
                        {children}
                      </main>
                    </UISearchParamsProvider>
                  </PartyProvider>
                </GraphQLQueueProvider>
              </WebSocketConnectionProvider>
            </ConnectionSettingsProvider>
          </BoardSessionBridge>
        </BoardProvider>
      </div>
    </I18nProvider>
  );
}
