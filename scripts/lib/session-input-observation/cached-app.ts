import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

export const SESSION_INPUT_APP_CACHE =
  'macOS-ARM64-screenshot-sim-app-v1-9dd78a74eb71965f2e0876a147045ef8207d824eb936ee349170ddcd54a8082a';
export const SESSION_INPUT_NATIVE_HASHES = {
  Boardsesh: 'ac42743479f9f31c1311dce8b2523bc1d528d80bf3ef6779b345f45a751e0ade',
  'Boardsesh.debug.dylib': '2890913dc555fbe4bdeab6f694a4f79255ea3dacdd93331d0dba8e0d84a67e5d',
} as const;
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ownJavascript = new Set(['PlugIns/BoardseshBeta.appex/ShareExtensionPreprocessor.js']);
const extraKeys = new Set(['eas', 'router', 'tailscaleHosts']);
const secretKey = /(?:password|secret|token|privatekey|credential|authorization|apikey)/i;
const runtimeDirectory =
  /(?:^|\/)(?:Documents|Library|Caches|tmp|RCTAsyncLocalStorage|AsyncStorage|mmkv|Cookies|WebKit)(?:\/|$)/i;
const privateFile =
  /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:mobileprovision|p12|pfx|p8|key|keychain|sqlite|sqlite3|db)|id_rsa|id_ed25519)$/i;
const dependencyResource = (path: string) => /(?:^|\/)(?:EXDevMenu|EXDevLauncher)\.bundle\//.test(path);
function record(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}
export function readAppConfiguration(filename: string): unknown {
  const bytes = readFileSync(filename);
  if (bytes.toString('utf8', 0, 1) === '{' || extname(filename) === '.json' || basename(filename) === 'app.config')
    return JSON.parse(bytes.toString('utf8'));
  const parsed = spawnSync('plutil', ['-convert', 'json', '-o', '-', filename], {
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (parsed.status !== 0) throw new Error('config_parse_failed');
  return JSON.parse(parsed.stdout);
}
function inspectConfiguration(input: unknown, prefix: string, failures: string[], keys: string[]): void {
  if (Array.isArray(input)) {
    input.forEach((item, index) => inspectConfiguration(item, `${prefix}[${index}]`, failures, keys));
    return;
  }
  const object = record(input);
  if (object) {
    for (const [key, content] of Object.entries(object)) {
      const safeKey = /^[A-Za-z0-9_.-]{1,100}$/.test(key) ? key : '[unrecognized-key]';
      const path = prefix ? `${prefix}.${safeKey}` : safeKey;
      keys.push(path);
      if (secretKey.test(key.replace(/[_-]/g, '')) && content !== null && content !== '' && content !== false)
        failures.push(`credential_config_key:${path}`);
      inspectConfiguration(content, path, failures, keys);
    }
  } else if (typeof input === 'string') {
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(input)) failures.push(`private_key_config:${prefix}`);
    if (/^https?:\/\//.test(input)) {
      try {
        const url = new URL(input);
        if (
          url.password ||
          (url.username && !/dsn$/i.test(prefix)) ||
          [...url.searchParams.keys()].some((key) =>
            /^(?:token|secret|password|access_token|refresh_token)$/i.test(key),
          )
        )
          failures.push(`credential_url_config:${prefix}`);
      } catch {
        failures.push(`invalid_url_config:${prefix}`);
      }
    }
  }
}
export type AppInventoryEntry = {
  path: string;
  kind: string;
  mode: number;
  bytes?: number;
  sha256?: string;
  target?: string;
};
export function inspectCachedSimulatorApp(
  app: string,
  expectedHashes: Record<string, string> = SESSION_INPUT_NATIVE_HASHES,
) {
  const failures: string[] = [];
  const files: AppInventoryEntry[] = [];
  const configurationKeys: { path: string; keys: string[] }[] = [];
  const root = resolve(app);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error('cached_app_root_not_build_product_directory');
  const canonicalRoot = realpathSync(root);
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        resource = relative(root, path).split(sep).join('/'),
        stat = lstatSync(path);
      const entry: AppInventoryEntry = {
        path: resource,
        kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
        mode: stat.mode & 0o7777,
      };
      if (files.length >= 10_000) throw new Error('inventory_file_limit');
      files.push(entry);
      if (runtimeDirectory.test(resource) || privateFile.test(resource)) {
        entry.kind = 'blocked-resource';
        failures.push(`runtime_or_private_resource:${resource}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          const target = realpathSync(path);
          if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) {
            entry.target = '[outside-app]';
            failures.push(`escaping_symlink:${resource}`);
          } else entry.target = readlinkSync(path);
        } catch {
          entry.target = '[unresolved]';
          failures.push(`unresolved_symlink:${resource}`);
        }
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) {
        failures.push(`unexpected_file_kind:${resource}`);
        continue;
      }
      if (stat.size > 512 * 1024 * 1024) {
        failures.push(`resource_size_limit:${resource}`);
        continue;
      }
      const bytes = readFileSync(path);
      entry.bytes = bytes.length;
      entry.sha256 = sha256(bytes);
      const javascript =
        /\.(?:js|jsbundle|hbc|hermes)$/i.test(resource) ||
        bytes.subarray(0, 8).equals(Buffer.from('c61fbc03c103191f', 'hex'));
      if (javascript && !dependencyResource(resource) && !ownJavascript.has(resource))
        failures.push(`embedded_application_javascript:${resource}`);
      if (
        /\.(?:key|pem|p8)$/i.test(resource) &&
        /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(bytes.toString('utf8'))
      )
        failures.push(`private_key_resource:${resource}`);
      if (resource.endsWith('.plist') || resource.endsWith('.json') || name === 'app.config') {
        try {
          const config = readAppConfiguration(path);
          const keys: string[] = [];
          // Dependency code/resources are inventoried, but code constants are not mistaken for credentials.
          inspectConfiguration(config, '', failures, keys);
          configurationKeys.push({ path: resource, keys });
          if (resource === 'EXConstants.bundle/app.config') {
            const extra = record(record(config)?.extra);
            for (const key of Object.keys(extra ?? {}))
              if (!extraKeys.has(key))
                failures.push(
                  `unexpected_app_extra_key:${/^[A-Za-z0-9_.-]{1,100}$/.test(key) ? key : '[unrecognized-key]'}`,
                );
          }
        } catch {
          failures.push(`configuration_unreadable:${resource}`);
        }
      }
    }
  };
  walk(root);
  for (const [name, expected] of Object.entries(expectedHashes))
    if (files.find((file) => file.path === name)?.sha256 !== expected) failures.push(`native_hash_mismatch:${name}`);
  const plist = record(readAppConfiguration(join(root, 'Info.plist'))) ?? {};
  if (
    plist.CFBundleIdentifier !== 'com.boardsesh.app' ||
    plist.CFBundleExecutable !== 'Boardsesh' ||
    plist.DTSDKName !== 'iphonesimulator26.5'
  )
    failures.push('native_app_identity_or_sdk_mismatch');
  return {
    safe: failures.length === 0,
    failures,
    files,
    configurationKeys,
    native: {
      hashes: Object.fromEntries(
        Object.keys(expectedHashes).map((name) => [name, files.find((file) => file.path === name)?.sha256 ?? null]),
      ),
      sdk: Object.fromEntries(
        [
          'CFBundleIdentifier',
          'CFBundleVersion',
          'CFBundleShortVersionString',
          'DTSDKName',
          'DTXcodeBuild',
          'MinimumOSVersion',
        ].map((key) => [key, plist[key]]),
      ),
    },
  };
}
