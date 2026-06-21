// Vitest stub for `expo-file-system`.
//
// expo-file-system's package.json points `main`/`exports` at TypeScript source
// (src/index.ts). That source imports `expo-modules-core` native bindings whose
// untransformed TS declarations (e.g. `FileSystemDirectory: typeof NativeFileSystemDirectory`)
// throw `SyntaxError: Unexpected token 'typeof'` in Vitest's module worker
// before the TypeScript plugin can strip the type annotations.
//
// No test in this repo exercises the real file-system; this stub only needs to
// satisfy static imports so Vitest's module graph resolves cleanly.
// Suites that assert file-system behaviour can register their own `vi.mock`
// which takes precedence over this alias.
//
// Wired via the `expo-file-system` alias in packages/mobile/vite.config.ts.

export class Directory {
  constructor(..._args: unknown[]) {}
  get exists(): boolean {
    return false;
  }
  list(): unknown[] {
    return [];
  }
  delete(): void {}
}

export class File {
  constructor(..._args: unknown[]) {}
  get exists(): boolean {
    return false;
  }
  get uri(): string {
    return '';
  }
  delete(): void {}
}

export const Paths = {
  get cache(): Directory {
    return new Directory();
  },
  get document(): Directory {
    return new Directory();
  },
  get bundle(): Directory {
    return new Directory();
  },
};

export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;
export const FileMode = { Read: 0, Write: 1, ReadWrite: 2 } as const;
export const UploadType = { BinaryContent: 0, Multipart: 1 } as const;
