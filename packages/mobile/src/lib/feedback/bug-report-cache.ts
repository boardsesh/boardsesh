import type { InfiniteData } from '@tanstack/react-query';
import type { AppBugReportMessage, AppBugReportMessageConnection } from '@boardsesh/shared-schema';

/** Preserve server cursors and older pages when a mutation returns one message. */
export function mergeBugReportMessage(
  previous: InfiniteData<AppBugReportMessageConnection> | undefined,
  message: AppBugReportMessage,
): InfiniteData<AppBugReportMessageConnection> | undefined {
  if (!previous?.pages.length) return previous;
  const existing = previous.pages.flatMap((page) => page.messages).find((cached) => cached.id === message.id);
  // The delivery event can beat the HTTP response from sending/retrying.
  if (existing?.deliveryStatus === 'sent' && message.deliveryStatus === 'pending') return previous;
  return {
    ...previous,
    pages: previous.pages.map((page, pageIndex) => ({
      ...page,
      messages: existing
        ? page.messages.map((cached) => (cached.id === message.id ? message : cached))
        : pageIndex === 0
          ? [message, ...page.messages]
          : page.messages,
    })),
  };
}
