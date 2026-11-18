import { describe, expect, it } from 'vite-plus/test';
import { createTranslationMatcher, flattenTranslations, preservesTranslationFormat } from '../dev-editor';

describe('dev translation formatting protection', () => {
  it('allows rewording and variable reordering within the same formatting region', () => {
    expect(preservesTranslationFormat('Hello {{first}} {{last}}', '{{last}}, {{first}}: welcome')).toBe(true);
    expect(
      preservesTranslationFormat('<0>Read {{count, number}}</0>\nMore', '<0>{{count, number}} articles</0>\nNext'),
    ).toBe(true);
  });

  it.each([
    ['Hello {{name}}', 'Hello'],
    ['Hello {{name}}', 'Hello {{other}}'],
    ['{{count, number}} sends', '{{count}} sends'],
    ['<link href="/terms">Terms</link>', '<link href="https://evil.test">Terms</link>'],
    ['<0><strong>Text</strong></0>', '<strong><0>Text</0></strong>'],
    ['<0>{{name}}</0> profile', '<0>Profile</0> {{name}}'],
    ['Hello\n{{name}}', '{{name}}\nHello'],
    ['First\nSecond', 'First Second'],
    ['Hello', '<script>alert(1)</script>'],
    ['Hello', 'Hello {{name'],
    ['Hello', 'Hello <strong'],
    ['Hello', '   '],
    ['$t(common:hello)', '$t(common:other)'],
  ])('rejects unsafe edit %j → %j', (original, replacement) => {
    expect(preservesTranslationFormat(original, replacement)).toBe(false);
  });
});

describe('translation discovery without modifying page markup', () => {
  it('keeps ambiguous keys and handles markup, whitespace and interpolation', () => {
    const entries = [
      { namespace: 'common', key: 'save', text: 'Save' },
      { namespace: 'settings', key: 'save', text: 'Save' },
      { namespace: 'marketing', key: 'welcome', text: 'Hello <strong>{{name}}</strong>!' },
      { namespace: 'common', key: 'user', text: '{{name}}' },
    ];
    const match = createTranslationMatcher(entries);
    expect(match(' Save ')).toEqual(entries.slice(0, 2));
    expect(match('Hello\nSarah!')).toEqual([entries[2]]);
    expect(match('User-generated text')).toEqual([]);
  });

  it('treats regex metacharacters literally and retains ambiguous interpolations', () => {
    const entries = [
      { namespace: 'common', key: 'formatted', text: 'V{{grade}} ({{count}})' },
      { namespace: 'common', key: 'plain', text: 'V4 (3)' },
    ];
    const match = createTranslationMatcher(entries);
    expect(match('V5 (2)')).toEqual([entries[0]]);
    expect(match('V5 anything')).toEqual([]);
    expect(match('V4 (3)')).toEqual([entries[1], entries[0]]);
  });

  it('flattens nested objects and string array leaves', () => {
    expect(flattenTranslations({ loading: { messages: ['First', 'Second'] }, count: 2 })).toEqual([
      { key: 'loading.messages.0', text: 'First' },
      { key: 'loading.messages.1', text: 'Second' },
    ]);
  });
});
