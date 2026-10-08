import type { MoonBoardClimb } from '@boardsesh/moonboard-ocr/browser';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';

/**
 * Upload OCR test data to S3 for training/testing purposes
 *
 * This is a fire-and-forget upload - errors are logged but don't affect the caller.
 *
 * @param backendUrl - The backend server URL (from NEXT_PUBLIC_WS_URL)
 * @param image - The original screenshot file
 * @param parsedResult - The OCR result for this image
 * @param layoutId - The MoonBoard layout ID
 * @param angle - The wall angle
 * @param authToken - The user's auth token for authentication
 */
export async function uploadOcrTestData(
  backendUrl: string,
  image: File,
  parsedResult: MoonBoardClimb,
  layoutId: number,
  angle: number,
  authToken: string,
): Promise<void> {
  try {
    const formData = new FormData();

    // Add the image file
    formData.append('image', image);

    // Add metadata as JSON
    const metadata = {
      layoutId,
      angle,
      climb: parsedResult,
    };
    formData.append('metadata', JSON.stringify(metadata));

    const response = await fetch(`${backendUrl}/api/ocr-test-data`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...webClientIdentityHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.warn(
        `[OCR Upload] Upload failed for climb "${parsedResult.name || 'Unknown'}":`,
        errorData.error || response.statusText,
      );
      return;
    }

    const result = await response.json();
    if (result.skipped) {
      console.info('[OCR Upload] Upload skipped:', result.reason);
    } else {
      console.info('[OCR Upload] Successfully uploaded test data');
    }
  } catch (error) {
    // Fire-and-forget: log but don't throw
    console.warn(`[OCR Upload] Failed to upload test data for climb "${parsedResult.name || 'Unknown'}":`, error);
  }
}

/**
 * Upload multiple OCR test data files
 *
 * @param backendUrl - The backend server URL
 * @param files - Map of source filename to File object
 * @param climbs - Array of parsed climbs
 * @param layoutId - The MoonBoard layout ID
 * @param angle - The wall angle
 * @param authToken - The user's auth token
 */
export async function uploadOcrTestDataBatch(
  backendUrl: string,
  files: Map<string, File>,
  climbs: MoonBoardClimb[],
  layoutId: number,
  angle: number,
  authToken: string,
): Promise<void> {
  // Upload each climb's corresponding file
  // Do these sequentially to avoid overwhelming the server
  for (const climb of climbs) {
    const file = files.get(climb.sourceFile);
    if (file) {
      await uploadOcrTestData(backendUrl, file, climb, layoutId, angle, authToken);
    }
  }
}
