/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    compiler: { type: 'string' },
    source: {
      type: 'string',
      default:
        'packages/mobile/modules/climb-overlay-gpu/android/src/main/java/com/boardsesh/climboverlaygpu/OverlayShader.kt',
    },
  },
});
if (!values.compiler) throw new Error('Pass --compiler with the Android NDK glslc path.');

const kotlinSource = readFileSync(resolve(values.source), 'utf8');
const shaderMatches = [...kotlinSource.matchAll(/val\s+(vertex|fragment)\s*=\s*"""([\s\S]*?)"""\s*\.trimIndent\(\)/g)];
if (shaderMatches.length !== 2 || new Set(shaderMatches.map((match) => match[1])).size !== 2) {
  throw new Error('Expected exactly one literal vertex and fragment shader with trimIndent().');
}

const outputDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-gpu-shaders-'));
try {
  for (const [, stage, literal] of shaderMatches) {
    if (literal.includes('$')) throw new Error(`${stage}: interpolated shaders need an explicit extraction contract.`);
    // Match Kotlin trimIndent: drop blank boundary lines, then remove the
    // smallest indentation from nonblank lines. Validate the shipped strings,
    // not a second shader fixture that could drift from the native renderer.
    const lines = literal.split(/\r?\n/);
    if (lines[0].trim() === '') lines.shift();
    if (lines.at(-1)?.trim() === '') lines.pop();
    const indentation = Math.min(...lines.filter((line) => line.trim()).map((line) => line.search(/\S/)));
    const shader = lines.map((line) => (line.trim() ? line.slice(indentation) : '')).join('\n');
    if (!shader.startsWith('#version 310 es\n')) throw new Error(`${stage}: expected GLSL ES 3.1.`);
    const shaderPath = join(outputDirectory, stage === 'vertex' ? 'overlay.vert' : 'overlay.frag');
    writeFileSync(shaderPath, shader);
    const result = spawnSync(
      values.compiler,
      [
        '-std=310es',
        '--target-env=opengl',
        '-fauto-map-locations',
        '-fauto-bind-uniforms',
        shaderPath,
        '-o',
        `${shaderPath}.spv`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`${stage} shader failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    }
    console.log(`[android-gpu-shaders] ${stage}: GLSL ES 3.1 compilation passed`);
  }
} finally {
  rmSync(outputDirectory, { recursive: true });
}
