import { describe, expect, it } from 'vite-plus/test';
import { isRoutableSetterUsername } from '../setter-username';

/** One character by code point, so the test source holds no invisible characters. */
const character = (codePoint: number) => String.fromCharCode(codePoint);

/** The cases `routableUsername` in `sitemap/setter-query.ts` documents, one per rule. */
describe('isRoutableSetterUsername', () => {
  it.each(['marco', 'BKBChicago', 'Jo & Ann 50%', 'José', '设定者', 'a.b', '...'])('accepts %j', (username) => {
    expect(isRoutableSetterUsername(username)).toBe(true);
  });

  it.each([
    ['an empty name', ''],
    ['a leading space', ' marco'],
    ['a trailing tab', 'marco\t'],
    ['a slash', 'jo/ann'],
    ['a question mark', 'jo?ann'],
    ['a hash', 'jo#ann'],
    ['a C0 control character', `jo${character(0x07)}ann`],
    ['DEL', `jo${character(0x7f)}ann`],
    ['a C1 control character', `jo${character(0x85)}ann`],
    ['a non-breaking space', `${character(0xa0)}marco`],
    ['a zero-width space', `mar${character(0x200b)}co`],
    ['a byte-order mark', `marco${character(0xfeff)}`],
    ['a lone dot', '.'],
    ['two dots', '..'],
    ['a lone surrogate', `mar${character(0xd800)}co`],
  ])('rejects %s', (_label, username) => {
    expect(isRoutableSetterUsername(username)).toBe(false);
  });
});
