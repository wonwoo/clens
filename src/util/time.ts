/**
 * Times between the index and the agent. The index and the ledger store UTC
 * (`toISOString()`), and SQL compares those strings as text, so every time
 * goes through here both ways:
 *
 *   stored UTC ──localTs()──▶ printed: the process's local time with its offset
 *   agent input ──utcBound() (timeParam, src/mcp/time_param.ts)──▶ UTC ISO ──▶ SQL
 *
 * The zone is the process's (`TZ`, else the system zone), which Claude Code
 * and Codex pass through to the MCP server. There is no setting. The hooks
 * print through this file too, so it imports nothing: zod would grow each
 * hook bundle from tens of kilobytes to over half a megabyte.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

const STORED_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A stored time as the local time with its offset (`Z` in UTC, so a UTC
 * process prints the stored string unchanged). The fraction is kept as
 * written, so passing the printed time back finds the same stored string.
 * Anything that is not a stored time (`"?"`, odd values) is returned as it is.
 */
export function localTs(ts: string): string {
  const m = STORED_TS.exec(ts);
  const t = Date.parse(ts);
  if (!m || Number.isNaN(t)) return ts;
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? "Z" : `${off > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${m[2] ?? ""}${zone}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A time input as the UTC ISO string SQL compares with, or null when it is
 * not one of the accepted forms. A date alone is local midnight, built by
 * hand because `Date.parse` reads it as UTC midnight; a date-time without
 * `Z` or an offset is local time, as `Date.parse` reads it.
 */
export function utcBound(input: string): string | null {
  const s = input.trim();
  const d = DATE_ONLY.exec(s);
  if (d) {
    const [y, mo, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const t = new Date(y, mo - 1, day);
    // `new Date` rolls an impossible date over (2026-02-30 → 2026-03-02).
    if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== day) return null;
    return t.toISOString();
  }
  if (!DATE_TIME.test(s)) return null;
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export const TIME_INPUT_HINT =
  "not a date or time: pass YYYY-MM-DD (the start of that day, local time) or YYYY-MM-DDTHH:MM[:SS[.sss]], optionally ending in Z or ±HH:MM (without one it is local time)";
