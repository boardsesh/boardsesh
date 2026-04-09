import React, { Suspense } from 'react';
import { PropsWithChildren } from 'react';
import { BoardRouteParameters } from '@/app/lib/types';
import { constructClimbListWithSlugs } from '@/app/lib/url-utils';
import { parseRouteParams } from '@/app/lib/url-utils.server';
import { notFound, permanentRedirect } from 'next/navigation';
import { getBoardDetailsForBoard, generateBoardTitle } from '@/app/lib/board-utils';
import BoardSeshHeader from '@/app/components/board-page/header';
import { GraphQLQueueProvider } from '@/app/components/graphql-queue';
import { ConnectionSettingsProvider } from '@/app/components/connection-manager/connection-settings-context';
import { WebSocketConnectionProvider } from '@/app/components/connection-manager/websocket-connection-provider';
import { PartyProvider } from '@/app/components/party-manager/party-context';
import { BoardSessionBridge } from '@/app/components/persistent-session';
import { Metadata } from 'next';
import BoardPageSkeleton from '@/app/components/board-page/board-page-skeleton';
import { BluetoothProvider } from '@/app/components/board-bluetooth-control/bluetooth-context';
import { UISearchParamsProvider } from '@/app/components/queue-control/ui-searchparams-provider';
import { QueueBridgeInjector } from '@/app/components/queue-control/queue-bridge-context';
import LastUsedBoardTracker from '@/app/components/board-page/last-used-board-tracker';
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

interface BoardLayoutProps {
  params: Promise<BoardRouteParameters>;
}

export default async function BoardLayout(props: PropsWithChildren<BoardLayoutProps>) {
  const params = await props.params;

  const { children } = props;

  const { parsedParams, isNumericFormat } = await parseRouteParams(params);
  const resolveBoardDetailsOr404 = () => {
    try {
      return getBoardDetailsForBoard(parsedParams);
    } catch (error) {
      console.error('Error resolving board details in board layout:', error);
      return notFound();
    }
  };

  // Redirect old numeric URLs to new slug format
  if (isNumericFormat) {
    const boardDetails = resolveBoardDetailsOr404();

    if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
      const newUrl = constructClimbListWithSlugs(
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
  const boardDetails = resolveBoardDetailsOr404();

  // Compute the list URL for last-used-board tracking
  const listUrl = boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names
    ? constructClimbListWithSlugs(
        boardDetails.board_name,
        boardDetails.layout_name,
        boardDetails.size_name,
        boardDetails.size_description,
        boardDetails.set_names,
        angle,
      )
    : `/${boardDetails.board_name}`;

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', padding: 0, background: 'var(--semantic-surface)' }}>
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
              <PartyProvider>
                <BluetoothProvider boardDetails={boardDetails}>
                  <UISearchParamsProvider>
                    <QueueBridgeInjector boardDetails={boardDetails} angle={angle} />

                    <main
                      id="content-for-scrollable"
                      style={{
                        flex: 1,
                        paddingLeft: `${themeTokens.spacing[2]}px`,
                        paddingRight: `${themeTokens.spacing[2]}px`,
                        paddingTop: 'var(--global-header-height)',
                        paddingBottom: 'calc(120px + env(safe-area-inset-bottom, 0px))',
                      }}
                    >
                      <BoardSeshHeader boardDetails={boardDetails} angle={angle} />
                      <Suspense fallback={<BoardPageSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} />}>
                        {children}
                      </Suspense>
                    </main>
                  </UISearchParamsProvider>
                </BluetoothProvider>
              </PartyProvider>
            </GraphQLQueueProvider>
          </WebSocketConnectionProvider>
        </ConnectionSettingsProvider>
      </BoardSessionBridge>
    </div>
  );
}
