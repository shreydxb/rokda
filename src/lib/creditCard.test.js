import { describe, it, expect } from 'vitest';
import { ordinal } from './creditCard';

describe('ordinal', () => {
  it('says a due day the way people do, the teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
  });
});
