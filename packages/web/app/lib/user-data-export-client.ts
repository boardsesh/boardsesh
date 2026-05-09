import { getBackendHttpUrl } from '@/app/lib/backend-url';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';
import type { AuroraBoardName } from '@boardsesh/shared-schema';

type UserDataExportStatus = {
  status: 'not_requested' | 'generating' | 'ready' | 'failed' | 'unavailable';
  downloadUrl?: string;
  error?: string;
};

export type ExportDeliveryResult = 'downloaded' | 'shared' | 'cancelled';

type ExportOptions = {
  onGenerating?: () => void;
};

export function formatBoardTypeLabel(boardType: string): string {
  return boardType.charAt(0).toUpperCase() + boardType.slice(1);
}

function getExportFilename(response: Response, boardType: AuroraBoardName): string {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/);
  return match?.[1] ?? `boardsesh-${boardType}-export.json`;
}

async function parseExportResponse(response: Response): Promise<UserDataExportStatus> {
  const body = (await response.json().catch(() => null)) as (UserDataExportStatus & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Export request failed (${response.status})`);
  }
  if (!body) {
    throw new Error('Export request returned an empty response');
  }
  return body;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeExportFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, '-');
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function isShareCancelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || /cancel/i.test(error.message);
}

async function shareExportWithWebShare(blob: Blob, filename: string): Promise<ExportDeliveryResult | null> {
  if (typeof navigator === 'undefined' || typeof File === 'undefined' || !navigator.share || !navigator.canShare) {
    return null;
  }

  const file = new File([blob], filename, { type: blob.type || 'application/json' });
  const shareData: ShareData = {
    title: filename,
    text: 'Boardsesh logbook export',
    files: [file],
  };

  if (!navigator.canShare(shareData)) return null;

  try {
    await navigator.share(shareData);
    return 'shared';
  } catch (error) {
    if (isShareCancelError(error)) return 'cancelled';
    throw error;
  }
}

async function shareExportWithCapacitor(blob: Blob, filename: string): Promise<ExportDeliveryResult | null> {
  if (!isNativeApp()) return null;

  const filesystem = window.Capacitor?.Plugins.Filesystem;
  const share = window.Capacitor?.Plugins.Share;

  if (!filesystem || !share) {
    return shareExportWithWebShare(blob, filename);
  }

  const canShare = await share.canShare?.().catch(() => ({ value: true }));
  if (canShare?.value === false) return null;

  const data = await blobToBase64(blob);
  const path = `exports/${sanitizeExportFilename(filename)}`;
  const { uri } = await filesystem.writeFile({
    path,
    data,
    directory: 'CACHE',
    recursive: true,
  });

  try {
    await share.share({
      title: filename,
      text: 'Boardsesh logbook export',
      url: uri,
      dialogTitle: 'Save export',
    });
    return 'shared';
  } catch (error) {
    if (isShareCancelError(error)) return 'cancelled';
    throw error;
  }
}

function downloadExportInBrowser(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function deliverExportBlob(blob: Blob, filename: string): Promise<ExportDeliveryResult> {
  const nativeResult = await shareExportWithCapacitor(blob, filename);
  if (nativeResult) return nativeResult;

  if (isNativeApp()) {
    throw new Error('Export needs a newer Boardsesh app build on this device.');
  }

  downloadExportInBrowser(blob, filename);
  return 'downloaded';
}

async function downloadExport(
  backendUrl: string,
  token: string,
  boardType: AuroraBoardName,
): Promise<ExportDeliveryResult> {
  const response = await fetch(`${backendUrl}/api/user-data-export/download?boardType=${boardType}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Export download failed (${response.status})`);
  }

  const blob = await response.blob();
  const filename = getExportFilename(response, boardType);
  return deliverExportBlob(blob, filename);
}

async function waitForExport(
  backendUrl: string,
  token: string,
  boardType: AuroraBoardName,
): Promise<UserDataExportStatus> {
  for (let i = 0; i < 30; i++) {
    await wait(2000);
    const response = await fetch(`${backendUrl}/api/user-data-export?boardType=${boardType}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const status = await parseExportResponse(response);

    if (status.status === 'ready') return status;
    if (status.status === 'failed' || status.status === 'unavailable') {
      throw new Error(status.error ?? 'Export generation failed');
    }
  }

  throw new Error('Export is still generating. Try again shortly.');
}

export async function requestAndDeliverUserDataExport(
  boardType: AuroraBoardName,
  token: string | null | undefined,
  options: ExportOptions = {},
): Promise<ExportDeliveryResult> {
  const backendUrl = getBackendHttpUrl();
  if (!backendUrl) {
    throw new Error('Boardsesh could not find the export service URL.');
  }

  if (!token) {
    throw new Error('Sign in again to export your logbook data.');
  }

  const response = await fetch(`${backendUrl}/api/user-data-export?boardType=${boardType}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  let status = await parseExportResponse(response);

  if (status.status === 'generating') {
    options.onGenerating?.();
    status = await waitForExport(backendUrl, token, boardType);
  }

  if (status.status !== 'ready') {
    throw new Error(status.error ?? 'Export is not ready yet');
  }

  return downloadExport(backendUrl, token, boardType);
}
