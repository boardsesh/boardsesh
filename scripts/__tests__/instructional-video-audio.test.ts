import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveMediaBinary } from '../lib/help-clips';
import { mixTutorialAudio, tutorialVoice } from '../lib/instructional-video/media';
import type { TutorialCut } from '../lib/instructional-video/timeline';

const execute = promisify(execFile);
const ffmpeg = resolveMediaBinary('ffmpeg');
const ffprobe = resolveMediaBinary('ffprobe');
const hasMediaTools = existsSync(ffmpeg) && existsSync(ffprobe);

function toneAmplitude(pcm: Buffer, frequency: number, fromSecond: number): number {
  const sampleRate = 48000;
  let cosine = 0;
  let sine = 0;
  for (let frame = 0; frame < sampleRate; frame += 1) {
    const sample = pcm.readFloatLE((Math.floor(fromSecond * sampleRate) + frame) * 8);
    const phase = (2 * Math.PI * frequency * frame) / sampleRate;
    cosine += sample * Math.cos(phase);
    sine += sample * Math.sin(phase);
  }
  return (2 * Math.hypot(cosine, sine)) / sampleRate;
}

describe('tutorial audio FFmpeg integration', () => {
  it.skipIf(!hasMediaTools)(
    'keeps the full cut, positions narration, and ducks supplied music only during narration',
    async () => {
      // Test tones live only in ignored diagnostic outputs, never the episode audio directory.
      const parent = resolve('.boardsesh/tutorial-videos/audio-tests');
      await mkdir(parent, { recursive: true });
      const directory = await mkdtemp(resolve(parent, 'ffmpeg-'));
      const voicePath = resolve(directory, 'test-voice-tone.wav');
      const musicPath = resolve(directory, 'test-music-tone.wav');
      const output = resolve(directory, 'test-mix.m4a');
      await execute(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=2',
        '-af',
        'volume=4',
        '-c:a',
        'pcm_s16le',
        voicePath,
      ]);
      await execute(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=3000:sample_rate=48000:duration=8',
        '-af',
        'volume=3',
        '-c:a',
        'pcm_s16le',
        musicPath,
      ]);
      const voice = await tutorialVoice(voicePath);
      const cut: TutorialCut = {
        id: 'test-only',
        kind: 'chapter',
        title: 'Test tones',
        introFrames: 90,
        outroFrames: 90,
        totalFrames: 240,
        beats: [
          {
            id: 'test-tone',
            title: 'Test tone',
            narration: 'Test tone',
            seconds: 2,
            takeId: 'test',
            fromMark: 'test',
            label: 'Test',
            chapterId: 'test',
            chapterTitle: 'Test',
            startFrame: 90,
            frames: 60,
            voice,
          },
        ],
      };
      await mixTutorialAudio(cut, musicPath, output, false);
      const { stdout } = await execute(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_name,sample_rate,channels',
        '-of',
        'json',
        output,
      ]);
      const metadata = JSON.parse(stdout) as {
        format: { duration: string };
        streams: { codec_name: string; sample_rate: string; channels: number }[];
      };
      expect(metadata.streams[0]).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
      expect(Number(metadata.format.duration)).toBeCloseTo(8, 1);
      const pcmPath = resolve(directory, 'test-mix.pcm');
      await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', output, '-f', 'f32le', pcmPath]);
      const pcm = await readFile(pcmPath);
      const musicBefore = toneAmplitude(pcm, 3000, 1);
      const musicDuring = toneAmplitude(pcm, 3000, 3.5);
      const musicAfter = toneAmplitude(pcm, 3000, 5.5);
      expect(musicBefore).toBeGreaterThan(0.01);
      expect(musicDuring / musicBefore).toBeGreaterThan(0.15);
      expect(musicDuring / musicBefore).toBeLessThan(0.4);
      expect(musicAfter / musicBefore).toBeGreaterThan(0.9);
      expect(toneAmplitude(pcm, 440, 1)).toBeLessThan(0.001);
      expect(toneAmplitude(pcm, 440, 3.5)).toBeGreaterThan(0.01);
      expect(toneAmplitude(pcm, 440, 5.5)).toBeLessThan(0.001);
    },
    30_000,
  );
});
