import { describe, it, expect } from 'vite-plus/test';
import { generateSetNameSlug, generateSetSlug } from '@boardsesh/play-view/readable-url-utils';
import { matchSetNameToSlugParts } from '../slug-matching';

describe('matchSetNameToSlugParts', () => {
  describe('homewall sets - full names (Auxiliary/Mainline)', () => {
    describe('Auxiliary Kickboard', () => {
      it('should match aux-kicker slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', ['aux-kicker'])).toBe(true);
      });

      it('should NOT match aux slug (kickboard sets only match -kicker)', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', ['aux'])).toBe(false);
      });

      it('should NOT match main-kicker slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', ['main-kicker'])).toBe(false);
      });

      it('should NOT match main slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', ['main'])).toBe(false);
      });
    });

    describe('Mainline Kickboard', () => {
      it('should match main-kicker slug', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', ['main-kicker'])).toBe(true);
      });

      it('should NOT match main slug (kickboard sets only match -kicker)', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', ['main'])).toBe(false);
      });

      it('should NOT match aux-kicker slug', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', ['aux-kicker'])).toBe(false);
      });

      it('should NOT match aux slug', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', ['aux'])).toBe(false);
      });
    });

    describe('Auxiliary (standalone)', () => {
      it('should match aux slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary', ['aux'])).toBe(true);
      });

      it('should NOT match aux-kicker slug (non-kickboard sets only match plain slug)', () => {
        expect(matchSetNameToSlugParts('Auxiliary', ['aux-kicker'])).toBe(false);
      });

      it('should NOT match main slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary', ['main'])).toBe(false);
      });

      it('should NOT match main-kicker slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary', ['main-kicker'])).toBe(false);
      });
    });

    describe('Mainline (standalone)', () => {
      it('should match main slug', () => {
        expect(matchSetNameToSlugParts('Mainline', ['main'])).toBe(true);
      });

      it('should NOT match main-kicker slug (non-kickboard sets only match plain slug)', () => {
        expect(matchSetNameToSlugParts('Mainline', ['main-kicker'])).toBe(false);
      });

      it('should NOT match aux slug', () => {
        expect(matchSetNameToSlugParts('Mainline', ['aux'])).toBe(false);
      });

      it('should NOT match aux-kicker slug', () => {
        expect(matchSetNameToSlugParts('Mainline', ['aux-kicker'])).toBe(false);
      });
    });
  });

  describe('homewall sets - abbreviated names (Aux/Main)', () => {
    describe('Aux Kickboard', () => {
      it('should match aux-kicker slug', () => {
        expect(matchSetNameToSlugParts('Aux Kickboard', ['aux-kicker'])).toBe(true);
      });

      it('should NOT match aux slug', () => {
        expect(matchSetNameToSlugParts('Aux Kickboard', ['aux'])).toBe(false);
      });
    });

    describe('Main Kickboard', () => {
      it('should match main-kicker slug', () => {
        expect(matchSetNameToSlugParts('Main Kickboard', ['main-kicker'])).toBe(true);
      });

      it('should NOT match main slug', () => {
        expect(matchSetNameToSlugParts('Main Kickboard', ['main'])).toBe(false);
      });
    });

    describe('Aux (standalone)', () => {
      it('should match aux slug', () => {
        expect(matchSetNameToSlugParts('Aux', ['aux'])).toBe(true);
      });

      it('should NOT match aux-kicker slug', () => {
        expect(matchSetNameToSlugParts('Aux', ['aux-kicker'])).toBe(false);
      });
    });

    describe('Main (standalone)', () => {
      it('should match main slug', () => {
        expect(matchSetNameToSlugParts('Main', ['main'])).toBe(true);
      });

      it('should NOT match main-kicker slug', () => {
        expect(matchSetNameToSlugParts('Main', ['main-kicker'])).toBe(false);
      });
    });
  });

  describe('homewall sets - "kicker" naming variant (used in some sizes like 10x12)', () => {
    describe('Aux Kicker (without "board")', () => {
      it('should match aux-kicker slug', () => {
        expect(matchSetNameToSlugParts('Aux Kicker', ['aux-kicker'])).toBe(true);
      });

      it('should NOT match aux slug', () => {
        expect(matchSetNameToSlugParts('Aux Kicker', ['aux'])).toBe(false);
      });
    });

    describe('Main Kicker (without "board")', () => {
      it('should match main-kicker slug', () => {
        expect(matchSetNameToSlugParts('Main Kicker', ['main-kicker'])).toBe(true);
      });

      it('should NOT match main slug', () => {
        expect(matchSetNameToSlugParts('Main Kicker', ['main'])).toBe(false);
      });
    });

    describe('Auxiliary Kicker (full name without "board")', () => {
      it('should match aux-kicker slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kicker', ['aux-kicker'])).toBe(true);
      });

      it('should NOT match aux slug', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kicker', ['aux'])).toBe(false);
      });
    });

    describe('Mainline Kicker (full name without "board")', () => {
      it('should match main-kicker slug', () => {
        expect(matchSetNameToSlugParts('Mainline Kicker', ['main-kicker'])).toBe(true);
      });

      it('should NOT match main slug', () => {
        expect(matchSetNameToSlugParts('Mainline Kicker', ['main'])).toBe(false);
      });
    });

    describe('10x12 full ride with kicker naming', () => {
      const fullRideSlugParts = ['main-kicker', 'main', 'aux-kicker', 'aux'];

      it('should match Aux Kicker to aux-kicker', () => {
        expect(matchSetNameToSlugParts('Aux Kicker', fullRideSlugParts)).toBe(true);
      });

      it('should match Main Kicker to main-kicker', () => {
        expect(matchSetNameToSlugParts('Main Kicker', fullRideSlugParts)).toBe(true);
      });

      it('should match Aux to aux', () => {
        expect(matchSetNameToSlugParts('Aux', fullRideSlugParts)).toBe(true);
      });

      it('should match Main to main', () => {
        expect(matchSetNameToSlugParts('Main', fullRideSlugParts)).toBe(true);
      });
    });
  });

  describe('homewall full ride - all four sets with full slug', () => {
    const fullRideSlugParts = ['main-kicker', 'main', 'aux-kicker', 'aux'];

    it('should match Auxiliary Kickboard to aux-kicker', () => {
      expect(matchSetNameToSlugParts('Auxiliary Kickboard', fullRideSlugParts)).toBe(true);
    });

    it('should match Mainline Kickboard to main-kicker', () => {
      expect(matchSetNameToSlugParts('Mainline Kickboard', fullRideSlugParts)).toBe(true);
    });

    it('should match Auxiliary to aux', () => {
      expect(matchSetNameToSlugParts('Auxiliary', fullRideSlugParts)).toBe(true);
    });

    it('should match Mainline to main', () => {
      expect(matchSetNameToSlugParts('Mainline', fullRideSlugParts)).toBe(true);
    });

    it('should match Aux Kickboard to aux-kicker', () => {
      expect(matchSetNameToSlugParts('Aux Kickboard', fullRideSlugParts)).toBe(true);
    });

    it('should match Main Kickboard to main-kicker', () => {
      expect(matchSetNameToSlugParts('Main Kickboard', fullRideSlugParts)).toBe(true);
    });

    it('should match Aux to aux', () => {
      expect(matchSetNameToSlugParts('Aux', fullRideSlugParts)).toBe(true);
    });

    it('should match Main to main', () => {
      expect(matchSetNameToSlugParts('Main', fullRideSlugParts)).toBe(true);
    });
  });

  describe('homewall partial selections - critical bug fix scenarios', () => {
    describe('selecting only aux (not aux-kicker)', () => {
      const slugParts = ['aux'];

      it('should match Auxiliary', () => {
        expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(true);
      });

      it('should match Aux', () => {
        expect(matchSetNameToSlugParts('Aux', slugParts)).toBe(true);
      });

      it('should NOT match Auxiliary Kickboard', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', slugParts)).toBe(false);
      });

      it('should NOT match Aux Kickboard', () => {
        expect(matchSetNameToSlugParts('Aux Kickboard', slugParts)).toBe(false);
      });
    });

    describe('selecting only main (not main-kicker)', () => {
      const slugParts = ['main'];

      it('should match Mainline', () => {
        expect(matchSetNameToSlugParts('Mainline', slugParts)).toBe(true);
      });

      it('should match Main', () => {
        expect(matchSetNameToSlugParts('Main', slugParts)).toBe(true);
      });

      it('should NOT match Mainline Kickboard', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', slugParts)).toBe(false);
      });

      it('should NOT match Main Kickboard', () => {
        expect(matchSetNameToSlugParts('Main Kickboard', slugParts)).toBe(false);
      });
    });

    describe('selecting only aux-kicker (not aux)', () => {
      const slugParts = ['aux-kicker'];

      it('should match Auxiliary Kickboard', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', slugParts)).toBe(true);
      });

      it('should match Aux Kickboard', () => {
        expect(matchSetNameToSlugParts('Aux Kickboard', slugParts)).toBe(true);
      });

      it('should NOT match Auxiliary', () => {
        expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(false);
      });

      it('should NOT match Aux', () => {
        expect(matchSetNameToSlugParts('Aux', slugParts)).toBe(false);
      });
    });

    describe('selecting only main-kicker (not main)', () => {
      const slugParts = ['main-kicker'];

      it('should match Mainline Kickboard', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', slugParts)).toBe(true);
      });

      it('should match Main Kickboard', () => {
        expect(matchSetNameToSlugParts('Main Kickboard', slugParts)).toBe(true);
      });

      it('should NOT match Mainline', () => {
        expect(matchSetNameToSlugParts('Mainline', slugParts)).toBe(false);
      });

      it('should NOT match Main', () => {
        expect(matchSetNameToSlugParts('Main', slugParts)).toBe(false);
      });
    });

    describe('selecting aux + main-kicker + main (no aux-kicker)', () => {
      const slugParts = ['main-kicker', 'main', 'aux'];

      it('should match Auxiliary', () => {
        expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(true);
      });

      it('should match Mainline Kickboard', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', slugParts)).toBe(true);
      });

      it('should match Mainline', () => {
        expect(matchSetNameToSlugParts('Mainline', slugParts)).toBe(true);
      });

      it('should NOT match Auxiliary Kickboard', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', slugParts)).toBe(false);
      });
    });
  });

  describe('case insensitivity', () => {
    it('should match lowercase auxiliary kickboard', () => {
      expect(matchSetNameToSlugParts('auxiliary kickboard', ['aux-kicker'])).toBe(true);
    });

    it('should match uppercase AUXILIARY KICKBOARD', () => {
      expect(matchSetNameToSlugParts('AUXILIARY KICKBOARD', ['aux-kicker'])).toBe(true);
    });

    it('should match mixed case AuXiLiArY KiCkBoArD', () => {
      expect(matchSetNameToSlugParts('AuXiLiArY KiCkBoArD', ['aux-kicker'])).toBe(true);
    });

    it('should match lowercase aux', () => {
      expect(matchSetNameToSlugParts('aux', ['aux'])).toBe(true);
    });

    it('should match uppercase AUX', () => {
      expect(matchSetNameToSlugParts('AUX', ['aux'])).toBe(true);
    });
  });

  describe('whitespace handling', () => {
    it('should handle leading whitespace', () => {
      expect(matchSetNameToSlugParts('  Auxiliary Kickboard', ['aux-kicker'])).toBe(true);
    });

    it('should handle trailing whitespace', () => {
      expect(matchSetNameToSlugParts('Auxiliary Kickboard  ', ['aux-kicker'])).toBe(true);
    });

    it('should handle both leading and trailing whitespace', () => {
      expect(matchSetNameToSlugParts('  Auxiliary  ', ['aux'])).toBe(true);
    });
  });

  describe('original kilter/tension sets', () => {
    describe('Bolt Ons', () => {
      it('should match bolt slug', () => {
        expect(matchSetNameToSlugParts('Bolt Ons', ['bolt'])).toBe(true);
      });

      it('should NOT match screw slug', () => {
        expect(matchSetNameToSlugParts('Bolt Ons', ['screw'])).toBe(false);
      });
    });

    describe('Screw Ons', () => {
      it('should match screw slug', () => {
        expect(matchSetNameToSlugParts('Screw Ons', ['screw'])).toBe(true);
      });

      it('should NOT match bolt slug', () => {
        expect(matchSetNameToSlugParts('Screw Ons', ['bolt'])).toBe(false);
      });
    });

    describe('bolt and screw together', () => {
      const slugParts = ['screw', 'bolt'];

      it('should match Bolt Ons', () => {
        expect(matchSetNameToSlugParts('Bolt Ons', slugParts)).toBe(true);
      });

      it('should match Screw Ons', () => {
        expect(matchSetNameToSlugParts('Screw Ons', slugParts)).toBe(true);
      });

      it('should match bolt on (singular)', () => {
        expect(matchSetNameToSlugParts('Bolt On', slugParts)).toBe(true);
      });

      it('should match screw on (singular)', () => {
        expect(matchSetNameToSlugParts('Screw On', slugParts)).toBe(true);
      });
    });
  });

  describe('generic set names (fallback matching)', () => {
    it('should match exact slug', () => {
      expect(matchSetNameToSlugParts('Custom Set', ['custom-set'])).toBe(true);
    });

    it('should handle spaces converted to hyphens', () => {
      expect(matchSetNameToSlugParts('My Custom Set', ['my-custom-set'])).toBe(true);
    });

    it('should NOT match partial slugs', () => {
      expect(matchSetNameToSlugParts('Custom Set', ['custom'])).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return false for empty slug parts', () => {
      expect(matchSetNameToSlugParts('Auxiliary', [])).toBe(false);
    });

    it('should return false for unmatched set name', () => {
      expect(matchSetNameToSlugParts('Unknown Set', ['aux', 'main'])).toBe(false);
    });

    it('should handle set names with numbers', () => {
      expect(matchSetNameToSlugParts('Set 1', ['set-1'])).toBe(true);
    });
  });

  describe('mutual exclusivity - ensuring kickboard vs non-kickboard matching', () => {
    describe('aux-kicker slug should ONLY match kickboard sets', () => {
      const slugParts = ['aux-kicker'];

      it('should match Auxiliary Kickboard', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', slugParts)).toBe(true);
      });

      it('should NOT match Auxiliary (no kickboard)', () => {
        expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(false);
      });

      it('should NOT match Aux (no kickboard)', () => {
        expect(matchSetNameToSlugParts('Aux', slugParts)).toBe(false);
      });
    });

    describe('aux slug should ONLY match non-kickboard sets', () => {
      const slugParts = ['aux'];

      it('should match Auxiliary', () => {
        expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(true);
      });

      it('should match Aux', () => {
        expect(matchSetNameToSlugParts('Aux', slugParts)).toBe(true);
      });

      it('should NOT match Auxiliary Kickboard', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', slugParts)).toBe(false);
      });

      it('should NOT match Aux Kickboard', () => {
        expect(matchSetNameToSlugParts('Aux Kickboard', slugParts)).toBe(false);
      });
    });
  });

  describe('real-world URL scenarios', () => {
    describe('URL: main-kicker_main_aux-kicker_aux (full ride)', () => {
      const slugParts = 'main-kicker_main_aux-kicker_aux'.split('_');

      it('should have correct slug parts', () => {
        expect(slugParts).toEqual(['main-kicker', 'main', 'aux-kicker', 'aux']);
      });

      it('should match all four homewall sets', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', slugParts)).toBe(true);
        expect(matchSetNameToSlugParts('Mainline Kickboard', slugParts)).toBe(true);
        expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(true);
        expect(matchSetNameToSlugParts('Mainline', slugParts)).toBe(true);
      });

      it('should match abbreviated variants too', () => {
        expect(matchSetNameToSlugParts('Aux Kickboard', slugParts)).toBe(true);
        expect(matchSetNameToSlugParts('Main Kickboard', slugParts)).toBe(true);
        expect(matchSetNameToSlugParts('Aux', slugParts)).toBe(true);
        expect(matchSetNameToSlugParts('Main', slugParts)).toBe(true);
      });
    });

    describe('URL: main-kicker_main_aux (no aux-kicker)', () => {
      const slugParts = 'main-kicker_main_aux'.split('_');

      it('should match Auxiliary', () => {
        expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(true);
      });

      it('should NOT match Auxiliary Kickboard', () => {
        expect(matchSetNameToSlugParts('Auxiliary Kickboard', slugParts)).toBe(false);
      });

      it('should match Mainline Kickboard', () => {
        expect(matchSetNameToSlugParts('Mainline Kickboard', slugParts)).toBe(true);
      });

      it('should match Mainline', () => {
        expect(matchSetNameToSlugParts('Mainline', slugParts)).toBe(true);
      });
    });

    describe('URL: screw_bolt (original kilter sets)', () => {
      const slugParts = 'screw_bolt'.split('_');

      it('should match Bolt Ons', () => {
        expect(matchSetNameToSlugParts('Bolt Ons', slugParts)).toBe(true);
      });

      it('should match Screw Ons', () => {
        expect(matchSetNameToSlugParts('Screw Ons', slugParts)).toBe(true);
      });
    });
  });

  /**
   * Matching is the inverse of building, and both directions must stay one rule
   * set: web resolves a URL's set slug here, the URL builders (web and the Expo
   * app) emit it with `generateSetNameSlug`. When this file kept its own copy of
   * the aux/main/kicker/bolt/screw heuristics the two agreed by hand — the next
   * tweak to either would have lit different holds on the two hosts.
   */
  describe('delegation to the shared set-name slugger', () => {
    const setNames = [
      'Auxiliary Kickboard',
      'Mainline Kickboard',
      'Auxiliary',
      'Mainline',
      'Aux Kicker',
      'Main Kicker',
      'Aux',
      'Main',
      'Bolt Ons',
      'Screw Ons',
      'Custom Set',
    ];

    it('matches exactly the slug the builder emits for the same name', () => {
      for (const setName of setNames) {
        const emittedSlug = generateSetNameSlug(setName);
        expect(matchSetNameToSlugParts(setName, [emittedSlug])).toBe(true);
        expect(
          matchSetNameToSlugParts(
            setName,
            setNames.map(generateSetNameSlug).filter((s) => s !== emittedSlug),
          ),
        ).toBe(false);
      }
    });

    it('re-selects every set a built set slug was built from', () => {
      const selected = ['Bolt Ons', 'Screw Ons'];
      const slugParts = generateSetSlug(selected).split('_');

      expect(selected.every((setName) => matchSetNameToSlugParts(setName, slugParts))).toBe(true);
      expect(matchSetNameToSlugParts('Auxiliary', slugParts)).toBe(false);
    });
  });
});
