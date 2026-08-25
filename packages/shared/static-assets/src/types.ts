export type StaticAssetRecord = Readonly<{
  logicalPath: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  nativeBundle: boolean;
}>;

export type StaticAssetManifest = Readonly<Record<string, StaticAssetRecord>>;
