import type { QueryClient, QueryFilters } from '@tanstack/react-query';
import { bugReportQueryKeys } from './bug-report-query-keys';

/** One refresh per event burst, with a trailing pass for changes during a read. */
export function createBugReportRefresh(client: QueryClient, accountId: string) {
  const reportIds = new Set<string>();
  let refreshAccount = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let disposed = false;

  const refreshQuery = async (filters: QueryFilters) => {
    // A response already on its way may predate this event. Let it finish, then
    // read once more, rather than repeatedly cancelling/restarting the request.
    const pending = client
      .getQueryCache()
      .findAll(filters)
      .filter((query) => query.state.fetchStatus === 'fetching')
      .flatMap((query) => {
        const pendingRequest = query.promise;
        return pendingRequest ? [pendingRequest] : [];
      });
    await Promise.allSettled(pending);
    if (!disposed) await client.invalidateQueries(filters, { cancelRefetch: false });
  };

  const schedule = () => {
    if (disposed || refreshing || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 200);
  };

  const flush = async () => {
    refreshing = true;
    const filters: QueryFilters[] = refreshAccount
      ? [{ queryKey: bugReportQueryKeys.account(accountId) }]
      : [
          { queryKey: bugReportQueryKeys.list(accountId), exact: true },
          ...Array.from(reportIds).flatMap((reportId) => [
            { queryKey: bugReportQueryKeys.report(accountId, reportId), exact: true },
            { queryKey: bugReportQueryKeys.messages(accountId, reportId), exact: true },
          ]),
        ];
    filters.push({ queryKey: ['notifications'] });
    reportIds.clear();
    refreshAccount = false;
    await Promise.allSettled(filters.map(refreshQuery));
    refreshing = false;
    if (!disposed && (refreshAccount || reportIds.size > 0)) schedule();
  };

  return {
    refresh: (reportId?: string) => {
      if (disposed) return;
      if (reportId) reportIds.add(reportId);
      else refreshAccount = true;
      schedule();
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      reportIds.clear();
    },
  };
}
