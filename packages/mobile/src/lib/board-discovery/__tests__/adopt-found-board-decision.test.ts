import { describe, expect, it } from 'vitest';
import { decideAdoptFoundBoard, type AdoptFoundBoardParams } from '../adopt-found-board-decision';

const base: AdoptFoundBoardParams = {
  isOwned: false,
  isFollowedByMe: false,
  offlineEnabled: false,
  autoOffline: false,
  alreadyEnabledOffline: false,
};

describe('decideAdoptFoundBoard', () => {
  describe('follow', () => {
    it('follows a board that is new to the user (not owned, not followed)', () => {
      expect(decideAdoptFoundBoard(base).follow).toBe(true);
    });

    it('does not follow a board the user already follows', () => {
      expect(decideAdoptFoundBoard({ ...base, isFollowedByMe: true }).follow).toBe(false);
    });

    it('does not follow a board the user owns', () => {
      expect(decideAdoptFoundBoard({ ...base, isOwned: true }).follow).toBe(false);
    });
  });

  describe('offline offer', () => {
    it('does nothing about offline when the feature flag is off', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: false }).offline).toBe('none');
    });

    it('asks for a freshly-found board when the flag is on and auto-offline is off', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: true }).offline).toBe('ask');
    });

    it('auto-downloads a freshly-found board when auto-offline is on', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: true, autoOffline: true }).offline).toBe('auto');
    });

    it('never asks when the board is already enabled for offline', () => {
      expect(decideAdoptFoundBoard({ ...base, offlineEnabled: true, alreadyEnabledOffline: true }).offline).toBe(
        'none',
      );
    });

    it('does not nag when re-selecting an already-followed board (auto-offline off)', () => {
      expect(decideAdoptFoundBoard({ ...base, isFollowedByMe: true, offlineEnabled: true }).offline).toBe('none');
    });

    it('auto-downloads an already-followed board when auto-offline is on and it is not enabled yet', () => {
      const decision = decideAdoptFoundBoard({
        ...base,
        isFollowedByMe: true,
        offlineEnabled: true,
        autoOffline: true,
      });
      expect(decision.follow).toBe(false);
      expect(decision.offline).toBe('auto');
    });
  });
});
