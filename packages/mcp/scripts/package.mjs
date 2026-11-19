import { build } from 'esbuild';
import { copyFile, mkdir, chmod, rm, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
await rm(path.join(packageRoot, 'dist'), { recursive: true, force: true });
await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, 'src/cli.ts')],
  outfile: path.join(packageRoot, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { __BOARDSESH_MCP_CLIENT_ID__: JSON.stringify(process.env.BOARDSESH_MCP_PUBLIC_CLIENT_ID ?? '') },
  // Only the private workspace contract is bundled. Native dependencies and
  // the SDK remain normal registry dependencies in the installable package.
  external: [
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/server/*',
    'better-sqlite3',
    'drizzle-orm',
    'drizzle-orm/*',
    'proper-lockfile',
    'zod',
    'zod/*',
  ],
  banner: { js: '#!/usr/bin/env node' },
});
await chmod(path.join(packageRoot, 'dist/cli.js'), 0o755);
await copyFile(path.resolve(packageRoot, '../../LICENSE'), path.join(packageRoot, 'LICENSE'));

const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const stage = await mkdtemp(path.join(tmpdir(), 'boardsesh-mcp-package-'));
try {
  const payload = path.join(stage, 'package');
  await mkdir(payload);
  for (const filename of manifest.files)
    await cp(path.join(packageRoot, filename), path.join(payload, filename), { recursive: true });
  // The archive has no private workspace or build-time dependencies.
  delete manifest.devDependencies;
  delete manifest.scripts;
  await writeFile(path.join(payload, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const artifacts = path.join(packageRoot, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  // Stream the archive so GNU tar never interprets a Windows drive-letter
  // filename as a remote host. cwd is resolved by Node on every platform.
  const archive = execFileSync('tar', ['-czf', '-', 'package'], { cwd: stage, maxBuffer: 16 * 1024 * 1024 });
  const archiveName = `boardsesh-mcp-${manifest.version}.tgz`;
  await writeFile(path.join(artifacts, archiveName), archive);
  await writeFile(
    path.join(artifacts, `${archiveName}.sha256`),
    `${createHash('sha256').update(archive).digest('hex')}  ${archiveName}\n`,
  );
  await copyFile(path.join(packageRoot, 'README.md'), path.join(artifacts, 'INSTALL.md'));
} finally {
  await rm(stage, { recursive: true, force: true });
}
