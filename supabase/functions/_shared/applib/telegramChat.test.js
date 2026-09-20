import { describe, expect, it } from 'vitest';
import { isPrivateChat } from './telegramChat.js';

describe('the bot answers only in a private chat', () => {
  it('allows a direct message', () => {
    expect(isPrivateChat({ id: 42, type: 'private' })).toBe(true);
  });

  it('refuses every kind of group, which is where a /brief would be published', () => {
    for (const type of ['group', 'supergroup', 'channel']) {
      expect(isPrivateChat({ id: -100, type })).toBe(false);
    }
  });

  it('fails closed on a chat with no type, or no chat at all', () => {
    expect(isPrivateChat({ id: 42 })).toBe(false);
    expect(isPrivateChat({ id: 42, type: 'Private' })).toBe(false);
    expect(isPrivateChat(undefined)).toBe(false);
    expect(isPrivateChat(null)).toBe(false);
  });
});
