import { useQuery } from '@tanstack/react-query';
import {
  GET_MY_BOARD_SERIAL_CONFIGS,
  type BoardSerialConfig,
  type GetMyBoardSerialConfigsQueryResponse,
} from '@boardsesh/graphql/operations';
import { getHttpClient } from '../graphql/client';
import { useAuthToken } from '../graphql/use-auth-token';

const EMPTY_BOARD_SERIAL_CONFIGS: BoardSerialConfig[] = [];

/**
 * Returns the current climber's recorded serial-to-board choices for BLE
 * discovery. It lives beside BLE rather than the general GraphQL hook barrel:
 * loading an auth token pulls in the native secure store, which unrelated
 * GraphQL hooks must not need in their unit-test environment.
 */
export function useMyBoardSerialConfigs(serialNumbers: string[]) {
  const authTokenQuery = useAuthToken();
  const authToken = authTokenQuery.data;
  const query = useQuery({
    queryKey: ['myBoardSerialConfigs', authToken ?? null, serialNumbers],
    queryFn: () =>
      getHttpClient().request<GetMyBoardSerialConfigsQueryResponse>(GET_MY_BOARD_SERIAL_CONFIGS, { serialNumbers }),
    enabled: serialNumbers.length > 0 && authToken != null,
    retry: false,
  });

  return {
    data: query.data?.myBoardSerialConfigs ?? EMPTY_BOARD_SERIAL_CONFIGS,
    // Wait for auth hydration before declaring a scan empty; otherwise a saved
    // board can briefly appear as several public serial-collision candidates.
    isResolving: authToken === undefined || (authToken !== null && query.isLoading),
  };
}
