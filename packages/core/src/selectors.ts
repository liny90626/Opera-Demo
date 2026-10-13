import type {
  DiscrepancyType,
  DisplayRoomStatus,
  HkStatus,
  Reservation,
  Room,
  RoomResvStatus,
  RoomView,
  Snapshot,
} from './types.ts';

export interface RoomIndex {
  inHouse: Map<string, Reservation>;
  arrival: Map<string, Reservation>;
  departed: Map<string, Reservation>;
}

/** Index reservations by room for the current business date. */
export function indexReservations(s: Pick<Snapshot, 'reservations' | 'hotel'>): RoomIndex {
  const D = s.hotel.businessDate;
  const idx: RoomIndex = { inHouse: new Map(), arrival: new Map(), departed: new Map() };
  for (const r of s.reservations) {
    if (!r.roomId) continue;
    if (r.status === 'InHouse') idx.inHouse.set(r.roomId, r);
    else if (r.status === 'Reserved' && r.arrival === D) idx.arrival.set(r.roomId, r);
    else if (r.status === 'CheckedOut' && r.departure === D) idx.departed.set(r.roomId, r);
  }
  return idx;
}

export function isOooActive(room: Room, businessDate: string): boolean {
  const o = room.outOfOrder;
  return !!o && o.from <= businessDate && businessDate <= o.to;
}

export function displayStatus(room: Room, businessDate: string): DisplayRoomStatus {
  if (isOooActive(room, businessDate)) return room.outOfOrder!.type === 'OOO' ? 'OutOfOrder' : 'OutOfService';
  return room.hkStatus;
}

export function roomView(s: Snapshot, room: Room, idx: RoomIndex = indexReservations(s)): RoomView {
  const D = s.hotel.businessDate;
  const inHouse = idx.inHouse.get(room.id) ?? null;
  const arrival = idx.arrival.get(room.id) ?? null;
  const departed = idx.departed.get(room.id) ?? null;
  const foStatus = inHouse ? 'Occupied' : 'Vacant';
  let resvStatus: RoomResvStatus = 'Not Reserved';
  if (inHouse) {
    if (inHouse.arrival === inHouse.departure) resvStatus = 'Day Use';
    else if (inHouse.departure <= D) resvStatus = 'Due Out';
    else if (inHouse.arrival === D) resvStatus = 'Arrived';
    else resvStatus = 'Stay Over';
  } else if (arrival) resvStatus = 'Arrival';
  else if (departed) resvStatus = 'Departed';

  const persons = inHouse ? inHouse.adults + inHouse.children : 0;
  const discrepancies: DiscrepancyType[] = [];
  if (room.hkOccupancy) {
    if (foStatus === 'Occupied' && room.hkOccupancy === 'Vacant') discrepancies.push('Skip');
    if (foStatus === 'Vacant' && room.hkOccupancy === 'Occupied') discrepancies.push('Sleep');
    if (foStatus === 'Occupied' && room.hkOccupancy === 'Occupied' && room.hkPersons != null && room.hkPersons !== persons)
      discrepancies.push('Person');
  }
  const rt = s.roomTypes.find((t) => t.code === room.roomType);
  const queued = arrival?.queue ? arrival : null;
  return {
    ...room,
    displayStatus: displayStatus(room, D),
    foStatus,
    resvStatus,
    inHouse,
    arrival,
    departed,
    persons,
    discrepancies,
    oooActive: isOooActive(room, D),
    roomTypeName: rt?.name ?? room.roomType,
    credits: rt?.credits ?? 10,
    queued,
  };
}

export function roomViews(s: Snapshot): RoomView[] {
  const idx = indexReservations(s);
  return s.rooms.map((r) => roomView(s, r, idx));
}

/** Room is ready for check-in according to hotel parameters. */
export function isRoomReady(s: Snapshot, room: Room): boolean {
  if (isOooActive(room, s.hotel.businessDate)) return false;
  if (room.hkStatus === 'Inspected') return true;
  if (room.hkStatus === 'Clean') return !s.hotel.parameters.inspectedStatusEnabled || s.hotel.parameters.allowCheckInClean;
  return false;
}

export interface RoomStatusTile {
  status: HkStatus;
  occupied: number;
  assigned: number;
  vacant: number;
}

/** Data for the OPERA "Room Status" dashboard tile (excludes rooms that are OOO/OOS today). */
export function roomStatusTile(views: RoomView[]): RoomStatusTile[] {
  const order: HkStatus[] = ['Inspected', 'Clean', 'Pickup', 'Dirty'];
  return order.map((status) => {
    const rs = views.filter((v) => !v.oooActive && v.hkStatus === status);
    return {
      status,
      occupied: rs.filter((v) => v.foStatus === 'Occupied').length,
      assigned: rs.filter((v) => v.foStatus === 'Vacant' && !!v.arrival).length,
      vacant: rs.filter((v) => v.foStatus === 'Vacant' && !v.arrival).length,
    };
  });
}

export interface RoomSummary {
  physical: number;
  inventory: number;
  outOfOrder: number;
  outOfService: number;
  occupied: number;
  vacant: number;
  arrivalsExpected: number;
  arrivalsUnassigned: number;
  departuresExpected: number;
  departed: number;
  discrepancies: number;
  occupancyPct: number;
}

export function roomSummary(s: Snapshot, views: RoomView[] = roomViews(s)): RoomSummary {
  const D = s.hotel.businessDate;
  const ooo = views.filter((v) => v.displayStatus === 'OutOfOrder').length;
  const oos = views.filter((v) => v.displayStatus === 'OutOfService').length;
  const occupied = views.filter((v) => v.foStatus === 'Occupied').length;
  const inventory = views.length - ooo;
  const arrivals = s.reservations.filter((r) => r.status === 'Reserved' && r.arrival === D);
  return {
    physical: views.length,
    inventory,
    outOfOrder: ooo,
    outOfService: oos,
    occupied,
    vacant: views.length - occupied,
    arrivalsExpected: arrivals.length,
    arrivalsUnassigned: arrivals.filter((r) => !r.roomId).length,
    departuresExpected: s.reservations.filter((r) => r.status === 'InHouse' && r.departure <= D).length,
    departed: s.reservations.filter((r) => r.status === 'CheckedOut' && r.departure === D).length,
    discrepancies: views.filter((v) => v.discrepancies.length > 0).length,
    occupancyPct: inventory ? Math.round((occupied / inventory) * 1000) / 10 : 0,
  };
}

export function queueReservations(s: Snapshot): Reservation[] {
  return s.reservations
    .filter((r) => r.queue && r.status === 'Reserved')
    .sort((a, b) => a.queue!.priority - b.queue!.priority || a.queue!.queuedAt.localeCompare(b.queue!.queuedAt));
}

/** Minutes between two ISO timestamps (b defaults to now). */
export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
}
