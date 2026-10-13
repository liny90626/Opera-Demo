/** Tiny ISO-date helpers (YYYY-MM-DD, timezone-free). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function diffDays(a: string, b: string): number {
  const ta = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const tb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((tb - ta) / 86400000);
}

/** Stay [arrival, departure) overlaps the inclusive window [from, to]. */
export function stayOverlaps(arrival: string, departure: string, from: string, to: string): boolean {
  // day-use (arrival === departure) occupies the arrival date
  const lastNight = arrival === departure ? arrival : addDays(departure, -1);
  return arrival <= to && lastNight >= from;
}

/** Two stays overlap (night-based; day-use counts as the arrival day). */
export function staysOverlap(a1: string, d1: string, a2: string, d2: string): boolean {
  const l1 = a1 === d1 ? a1 : addDays(d1, -1);
  return stayOverlaps(a2, d2, a1, l1);
}

export function nowIso(): string {
  return new Date().toISOString();
}
