import type { PrivacyPublicationInput } from '@boardsesh/graphql/operations/privacy';
import { normalizePlaylistColor } from '@boardsesh/shared-schema';

export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;

export type PlaylistFormValues = {
  privacy?: PrivacyPublicationInput;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  isPublic?: boolean;
};

export type PlaylistFormFields = {
  name: string;
  description: string;
  color?: string;
  icon?: string;
  isPublic: boolean;
};

export type PlaylistFormError = 'name-required' | 'name-too-long' | 'description-too-long';

export type PlaylistFormResult = { ok: true; values: PlaylistFormValues } | { ok: false; error: PlaylistFormError };

/**
 * Validate the form fields and build the mutation values — pure and
 * renderer-free so the load-bearing branching is unit-tested without rendering
 * the gorhom sheet:
 *  - length limits (name ≤ 100, description ≤ 500);
 *  - edit sends '' for a cleared description/colour/icon (the backend
 *    normalization contract turns '' → NULL), create omits empties.
 * Returns an error code on failure; the component maps it to an i18n message.
 */
export function buildPlaylistFormValues(mode: 'create' | 'edit', fields: PlaylistFormFields): PlaylistFormResult {
  const trimmedName = fields.name.trim();
  if (!trimmedName) return { ok: false, error: 'name-required' };
  if (trimmedName.length > NAME_MAX) return { ok: false, error: 'name-too-long' };

  const trimmedDescription = fields.description.trim();
  if (trimmedDescription.length > DESCRIPTION_MAX) return { ok: false, error: 'description-too-long' };
  const normalizedColor = normalizePlaylistColor(fields.color);

  const values: PlaylistFormValues =
    mode === 'edit'
      ? {
          name: trimmedName,
          description: trimmedDescription,
          color: normalizedColor ?? '',
          icon: fields.icon ?? '',
          isPublic: fields.isPublic,
        }
      : {
          name: trimmedName,
          description: trimmedDescription || undefined,
          color: normalizedColor ?? undefined,
          icon: fields.icon,
        };
  return { ok: true, values };
}
