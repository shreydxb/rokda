// Synced copy of src/lib/pagedRead.js -- see scope.js in this same directory for
// why. The bot reads whole histories the same way the screens do.
//
// Reading a whole table through the Supabase API (docs/decisions.md, "A
// screen reads every row, a page at a time").
//
// The API returns at most 1,000 rows per request and says nothing when it
// stops there: the response looks complete. Screens read whole tables, so a
// household past 1,000 transactions, or 1,000 days of holding prices, would
// silently lose its oldest spending or its newest prices. This reads page
// after page until a short one comes back. The query must have a total order
// (end with a unique column such as id), or rows can repeat or go missing
// between pages.
export const PAGE_SIZE = 1000;

/**
 * @param {() => { range: (from: number, to: number) => PromiseLike<{ data: any[] | null, error: any }> }} makeQuery
 * @param {number} [pageSize]
 */
export async function readAllPages(makeQuery, pageSize = PAGE_SIZE) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
}
