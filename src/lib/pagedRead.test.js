import { describe, expect, it } from 'vitest';
import { readAllPages } from './pagedRead';

// A table of `total` rows served `cap` at a time, like the API's max_rows.
function table(total, { failOnPage = null } = {}) {
  const calls = [];
  const makeQuery = () => ({
    range(from, to) {
      calls.push([from, to]);
      if (failOnPage != null && calls.length - 1 === failOnPage) return Promise.resolve({ data: null, error: { message: 'timeout' } });
      const rows = [];
      for (let i = from; i <= to && i < total; i++) rows.push({ id: i });
      return Promise.resolve({ data: rows, error: null });
    },
  });
  return { makeQuery, calls };
}

describe('readAllPages', () => {
  it('reads past the per-request cap until a short page comes back', async () => {
    const { makeQuery, calls } = table(2500);
    const { data, error } = await readAllPages(makeQuery, 1000);
    expect(error).toBeNull();
    expect(data).toHaveLength(2500);
    expect(data.at(-1)).toEqual({ id: 2499 });
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('asks once more when the last page is exactly full', async () => {
    const { makeQuery, calls } = table(2000);
    const { data } = await readAllPages(makeQuery, 1000);
    expect(data).toHaveLength(2000);
    expect(calls).toHaveLength(3);
  });

  it('reads a small table in one request', async () => {
    const { makeQuery, calls } = table(3);
    expect((await readAllPages(makeQuery, 1000)).data).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it('reports a failed page as a failed read, not a shorter list', async () => {
    const { makeQuery } = table(2500, { failOnPage: 1 });
    const result = await readAllPages(makeQuery, 1000);
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: 'timeout' });
  });
});
