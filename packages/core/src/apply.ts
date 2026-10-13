import type { ChangeSet, Snapshot } from './types.ts';

const upsert = <T extends { id: string }>(list: T[], items: T[] | undefined): T[] => {
  if (!items?.length) return list;
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = list.map((x) => byId.get(x.id) ?? x);
  const known = new Set(list.map((x) => x.id));
  for (const i of items) if (!known.has(i.id)) out.push(i);
  return out;
};

const prepend = <T extends { id: string }>(list: T[], items: T[] | undefined, cap: number): T[] => {
  if (!items?.length) return list;
  const byId = new Map(items.map((i) => [i.id, i]));
  const rest = list.filter((x) => !byId.has(x.id));
  return [...[...items].reverse(), ...rest].slice(0, cap);
};

/** Immutable merge of a server change set into a client snapshot (used by every UI client). */
export function applyChanges(s: Snapshot, cs: ChangeSet): Snapshot {
  if (cs.reset) return { ...cs.reset, version: cs.version };
  if (cs.version <= s.version && !cs.apiLog) return s;
  return {
    ...s,
    version: Math.max(s.version, cs.version),
    hotel: cs.hotel ?? s.hotel,
    rooms: upsert(s.rooms, cs.rooms),
    reservations: upsert(s.reservations, cs.reservations),
    attendants: cs.attendants ?? s.attendants,
    subscribers: upsert(s.subscribers, cs.subscribers),
    events: prepend(s.events, cs.events, 500),
    deliveries: prepend(s.deliveries, cs.deliveries, 500),
    apiLog: prepend(s.apiLog, cs.apiLog, 200),
  };
}
