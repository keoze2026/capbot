/** `2026-07-28` in the configured timezone — used to label the daily folder. */
export function dayKey(d: Date, timezone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** `142305` in the configured timezone — used to prefix event files. */
export function timeKey(d: Date, timezone?: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}${get('minute')}${get('second')}`;
}

/** `2026-07-28 14:23:05` — human-friendly stamp for message bodies. */
export function stamp(d: Date, timezone?: string): string {
  return `${dayKey(d, timezone)} ${timeKey(d, timezone).replace(
    /(\d{2})(\d{2})(\d{2})/,
    '$1:$2:$3',
  )}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
