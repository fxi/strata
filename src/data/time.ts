/**
 * The store's time axis as text: months (YYYY-MM), days or hours, from the
 * typical spacing of its steps. The same text keys a time step in the URL.
 */

export interface Cadence {
  kind: "month" | "day" | "hour";
  /** Hours between steps (for sub-daily stores). */
  hours: number;
}

const HOUR = 3600e3;

export function cadenceOf(times: ArrayLike<number>): Cadence {
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(times.length, 64); i++) {
    gaps.push(times[i] - times[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[gaps.length >> 1] : 30 * 24 * HOUR;
  if (gap >= 27 * 24 * HOUR) {
    return { kind: "month", hours: 0 };
  }
  if (gap >= 23 * HOUR) {
    return { kind: "day", hours: 24 };
  }
  return { kind: "hour", hours: Math.max(1, Math.round(gap / HOUR)) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Shown text: 2024-01, 2024-01-31, 2024-01-31 06:00. */
export function timeText(ms: number, cadence: Cadence): string {
  const date = new Date(ms);
  const month = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
  if (cadence.kind === "month") {
    return month;
  }
  const day = `${month}-${pad(date.getUTCDate())}`;
  return cadence.kind === "day" ? day : `${day} ${pad(date.getUTCHours())}:00`;
}

/** URL text: 2024-01, 2024-01-31, 2024-01-31T06. */
export function timeKey(ms: number, cadence: Cadence): string {
  return timeText(ms, cadence).replace(" ", "T").replace(/:00$/, "");
}

/** Index of the step a URL key names, or -1. Accepts the shown text too. */
export function findTime(
  times: ArrayLike<number>,
  cadence: Cadence,
  key: string,
): number {
  const wanted = key.replace(" ", "T").replace(/:00$/, "");
  for (let i = 0; i < times.length; i++) {
    if (timeKey(times[i], cadence) === wanted) {
      return i;
    }
  }
  return -1;
}

export function cadenceLabel(cadence: Cadence): string {
  if (cadence.kind === "month") {
    return "MONTHLY";
  }
  if (cadence.kind === "day") {
    return "DAILY";
  }
  return cadence.hours === 1 ? "HOURLY" : `${cadence.hours}-HOURLY`;
}

/** Runs of steps sharing a calendar month: [start, end] indices. */
export function monthGroups(
  times: ArrayLike<number>,
): Array<{ start: number; end: number; label: string }> {
  const groups: Array<{ start: number; end: number; label: string }> = [];
  for (let i = 0; i < times.length; i++) {
    const date = new Date(times[i]);
    const label = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.end = i;
    } else {
      groups.push({ start: i, end: i, label });
    }
  }
  return groups;
}
