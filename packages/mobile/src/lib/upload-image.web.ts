import type { UploadImage } from './upload-image.types';

/** Browser picker/manipulator URIs refer to blobs, not native filesystem files. */
export async function appendUploadImage(formData: FormData, fieldName: string, image: UploadImage): Promise<void> {
  // Read the local blob/data URL without attaching backend credentials.
  const response = await fetch(image.uri);
  if (!response.ok) throw new Error('Selected image is unavailable');
  const imageBlob = await response.blob();
  if (imageBlob.size === 0) throw new Error('Selected image is empty');
  formData.append(fieldName, imageBlob.slice(0, imageBlob.size, image.type), image.name);
}
