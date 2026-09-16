import { describe, expect, it } from 'vitest';
import { lockedConfigReason } from '../locked-config-reason';

describe('lockedConfigReason', () => {
  it('leaves an editable catalogue board unlocked', () => {
    expect(lockedConfigReason({ boardType: 'kilter', canEdit: true })).toBeNull();
  });

  it('blames permission on a catalogue board the viewer may not edit', () => {
    expect(lockedConfigReason({ boardType: 'kilter', canEdit: false })).toBe('permission');
  });

  // The P2 this rule exists for: a wall is locked for its own owner, and the
  // permission sentence would be false twice over — they have every permission
  // there is, and there is no layout to change.
  it('blames the photograph on a wall the viewer owns', () => {
    expect(lockedConfigReason({ boardType: 'spray', canEdit: true })).toBe('spray');
  });

  // Both reasons hold here and only one is actionable: "shoot the wall again" is
  // advice for the owner, not for a climber who merely follows the wall.
  it('blames permission on a wall the viewer may not edit', () => {
    expect(lockedConfigReason({ boardType: 'spray', canEdit: false })).toBe('permission');
  });

  // `canEdit` is optional on UserBoard — an offline snapshot carries no answer —
  // and unknown has always read as locked.
  it('blames permission when edit access is unknown', () => {
    expect(lockedConfigReason({ boardType: 'spray' })).toBe('permission');
    expect(lockedConfigReason({ boardType: 'kilter' })).toBe('permission');
  });

  it('does not mistake an unknown board string for a wall', () => {
    expect(lockedConfigReason({ boardType: 'sprayy', canEdit: true })).toBeNull();
  });
});
