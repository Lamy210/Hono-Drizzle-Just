export function databaseTimestampMs(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Rate limiter received an invalid database timestamp");
  }
  return milliseconds;
}
