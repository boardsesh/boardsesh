import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import {
  closeTnutCalibrationSession,
  createTnutCalibrationSession,
  readTnutCalibrationSession,
  subscribeTnutCalibrationSession,
  updateTnutCalibrationSession,
  type TnutCalibrationSession,
} from '../tnut-calibration-session';

const openSessions = new Set<string>();
const subscriptions = new Set<() => void>();

function snapshot(): TnutCalibrationSession {
  return {
    viewerId: 'viewer-one',
    photoUri: 'file:///private/wall-photo.jpg',
    source: {
      layoutId: 12,
      versionId: 34,
      photoUrl: 'https://example.invalid/private-photo?signature=secret',
      photoExpiresAt: '2030-01-01T00:00:00Z',
      photo: { width: 1000, height: 1500 },
      frame: { width: 800, height: 1200 },
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      holds: [],
    },
    quad: [
      [80, 120],
      [720, 120],
      [720, 1080],
      [80, 1080],
    ],
    grid: { pattern: 'grid', rows: 8, columns: 8, firstRowOffset: false },
  };
}

function open(initial = snapshot(), onChange = vi.fn(), onClose = vi.fn()) {
  const id = createTnutCalibrationSession(initial, onChange, onClose);
  openSessions.add(id);
  return { id, onChange, onClose };
}

function subscribe(listener: () => void) {
  const unsubscribe = subscribeTnutCalibrationSession(listener);
  subscriptions.add(unsubscribe);
  return unsubscribe;
}

afterEach(() => {
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions.clear();
  for (const id of openSessions) closeTnutCalibrationSession(id);
  openSessions.clear();
});

describe('fullscreen T-nut calibration handoff', () => {
  it('uses distinct opaque handles and keeps the source photo and transform in memory', () => {
    const initial = snapshot();
    const first = open(initial);
    const second = open({ ...snapshot(), viewerId: 'viewer-two' });
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toContain('private');
    expect(first.id).not.toContain('signature');
    expect(readTnutCalibrationSession(first.id)).toEqual(initial);
    expect(readTnutCalibrationSession(second.id)?.viewerId).toBe('viewer-two');
    expect(readTnutCalibrationSession('missing')).toBeNull();
  });

  it('keeps snapshots stable between changes and detaches the opening corners', () => {
    const initial = snapshot();
    const { id } = open(initial);
    const stored = readTnutCalibrationSession(id);
    expect(readTnutCalibrationSession(id)).toBe(stored);
    initial.quad[0][0] = 700;
    expect(stored?.quad[0][0]).toBe(80);
  });

  it('publishes released corners to the owner without sharing mutable arrays', () => {
    const onChange = vi.fn((quad: Quad) => {
      quad[1][0] = 400;
    });
    const { id } = open(snapshot(), onChange);
    const before = readTnutCalibrationSession(id);
    const listener = vi.fn();
    subscribe(listener);
    const moved: Quad = [
      [100, 160],
      [710, 130],
      [720, 1080],
      [80, 1080],
    ];
    updateTnutCalibrationSession(id, moved);
    const after = readTnutCalibrationSession(id);
    expect(after).not.toBe(before);
    expect(after?.quad).toEqual(moved);
    expect(before?.quad[0]).toEqual([80, 120]);
    expect(onChange).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    moved[0][0] = 600;
    expect(after?.quad[0][0]).toBe(100);
    expect(after?.quad[1][0]).toBe(710);
  });

  it('closes once, removes private state before notifying the owner and ignores late gestures', () => {
    const { id, onChange, onClose } = open();
    const listener = vi.fn();
    subscribe(listener);
    onClose.mockImplementation(() => expect(readTnutCalibrationSession(id)).toBeNull());
    closeTnutCalibrationSession(id);
    closeTnutCalibrationSession(id);
    updateTnutCalibrationSession(id, snapshot().quad);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(readTnutCalibrationSession(id)).toBeNull();
  });

  it('isolates sessions and stops notifications when a route unsubscribes', () => {
    const first = open();
    const second = open();
    const secondSnapshot = readTnutCalibrationSession(second.id);
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    unsubscribe();
    updateTnutCalibrationSession(first.id, snapshot().quad);
    closeTnutCalibrationSession(first.id);
    expect(readTnutCalibrationSession(second.id)).toBe(secondSnapshot);
    expect(second.onChange).not.toHaveBeenCalled();
    expect(second.onClose).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
