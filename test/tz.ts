/**
 * Run `fn` with the process in another time zone. Node reads `process.env.TZ`
 * again on each local-time call, so the zone takes effect at once; the
 * previous value is restored (or deleted when it was unset) afterwards.
 */
export function withTz<T>(zone: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

/** A stored UTC time as it is: what a tool must not print outside a UTC zone. */
export const UTC_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/;
