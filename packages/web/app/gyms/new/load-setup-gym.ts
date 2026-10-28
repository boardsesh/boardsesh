import 'server-only';
import { z } from 'zod';
import { GET_GYM, type GetGymQueryResponse } from '@boardsesh/graphql/operations';
import type { Gym } from '@boardsesh/shared-schema';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';

export function isGymSetupUuid(gymUuid: unknown): gymUuid is string {
  return z.string().uuid().safeParse(gymUuid).success;
}

/** Never return a gym's private fields before checking the viewer's access. */
export async function loadSetupGym(gymUuid: string, token: string): Promise<Gym | null> {
  if (!isGymSetupUuid(gymUuid)) return null;
  const response = await executeAuthenticatedGraphQL<GetGymQueryResponse>(GET_GYM, { gymUuid }, token);
  return response.gym?.canEdit ? response.gym : null;
}
