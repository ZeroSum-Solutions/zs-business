/** Store round trips in flight at once for one release: enough to hide latency, not a flood. */
export const STORE_CONCURRENCY = 12;

/** Run `work` over every item with at most `limit` in flight. Rejects with the first error. */
export async function forEachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
