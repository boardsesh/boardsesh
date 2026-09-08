import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Load the installed SDK serializers, including RN's Flow source, without
// initializing native modules. Babel is already part of RN's build toolchain.
// A recording FormData mock missed the original zero-byte upload regression.
const testRequire = createRequire(import.meta.url);
const nativeRequire = createRequire(testRequire.resolve('react-native/package.json'));
const babel = nativeRequire('@babel/core') as {
  transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null;
};
const nativePreset = nativeRequire.resolve('@react-native/babel-preset');

function loadSdkModule<Exports>(filename: string): Exports {
  const transformed = babel.transformSync(readFileSync(filename, 'utf8'), {
    filename,
    configFile: false,
    babelrc: false,
    presets: [nativePreset],
  });
  if (!transformed?.code) throw new Error(`Could not transform SDK serializer: ${filename}`);
  const sdkModule = { exports: {} };
  const sourceRequire = createRequire(filename);
  runInNewContext(transformed.code, {
    module: sdkModule,
    exports: sdkModule.exports,
    Blob,
    TextEncoder,
    Uint8Array,
    require: (specifier: string): unknown =>
      specifier.startsWith('.') ? loadSdkModule(sourceRequire.resolve(`${specifier}.ts`)) : sourceRequire(specifier),
  });
  return sdkModule.exports as Exports;
}

export type NativeUploadPart = {
  uri?: string;
  string?: string;
  fieldName: string;
  headers: Record<string, string>;
};
export type NativeUploadFormData = FormData & { getParts(): NativeUploadPart[] };

const { default: ReactNativeFormData } = loadSdkModule<{ default: new () => NativeUploadFormData }>(
  testRequire.resolve('react-native/Libraries/Network/FormData'),
);
const { installFormDataPatch } = loadSdkModule<{
  installFormDataPatch: (constructor: typeof ReactNativeFormData) => typeof ReactNativeFormData;
}>(testRequire.resolve('expo/src/winter/FormData.ts'));

export const NativeFormData = installFormDataPatch(ReactNativeFormData);
export const { convertFormDataAsync } = loadSdkModule<{
  convertFormDataAsync: (form: FormData, boundary?: string) => Promise<{ body: Uint8Array; boundary: string }>;
}>(testRequire.resolve('expo/src/winter/fetch/convertFormData.ts'));
