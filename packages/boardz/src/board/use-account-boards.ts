import { useQuery } from '@tanstack/react-query';
import { GET_MY_BOARDS, type GetMyBoardsQueryResponse } from '@boardsesh/graphql/operations/boards';
import { graphqlRequest } from '../api/graphql-client';
import { useAuth } from '../auth/auth-provider';
import { boardFromAccount, type ActiveBoard } from './active-board';

// The server's page maximum. Nobody has more boards than this.
const PAGE_SIZE = 50;

/** The signed-in climber's Boardsesh boards that Boardz can use. */
export function useAccountBoards() {
  const { status } = useAuth();
  return useQuery({
    queryKey: ['myBoards'],
    queryFn: async () => {
      const response = await graphqlRequest<GetMyBoardsQueryResponse>(GET_MY_BOARDS, {
        input: { limit: PAGE_SIZE, offset: 0 },
      });
      return response.myBoards.boards.map(boardFromAccount).filter((board): board is ActiveBoard => board !== null);
    },
    enabled: status === 'signedIn',
  });
}
