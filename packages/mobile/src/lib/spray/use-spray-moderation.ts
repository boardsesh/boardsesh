import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rolesGrantAdmin } from '@boardsesh/community-roles';
import {
  GET_SPRAY_WALL_REPORTS,
  REPORT_SPRAY_WALL,
  SET_SPRAY_WALL_HIDDEN,
  type SprayWallReportData,
  type GetSprayWallReportsQueryResponse,
  type ReportSprayWallMutationResponse,
  type ReportSprayWallMutationVariables,
  type SetSprayWallHiddenMutationResponse,
  type SetSprayWallHiddenMutationVariables,
} from '@boardsesh/graphql/operations/spray-walls';
import { getHttpClient } from '../graphql/client';
import { useAuthToken } from '../graphql/use-auth-token';
import { useMyRoles } from '../graphql/hooks/use-my-roles';
import { useClimbModerationEnabled, useFeatureFlagsResolved } from '../../providers/feature-flags-provider';

export const SPRAY_REPORTS_QUERY_KEY = ['sprayWallReports'] as const;
let nextSessionScope = 0;

export function useSprayModerationAccess() {
  const { data: authToken } = useAuthToken();
  const roles = useMyRoles();
  const resolved = useFeatureFlagsResolved();
  const moderationEnabled = useClimbModerationEnabled();
  const canReport = resolved && moderationEnabled && !!authToken;
  // Opaque per-session identity: bearer credentials must never reach query logs.
  const sessionScope = useMemo(() => (authToken ? ++nextSessionScope : 0), [authToken]);
  return { canReport, canReview: canReport && rolesGrantAdmin(roles, 'spray'), sessionScope };
}

export function useSprayWallReports(enabled: boolean, sessionScope: number) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => [...SPRAY_REPORTS_QUERY_KEY, sessionScope] as const, [sessionScope]);
  useEffect(() => {
    if (!enabled) {
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    }
    return () => {
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    };
  }, [enabled, queryClient, queryKey]);
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      (await getHttpClient().request<GetSprayWallReportsQueryResponse>({ document: GET_SPRAY_WALL_REPORTS, signal }))
        .sprayWallReports,
    enabled,
    gcTime: 0,
    staleTime: 0,
    // Refresh before the shortest private photo signature expires.
    refetchInterval: (query) => {
      if (!enabled) return false;
      const expires =
        query.state.data
          ?.flatMap((report) => (report.photo ? [Date.parse(report.photo.expiresAt)] : []))
          .filter(Number.isFinite) ?? [];
      return expires.length ? Math.max(30_000, Math.min(...expires) - Date.now() - 60_000) : false;
    },
  });
}

export function useReportSprayWall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: ReportSprayWallMutationVariables) =>
      (
        await getHttpClient().request<ReportSprayWallMutationResponse, ReportSprayWallMutationVariables>(
          REPORT_SPRAY_WALL,
          variables,
        )
      ).reportSprayWall,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SPRAY_REPORTS_QUERY_KEY });
    },
  });
}

export function useReviewSprayWall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: SetSprayWallHiddenMutationVariables) =>
      (
        await getHttpClient().request<SetSprayWallHiddenMutationResponse, SetSprayWallHiddenMutationVariables>(
          SET_SPRAY_WALL_HIDDEN,
          variables,
        )
      ).setSprayWallHidden,
    onSuccess: (result) => {
      queryClient.setQueriesData<SprayWallReportData[]>({ queryKey: SPRAY_REPORTS_QUERY_KEY }, (reports) =>
        reports?.filter((report) => report.wallUuid !== result.uuid),
      );
      for (const queryKey of [
        SPRAY_REPORTS_QUERY_KEY,
        ['sprayWallByLayout'],
        ['sprayWallRenderData'],
        ['myBoards'],
        ['nearbyBoards'],
        ['searchBoards'],
        ['board'],
        ['boardBySlug'],
        ['gymBoards'],
        ['mySprayWalls'],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
