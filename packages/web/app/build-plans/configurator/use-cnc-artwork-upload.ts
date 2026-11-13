'use client';

import { useCallback, useState } from 'react';
import type { CncArtworkKind } from '@boardsesh/shared-schema';
import { getBackendHttpUrl } from '@/app/lib/backend-url';

/**
 * Send one logo to `POST /api/cnc/art` and get back the id the order will name.
 *
 * Multipart to the backend rather than a GraphQL mutation, for the same reason
 * gym logos and avatars are: a 5 MB file base64'd into a JSON variable is a
 * third bigger, buffered whole in two processes, and impossible to cap at the
 * transport. The client pattern is copied from `gym-logo-uploader.tsx` — same
 * `getBackendHttpUrl`, same Bearer header, same "localized message first, the
 * server's English as context" error handling.
 *
 * The bytes are never held here after the request. What comes back is an id;
 * the preview the buyer sees is an object URL made from their own File, which
 * is the component's to own and to revoke.
 */

export type CncArtUpload = {
  assetId: string;
  /** The mime the SERVER sniffed, which is what decides the item's kind. */
  mime: string;
  widthPx: number | null;
  heightPx: number | null;
  sizeBytes: number;
};

/**
 * Why an upload was refused, as an i18n key segment under
 * `configurator.artwork.upload.errors`.
 *
 * Deliberately coarser than the route's own `reason` codes. The route
 * distinguishes a `<script>` from an `on*` handler from an external `href`
 * because an operator reading a log needs to know which; a buyer needs to know
 * that the drawing does something we will not route and that a plain export
 * fixes it. Every code the route can return maps into one of these, so a
 * rejection is never an untranslated string.
 */
export type CncArtUploadErrorKey =
  | 'tooLarge'
  | 'noFile'
  | 'unsupportedType'
  | 'unsafeDrawing'
  | 'noViewBox'
  | 'tooComplex'
  | 'imageTooSmall'
  | 'imageTooLarge'
  | 'unreadableImage'
  | 'rateLimited'
  | 'unavailable'
  | 'generic';

/**
 * Every key the dynamic `t(\`…errors.${errorKey}\`)` in `artwork-step.tsx` can
 * land on, named here so the orphan check can see them from the file that
 * builds them. Delete a marker only with the branch of `REASON_TO_ERROR_KEY`
 * that produces it.
 *
 * i18n-keep cnc:configurator.artwork.upload.errors.tooLarge
 * i18n-keep cnc:configurator.artwork.upload.errors.noFile
 * i18n-keep cnc:configurator.artwork.upload.errors.unsupportedType
 * i18n-keep cnc:configurator.artwork.upload.errors.unsafeDrawing
 * i18n-keep cnc:configurator.artwork.upload.errors.noViewBox
 * i18n-keep cnc:configurator.artwork.upload.errors.tooComplex
 * i18n-keep cnc:configurator.artwork.upload.errors.imageTooSmall
 * i18n-keep cnc:configurator.artwork.upload.errors.imageTooLarge
 * i18n-keep cnc:configurator.artwork.upload.errors.unreadableImage
 * i18n-keep cnc:configurator.artwork.upload.errors.rateLimited
 * i18n-keep cnc:configurator.artwork.upload.errors.unavailable
 * i18n-keep cnc:configurator.artwork.upload.errors.generic
 */
const REASON_TO_ERROR_KEY: Record<string, CncArtUploadErrorKey> = {
  too_large: 'tooLarge',
  file_too_large: 'tooLarge',
  unsupported_type: 'unsupportedType',
  not_svg: 'unsupportedType',
  not_xml: 'unsupportedType',
  empty: 'unsupportedType',
  // Its own sentence rather than "we could not read that as a drawing": nothing
  // reached the route at all, so telling the buyer to re-export their SVG sends
  // them off to fix a file that was never the problem.
  no_file: 'noFile',
  disallowed_element: 'unsafeDrawing',
  event_handler: 'unsafeDrawing',
  external_reference: 'unsafeDrawing',
  disallowed_style: 'unsafeDrawing',
  doctype: 'unsafeDrawing',
  processing_instruction: 'unsafeDrawing',
  missing_view_box: 'noViewBox',
  too_many_paths: 'tooComplex',
  path_data_too_large: 'tooComplex',
  image_too_small: 'imageTooSmall',
  image_too_large: 'imageTooLarge',
  unreadable_image: 'unreadableImage',
  rate_limited: 'rateLimited',
  storage_unavailable: 'unavailable',
  save_failed: 'unavailable',
};

/**
 * The item kind an upload becomes, from the mime the SERVER sniffed.
 *
 * DUPLICATED, on purpose, in `packages/backend/src/services/cnc/catalog.ts`:
 * that copy decides the same thing again when checkout is priced, and the two
 * live either side of the network. A new mime has to be added in both places
 * or the browser and the order disagree about the same file.
 */
export function artworkKindForMime(mime: string): CncArtworkKind | null {
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'image/png') return 'png';
  return null;
}

/** The `accept` attribute for the file picker, from what the catalogue allows. */
export function uploadAcceptAttribute(allowedKinds: readonly CncArtworkKind[]): string {
  const accepted: string[] = [];
  if (allowedKinds.includes('svg')) accepted.push('image/svg+xml', '.svg');
  if (allowedKinds.includes('png')) accepted.push('image/png', '.png');
  return accepted.join(',');
}

export type CncArtworkUploadState = {
  upload: (file: File) => Promise<CncArtUpload | null>;
  isUploading: boolean;
  errorKey: CncArtUploadErrorKey | null;
  /** The route's own English sentence, shown as context under the translated one. */
  errorDetail: string | null;
  clearError: () => void;
};

export function useCncArtworkUpload(authToken: string | null): CncArtworkUploadState {
  const [isUploading, setIsUploading] = useState(false);
  const [errorKey, setErrorKey] = useState<CncArtUploadErrorKey | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setErrorKey(null);
    setErrorDetail(null);
  }, []);

  const upload = useCallback(
    async (file: File): Promise<CncArtUpload | null> => {
      const backendBaseUrl = getBackendHttpUrl();
      if (!backendBaseUrl || !authToken) {
        setErrorKey('unavailable');
        setErrorDetail(null);
        return null;
      }

      setIsUploading(true);
      setErrorKey(null);
      setErrorDetail(null);
      try {
        const formData = new FormData();
        formData.append('art', file);

        const response = await fetch(`${backendBaseUrl}/api/cnc/art`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: formData,
        });

        const payload = (await response.json().catch(() => null)) as
          | (Partial<CncArtUpload> & { error?: string; reason?: string })
          | null;

        if (!response.ok) {
          const reason = typeof payload?.reason === 'string' ? REASON_TO_ERROR_KEY[payload.reason] : undefined;
          setErrorKey(reason ?? 'generic');
          setErrorDetail(payload?.error ?? null);
          return null;
        }

        // Runtime-checked rather than cast: an unexpected body must not put an
        // `undefined` asset id into the draft, where it would ride all the way
        // to a checkout the server refuses for a reason nobody can see.
        if (typeof payload?.assetId !== 'string' || typeof payload.mime !== 'string') {
          setErrorKey('generic');
          return null;
        }

        return {
          assetId: payload.assetId,
          mime: payload.mime,
          widthPx: typeof payload.widthPx === 'number' ? payload.widthPx : null,
          heightPx: typeof payload.heightPx === 'number' ? payload.heightPx : null,
          sizeBytes: typeof payload.sizeBytes === 'number' ? payload.sizeBytes : file.size,
        };
      } catch {
        // A dropped connection, an aborted fetch, a proxy's HTML error page.
        setErrorKey('generic');
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [authToken],
  );

  return { upload, isUploading, errorKey, errorDetail, clearError };
}
