/**
 * Fetches until `isDone(value)` or the attempts run out, then returns the last value. Used after "End call":
 * the server closes a call in a moment, and the result screen should show the finished state, not the ending one.
 * @template T
 * @param {() => Promise<T>} fetchValue
 * @param {(value: T) => boolean} isDone
 * @param {{attempts?: number, delayMs?: number}} [options]
 */
export async function fetchUntil(fetchValue, isDone, { attempts = 30, delayMs = 1000 } = {}) {
  let value = await fetchValue();
  for (let attempt = 1; attempt < attempts && !isDone(value); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    value = await fetchValue();
  }
  return value;
}
