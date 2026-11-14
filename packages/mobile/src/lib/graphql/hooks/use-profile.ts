import { useQueryClient } from '@tanstack/react-query';
import type { PublicUserProfile, UpdateProfileInput } from '@boardsesh/shared-schema';
import {
  GET_PROFILE,
  UPDATE_PROFILE,
  type GetProfileQueryResponse,
  type UpdateProfileMutationResponse,
} from '../operations';
import { useHttpQuery } from '../use-http-query';
import { useHttpMutation } from '../use-http-mutation';

/** Anonymous profile:null is a real response, not a reason to disable the
 * session bootstrap. Required-but-unavailable browser views remain inert. */
export function useProfile(options?: { enabled?: boolean }) {
  return useHttpQuery({
    queryKey: ['profile'],
    queryFn: (_context, operation) => operation.request<GetProfileQueryResponse>(GET_PROFILE),
    select: (response) => response.profile,
    enabled: options?.enabled ?? true,
  });
}

/** The avatar upload remains separate. Only this operation's original delivery
 * can update the selected view's profile caches or refresh those queries. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useHttpMutation({
    mutationFn: async (input: UpdateProfileInput, operation) => {
      const response = await operation.request<UpdateProfileMutationResponse>(UPDATE_PROFILE, { input });
      return response.updateProfile;
    },
    onSuccess: async (updatedProfile, _input, _context, operation) => {
      const cache = operation.cache(queryClient);
      cache.setQueryData<GetProfileQueryResponse>(['profile'], { profile: updatedProfile });
      cache.setQueryData<PublicUserProfile | null>(['publicProfile', updatedProfile.id], (cachedProfile) =>
        cachedProfile
          ? { ...cachedProfile, displayName: updatedProfile.displayName, avatarUrl: updatedProfile.avatarUrl }
          : cachedProfile,
      );
      if (operation.scoped) {
        await cache.invalidateQueries({ queryKey: ['profile'] });
        await cache.invalidateQueries({ queryKey: ['publicProfile', updatedProfile.id] });
      } else {
        // Native/legacy keeps its existing nonblocking refresh and save timing.
        // A later retirement may refuse the background completion locally.
        void cache.invalidateQueries({ queryKey: ['profile'] }).catch(() => {});
        void cache.invalidateQueries({ queryKey: ['publicProfile', updatedProfile.id] }).catch(() => {});
      }
    },
  });
}
