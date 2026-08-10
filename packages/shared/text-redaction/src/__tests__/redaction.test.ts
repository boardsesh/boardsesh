import { describe, expect, it } from 'vitest';

import { redactSensitiveText, stripDiscordMentions } from '../index';

describe('redactSensitiveText', () => {
  it('removes emails, labelled names, self-introductions, and local usernames', () => {
    const redacted = redactSensitiveText(
      'name: Marco\ntester=Jane\nMy name is Alex Smith\n/Users/marco/Library\nmarco@example.com',
    );

    expect(redacted).not.toContain('Marco');
    expect(redacted).not.toContain('Jane');
    expect(redacted).not.toContain('Alex Smith');
    expect(redacted).not.toContain('marco@example.com');
    expect(redacted).toContain('[redacted email]');
    expect(redacted).toContain('/Users/[redacted]/Library');
  });

  it('redacts emails and home paths', () => {
    expect(redactSensitiveText('mail me at a@b.com')).toContain('[redacted email]');
    expect(redactSensitiveText('crash in /Users/marco/app')).toContain('/Users/[redacted]');
  });

  it('redacts Linux home paths as well as macOS ones', () => {
    const redacted = redactSensitiveText('stack trace at /home/marco/projects/boardsesh/index.ts');
    expect(redacted).toContain('/home/[redacted]/projects');
    expect(redacted).not.toContain('/home/marco');
  });

  it('leaves non-home absolute paths alone', () => {
    expect(redactSensitiveText('config at /etc/hosts')).toBe('config at /etc/hosts');
  });

  it('leaves text without PII untouched', () => {
    const clean = 'The queue empties when I background the app on Android.';
    expect(redactSensitiveText(clean)).toBe(clean);
  });
});

describe('stripDiscordMentions', () => {
  it('replaces user, nickname, role, and channel mentions', () => {
    const stripped = stripDiscordMentions(
      'hey <@123456789012345678> and <@!234567890123456789>, ping <@&345678901234567890> in <#456789012345678901>',
    );

    expect(stripped).toBe('hey @someone and @someone, ping @role in #channel');
  });

  it('publishes no snowflake ids', () => {
    const stripped = stripDiscordMentions('<@123456789012345678> saw it too');
    expect(stripped).not.toContain('123456789012345678');
  });

  it('leaves plain text and short numeric spans alone', () => {
    expect(stripDiscordMentions('angle <40> degrees')).toBe('angle <40> degrees');
    expect(stripDiscordMentions('no mentions here')).toBe('no mentions here');
  });
});
