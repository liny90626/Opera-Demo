import type { BusinessEvent, Delivery, Snapshot, Subscriber } from './types.ts';
import { roomViews } from './selectors.ts';
import { DEFAULT_SUBSCRIBERS } from './seed.ts';
import { EVENTS } from './events.ts';

/**
 * Each simulated external system keeps a "mirror" of the room state it cares about.
 * projection() is what the mirror SHOULD be given PMS truth; drift = keys where mirror != projection.
 */
export function projection(s: Snapshot, kind: Subscriber['kind']): Record<string, string> {
  const views = roomViews(s);
  const out: Record<string, string> = {};
  if (kind === 'CHANNEL') {
    for (const t of s.roomTypes) {
      const sellable = views.filter((v) => v.roomType === t.code && v.displayStatus !== 'OutOfOrder').length;
      out[t.code] = `${sellable} sellable`;
    }
    return out;
  }
  for (const v of views) {
    switch (kind) {
      case 'HOUSEKEEPING_APP':
        out[v.id] = `${v.displayStatus} / ${v.foStatus}`;
        break;
      case 'PBX':
        out[v.id] = v.inHouse ? 'Line Open' : 'Line Barred';
        break;
      case 'DOOR_LOCK':
        out[v.id] = v.inHouse ? `Key #${v.inHouse.confirmationNo}` : 'No Active Key';
        break;
      case 'ENERGY':
        out[v.id] = v.inHouse ? 'Comfort' : v.oooActive ? 'Off' : 'Eco';
        break;
      case 'DATA_LAKE':
        out[v.id] = v.displayStatus;
        break;
    }
  }
  return out;
}

export function initSubscribers(s: Snapshot): Subscriber[] {
  return DEFAULT_SUBSCRIBERS.map((d) => ({
    ...d,
    events: [...d.events],
    mirror: projection(s, d.kind),
    delivered: 0,
    failed: 0,
    lastDeliveryAt: null,
  }));
}

/** Keys of a subscriber mirror touched by an event. */
export function affectedKeys(s: Snapshot, sub: Subscriber, ev: BusinessEvent): string[] | 'ALL' {
  if (ev.eventName === EVENTS.NIGHT_AUDIT) return 'ALL';
  if (sub.kind === 'CHANNEL') {
    const types = new Set(ev.roomIds.map((id) => s.rooms.find((r) => r.id === id)?.roomType).filter(Boolean) as string[]);
    return [...types];
  }
  return ev.roomIds;
}

let deliverySeq = 0;

/** Simulate delivering one event to one subscriber; mutates subscriber mirror/counters. */
export function attemptDelivery(
  s: Snapshot,
  sub: Subscriber,
  ev: BusinessEvent,
  attempts: number,
  rnd: () => number = Math.random,
): Delivery {
  const failed = rnd() < sub.failureRate;
  const d: Delivery = {
    id: `DLV-${Date.now().toString(36)}-${(deliverySeq++).toString(36)}`,
    subscriberId: sub.id,
    eventId: ev.id,
    eventName: ev.eventName,
    status: failed ? 'FAILED' : 'DELIVERED',
    attempts,
    timestamp: new Date().toISOString(),
    latencyMs: Math.round(40 + rnd() * 260),
  };
  if (failed) {
    sub.failed++;
  } else {
    sub.delivered++;
    sub.lastDeliveryAt = d.timestamp;
    const truth = projection(s, sub.kind);
    const keys = affectedKeys(s, sub, ev);
    if (keys === 'ALL') sub.mirror = truth;
    else for (const k of keys) if (k in truth) sub.mirror[k] = truth[k];
  }
  return d;
}

export interface DriftItem {
  key: string;
  expected: string;
  actual: string | undefined;
}

export function drift(s: Snapshot, sub: Subscriber): DriftItem[] {
  const truth = projection(s, sub.kind);
  return Object.keys(truth)
    .filter((k) => sub.mirror[k] !== truth[k])
    .map((k) => ({ key: k, expected: truth[k], actual: sub.mirror[k] }));
}
