/** Preserve input order and drain all started work before propagating a failure. */
export async function boundedMap<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          signal?.throwIfAborted();
          results[index] = await run(items[index]);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  if (failed) throw failure;
  signal?.throwIfAborted();
  return results;
}
