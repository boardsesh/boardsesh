export type StaticAssetRecord = Readonly<{
  logicalPath: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  nativeBundle: boolean;
}>;

export type StaticAssetManifest = Readonly<Record<string, StaticAssetRecord>>;

/** The browser-facing catalog: logical public path to immutable CDN object key. */
export type StaticAssetObjectKeyCatalog = Readonly<Record<string, string>>;
