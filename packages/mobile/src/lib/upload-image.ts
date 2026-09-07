import { File } from 'expo-file-system';
import type { UploadImage } from './upload-image.types';

/** Append a replayable file for both RN fetch (release) and Expo fetch (development). */
export async function appendUploadImage(formData: FormData, fieldName: string, image: UploadImage): Promise<void> {
  const localFile = new File(image.uri);
  if (!localFile.exists) throw new Error('Selected image is unavailable');
  if (localFile.size === 0) throw new Error('Selected image is empty');

  const imagePart = { uri: localFile.uri, name: image.name, type: image.type };
  // RN's getParts() spreads this descriptor before handing it to native code.
  // Keep Expo's reader non-enumerable so only uri/name/type cross that bridge.
  // Expo's encoder reads bytes() directly from the original FormData entry.
  Object.defineProperty(imagePart, 'bytes', { value: () => localFile.bytes() });
  // DOM types omit RN's URI descriptor; the runtime supports it.
  formData.append(fieldName, imagePart as unknown as Blob);
}
