import { describe, expect, it } from 'vite-plus/test';
import { deriveBoardConnection } from '../services/apns/board-connection';

describe('deriveBoardConnection', () => {
  describe('no holder (board free)', () => {
    it('is disconnected for an attributed token when nobody holds the board', () => {
      expect(deriveBoardConnection({ tokenUserId: 'alice', holderUserId: null, holderDisplayName: null })).toEqual({
        boardConnection: 'disconnected',
      });
    });

    it('is disconnected for an unattributed token when nobody holds the board', () => {
      expect(deriveBoardConnection({ tokenUserId: null, holderUserId: null, holderDisplayName: null })).toEqual({
        boardConnection: 'disconnected',
      });
    });

    it('ignores a stray display name when there is no holder', () => {
      expect(deriveBoardConnection({ tokenUserId: 'alice', holderUserId: null, holderDisplayName: 'Bob' })).toEqual({
        boardConnection: 'disconnected',
      });
    });
  });

  describe('this token holds the board (connectedByMe)', () => {
    it('is connectedByMe when the holder is the token user', () => {
      expect(deriveBoardConnection({ tokenUserId: 'alice', holderUserId: 'alice', holderDisplayName: null })).toEqual({
        boardConnection: 'connectedByMe',
      });
    });

    it('does not leak a holder display name onto the holder’s own device', () => {
      expect(
        deriveBoardConnection({ tokenUserId: 'alice', holderUserId: 'alice', holderDisplayName: 'Alice' }),
      ).toEqual({ boardConnection: 'connectedByMe' });
    });
  });

  describe('a peer holds the board (heldByPeer)', () => {
    it('is heldByPeer with the holder name when a different user holds the board', () => {
      expect(deriveBoardConnection({ tokenUserId: 'alice', holderUserId: 'bob', holderDisplayName: 'Bob' })).toEqual({
        boardConnection: 'heldByPeer',
        holderDisplayName: 'Bob',
      });
    });

    it('omits holderDisplayName when a peer holds the board but no name is known', () => {
      expect(deriveBoardConnection({ tokenUserId: 'alice', holderUserId: 'bob', holderDisplayName: null })).toEqual({
        boardConnection: 'heldByPeer',
      });
    });

    it('treats an unattributed token against a known holder as heldByPeer', () => {
      // A token with no userId can never be the holder (the holder always has a
      // userId here), so it sees the board as held by that peer.
      expect(deriveBoardConnection({ tokenUserId: null, holderUserId: 'bob', holderDisplayName: 'Bob' })).toEqual({
        boardConnection: 'heldByPeer',
        holderDisplayName: 'Bob',
      });
    });

    it('omits an empty-string holder name rather than emitting a blank label', () => {
      expect(deriveBoardConnection({ tokenUserId: 'alice', holderUserId: 'bob', holderDisplayName: '' })).toEqual({
        boardConnection: 'heldByPeer',
      });
    });
  });
});
