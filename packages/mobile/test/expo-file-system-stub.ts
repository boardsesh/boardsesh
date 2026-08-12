// Vitest stub for `expo-file-system`.
//
// expo-file-system's package.json points `main`/`exports` at TypeScript source
// (src/index.ts). That source imports `expo-modules-core` native bindings whose
// untransformed TS declarations (e.g. `FileSystemDirectory: typeof NativeFileSystemDirectory`)
// throw `SyntaxError: Unexpected token 'typeof'` in Vitest's module worker
// before the TypeScript plugin can strip the type annotations.
//
// Most suites only need this to satisfy static imports so Vitest's module graph
// resolves cleanly, so THE UNSEEDED DEFAULTS ARE UNCHANGED: every directory
// reports `exists === false` and `list()` returns []. Suites that assert
// file-system behaviour either register their own `vi.mock` (which takes
// precedence over this alias) or opt in with `__seedFileSystem` below and reset
// in `afterEach`.
//
// Wired via the `expo-file-system` alias in packages/mobile/vite.config.ts.

/** One seeded file: size in bytes, last-modified in ms since the epoch. */
export type SeededFile = { size?: number; lastModified?: number | null };

/** Seeded tree: directory path -> file name -> file. Directories are the keys. */
export type SeededFileSystem = Record<string, Record<string, SeededFile>>;

const seed: { tree: SeededFileSystem; availableDiskSpace: number | null } = {
  tree: {},
  availableDiskSpace: null,
};

/**
 * Opt in to a seeded filesystem for one suite. Always pair with
 * `__resetFileSystem()` — an unreset seed leaks into every other suite sharing
 * the worker, which is exactly why the unseeded defaults stay empty.
 */
export function __seedFileSystem(tree: SeededFileSystem, options?: { availableDiskSpace?: number | null }): void {
  seed.tree = tree;
  if (options && 'availableDiskSpace' in options) seed.availableDiskSpace = options.availableDiskSpace ?? null;
}

export function __resetFileSystem(): void {
  seed.tree = {};
  seed.availableDiskSpace = null;
}

function joinPath(parts: unknown[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part : ((part as { path?: string })?.path ?? '')))
    .filter((part) => part.length > 0)
    .join('/');
}

function parentPathOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function nameOf(path: string): string {
  return path.split('/').pop() ?? '';
}

export class Directory {
  readonly path: string;

  constructor(...args: unknown[]) {
    this.path = joinPath(args);
  }

  get name(): string {
    return nameOf(this.path);
  }

  get exists(): boolean {
    return Object.prototype.hasOwnProperty.call(seed.tree, this.path);
  }

  list(): (Directory | File)[] {
    const entries = seed.tree[this.path];
    if (!entries) return [];
    const children: (Directory | File)[] = Object.keys(entries).map((name) => new File(this, name));
    // Seeded directories one level below this one surface as Directory instances,
    // mirroring the real `(Directory | File)[]` return type.
    for (const path of Object.keys(seed.tree)) {
      if (path === this.path) continue;
      if (!path.startsWith(`${this.path}/`)) continue;
      if (path.slice(this.path.length + 1).includes('/')) continue;
      children.push(new Directory(path));
    }
    return children;
  }

  delete(): void {
    delete seed.tree[this.path];
  }
}

export class File {
  readonly path: string;

  constructor(...args: unknown[]) {
    this.path = joinPath(args);
  }

  private get record(): SeededFile | undefined {
    return seed.tree[parentPathOf(this.path)]?.[this.name];
  }

  get name(): string {
    return nameOf(this.path);
  }

  get exists(): boolean {
    return this.record !== undefined;
  }

  get uri(): string {
    return this.path;
  }

  get size(): number {
    return this.record?.size ?? 0;
  }

  get lastModified(): number | null {
    return this.record?.lastModified ?? null;
  }

  get modificationTime(): number | null {
    return this.lastModified;
  }

  delete(): void {
    const entries = seed.tree[parentPathOf(this.path)];
    if (entries) delete entries[this.name];
  }
}

export const Paths = {
  get cache(): Directory {
    return new Directory('cache');
  },
  get document(): Directory {
    return new Directory('document');
  },
  get bundle(): Directory {
    return new Directory('bundle');
  },
  get availableDiskSpace(): number | null {
    return seed.availableDiskSpace;
  },
};

export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;
export const FileMode = { Read: 0, Write: 1, ReadWrite: 2 } as const;
export const UploadType = { BinaryContent: 0, Multipart: 1 } as const;
