import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface SourcePointer {
  sha256: string;
  gitBlob: string;
}
export interface SourceRange {
  start: number;
  end: number;
}
export interface ReleasedClient {
  tag: string;
  platform: 'android' | 'ios';
  version: string;
  commit: string;
  modules: Record<string, SourcePointer>;
  evidence: {
    providerPath: string;
    callbacks: Record<string, SourceRange>;
    connectionPath: string;
    clearFunction?: SourceRange;
    clearTables?: SourceRange;
    checkpointPath?: string;
    clearCheckpointFunction?: SourceRange;
  };
}
export interface GarminRecording {
  name: string;
  commit: string;
  modules: Record<string, SourcePointer>;
}
interface Recordings {
  version: number;
  evidence: string;
  releases: ReleasedClient[];
  garmin: GarminRecording[];
}
const sourcePointerSchema = z
  .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), gitBlob: z.string().regex(/^[a-f0-9]{40}$/) })
  .strict();
const sourceRangeSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
  .strict()
  .refine((range) => range.end > range.start);
const modulesSchema = z.record(z.string(), sourcePointerSchema);
const recordingsSchema = z
  .object({
    version: z.literal(1),
    evidence: z.literal('git-source-only; installs and OTA coverage unproven'),
    releases: z.array(
      z
        .object({
          tag: z.string().regex(/^release\/(android|ios)-v\d+\.\d+\.\d+-[a-f0-9]+$/),
          platform: z.enum(['android', 'ios']),
          version: z.string(),
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          modules: modulesSchema,
          evidence: z
            .object({
              providerPath: z.string(),
              callbacks: z.record(z.string(), sourceRangeSchema),
              connectionPath: z.string(),
              clearFunction: sourceRangeSchema.optional(),
              clearTables: sourceRangeSchema.optional(),
              checkpointPath: z.string().optional(),
              clearCheckpointFunction: sourceRangeSchema.optional(),
            })
            .strict(),
        })
        .strict(),
    ),
    garmin: z.array(
      z.object({ name: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/), modules: modulesSchema }).strict(),
    ),
  })
  .strict();
export const recordings: Recordings = recordingsSchema.parse(
  JSON.parse(readFileSync(new URL('./fixtures/releases.json', import.meta.url), 'utf8')) as unknown,
);

export function recordedSource(recording: { modules: Record<string, SourcePointer> }, path: string): string {
  const pointer = recording.modules[path];
  if (!pointer || !/^[a-f0-9]{64}$/.test(pointer.sha256) || !/^[a-f0-9]{40}$/.test(pointer.gitBlob)) {
    throw new Error('Released source provenance unavailable');
  }
  const source = readFileSync(new URL(`./fixtures/sources/${pointer.sha256}.txt`, import.meta.url), 'utf8');
  const gitBlob = createHash('sha1')
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest('hex');
  if (createHash('sha256').update(source).digest('hex') !== pointer.sha256 || gitBlob !== pointer.gitBlob) {
    throw new Error('Released source integrity check failed');
  }
  return source;
}
