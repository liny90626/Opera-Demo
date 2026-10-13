import type {
  Actor,
  ApiLogEntry,
  BusinessEvent,
  ChangeSet,
  Command,
  CommandResult,
  Delivery,
  HkStatus,
  Reservation,
  Room,
  Snapshot,
} from './types.ts';
import { EVENTS, EVENT_MODULE } from './events.ts';
import { createSeed, mulberry32, type SeedOptions } from './seed.ts';
import { indexReservations, isOooActive, isRoomReady, roomView } from './selectors.ts';
import { attemptDelivery, initSubscribers, projection } from './sync.ts';
import { addDays, staysOverlap, stayOverlaps } from './dates.ts';

const CAP_EVENTS = 500;
const CAP_DELIVERIES = 500;
const CAP_API = 200;

class CommandError extends Error {
  constructor(message: string, public code = 'VALIDATION') {
    super(message);
  }
}

export function createInitialState(opts?: SeedOptions): Snapshot {
  const s = createSeed(opts);
  s.subscribers = initSubscribers(s);
  return s;
}

/**
 * The PMS engine: validates commands, mutates state, and emits business events which are
 * then delivered to simulated external subscribers. Pure in-memory; used by the Node server
 * and by the in-browser backend (GitHub Pages build).
 */
export class PmsEngine {
  state: Snapshot;
  private eventSeq: number;
  private rnd: () => number;
  // per-command tracking
  private touchedRooms = new Set<string>();
  private touchedResv = new Set<string>();
  private newEvents: BusinessEvent[] = [];
  private newDeliveries: Delivery[] = [];
  private touchedSubs = new Set<string>();
  private hotelChanged = false;
  private attendantsChanged = false;
  private warnings: string[] = [];
  private fullReset = false;
  private actor: Actor = { name: 'SYSTEM', source: 'SYSTEM' };

  constructor(state?: Snapshot, opts?: SeedOptions & { random?: () => number }) {
    this.state = state ?? createInitialState(opts);
    this.eventSeq = this.state.events[0]?.seq ?? 0;
    this.rnd = opts?.random ?? Math.random;
  }

  snapshot(): Snapshot {
    return this.state;
  }

  // ---------------------------------------------------------------- helpers
  private room(id: string): Room {
    const r = this.state.rooms.find((x) => x.id === id || x.number === id);
    if (!r) throw new CommandError(`Room ${id} not found`, 'NOT_FOUND');
    return r;
  }
  private resv(id: string): Reservation {
    const r = this.state.reservations.find((x) => x.id === id || x.confirmationNo === id);
    if (!r) throw new CommandError(`Reservation ${id} not found`, 'NOT_FOUND');
    return r;
  }
  private get D() {
    return this.state.hotel.businessDate;
  }
  private touchRoom(r: Room) {
    r.lastStatusChange = new Date().toISOString();
    r.lastChangedBy = this.actor.name;
    this.touchedRooms.add(r.id);
  }
  private emit(
    eventName: string,
    primaryKey: string,
    roomIds: string[],
    details: BusinessEvent['details'],
    summary: string,
  ) {
    const ev: BusinessEvent = {
      id: `EVT-${(++this.eventSeq).toString().padStart(6, '0')}`,
      seq: this.eventSeq,
      eventName,
      module: EVENT_MODULE[eventName] ?? 'HOUSEKEEPING',
      hotelId: this.state.hotel.hotelId,
      businessDate: this.D,
      timestamp: new Date().toISOString(),
      actor: this.actor.name,
      source: this.actor.source,
      primaryKey,
      roomIds,
      details,
      summary,
    };
    this.newEvents.push(ev);
  }
  private occupant(roomId: string): Reservation | undefined {
    return this.state.reservations.find((r) => r.roomId === roomId && r.status === 'InHouse');
  }
  /** Reservations (reserved or in-house) holding the room during a stay window, excluding one id. */
  private roomConflicts(roomId: string, arrival: string, departure: string, excludeId?: string): Reservation[] {
    return this.state.reservations.filter(
      (r) =>
        r.roomId === roomId &&
        r.id !== excludeId &&
        (r.status === 'Reserved' || r.status === 'InHouse') &&
        staysOverlap(r.arrival, r.status === 'InHouse' && r.departure < this.D ? this.D : r.departure, arrival, departure),
    );
  }
  private oooOverlaps(room: Room, arrival: string, departure: string): boolean {
    const o = room.outOfOrder;
    return !!o && o.type === 'OOO' && stayOverlaps(arrival, departure, o.from, o.to);
  }
  private setHk(room: Room, status: HkStatus, reason?: string) {
    if (room.hkStatus === status) return;
    const old = room.hkStatus;
    room.hkStatus = status;
    this.touchRoom(room);
    this.emit(EVENTS.HK_STATUS, room.id, [room.id], [{ elementName: 'RoomStatus', oldValue: old, newValue: status }],
      `Room ${room.number}: ${old} → ${status}${reason ? ` (${reason})` : ''}`);
    // queue notification
    if ((status === 'Clean' || status === 'Inspected') && isRoomReady(this.state, room)) {
      const q = this.state.reservations.find((r) => r.roomId === room.id && r.queue && r.status === 'Reserved');
      if (q) {
        this.emit(EVENTS.QUEUE_ROOM_READY, q.id, [room.id], [{ elementName: 'QueueRoomStatus', oldValue: old, newValue: status }],
          `Queue room ${room.number} is ready for ${q.guestName} (#${q.confirmationNo})`);
        this.warnings.push(`Queue reservation ${q.guestName} – room ${room.number} is now ready, notify the guest.`);
      }
    }
  }

  // --------------------------------------------------------------- public api
  exec(cmd: Command, actor: Actor = { name: 'OC-TW1', source: 'OPERA_UI' }): CommandResult {
    this.actor = actor;
    // other tabs/backends may have appended events to the shared state: never reuse a sequence number
    this.eventSeq = Math.max(this.eventSeq, this.state.events[0]?.seq ?? 0);
    this.touchedRooms.clear();
    this.touchedResv.clear();
    this.touchedSubs.clear();
    this.newEvents = [];
    this.newDeliveries = [];
    this.hotelChanged = false;
    this.attendantsChanged = false;
    this.warnings = [];
    this.fullReset = false;
    const backup = structuredClone(this.state);
    let message: string | undefined;
    try {
      if (cmd.type === 'resetDemo') {
        this.state = createInitialState();
        this.eventSeq = 0;
        this.state.version = backup.version + 1;
        return { ok: true, warnings: [], message: 'Demo data has been reset', changes: { version: this.state.version, reset: this.state } };
      }
      message = this.apply(cmd);
    } catch (e) {
      this.state = backup;
      if (e instanceof CommandError) return { ok: false, error: e.message, errorCode: e.code, warnings: [], changes: null };
      throw e;
    }
    const noChange =
      !this.touchedRooms.size && !this.touchedResv.size && !this.newEvents.length && !this.hotelChanged &&
      !this.attendantsChanged && !this.touchedSubs.size && !this.newDeliveries.length;
    if (noChange) return { ok: true, warnings: this.warnings, message: message ?? 'No changes', changes: null };
    this.dispatchEvents();
    this.state.version++;
    return { ok: true, warnings: this.warnings, message, changes: this.collect() };
  }

  /** Record an inbound OHIP API call in the API log (also broadcast as a change). */
  logApi(entry: Omit<ApiLogEntry, 'id' | 'timestamp'>): ChangeSet {
    const e: ApiLogEntry = { id: `API-${Date.now().toString(36)}-${Math.floor(this.rnd() * 1e6).toString(36)}`, timestamp: new Date().toISOString(), ...entry };
    this.state.apiLog.unshift(e);
    this.state.apiLog.length = Math.min(this.state.apiLog.length, CAP_API);
    this.state.version++;
    return { version: this.state.version, apiLog: [e] };
  }

  private collect(): ChangeSet {
    const s = this.state;
    const cs: ChangeSet = { version: s.version };
    if (this.fullReset) {
      cs.reset = s;
      cs.events = this.newEvents;
      cs.deliveries = this.newDeliveries;
      return cs;
    }
    if (this.touchedRooms.size) cs.rooms = s.rooms.filter((r) => this.touchedRooms.has(r.id));
    if (this.touchedResv.size) cs.reservations = s.reservations.filter((r) => this.touchedResv.has(r.id));
    if (this.newEvents.length) cs.events = this.newEvents;
    if (this.newDeliveries.length) cs.deliveries = this.newDeliveries;
    if (this.touchedSubs.size) cs.subscribers = s.subscribers.filter((x) => this.touchedSubs.has(x.id));
    if (this.hotelChanged) cs.hotel = s.hotel;
    if (this.attendantsChanged) cs.attendants = s.attendants;
    return cs;
  }

  private dispatchEvents() {
    const s = this.state;
    for (const ev of this.newEvents) {
      s.events.unshift(ev);
      for (const sub of s.subscribers) {
        if (!sub.enabled || !sub.events.includes(ev.eventName)) continue;
        const d = attemptDelivery(s, sub, ev, 1, this.rnd);
        this.newDeliveries.push(d);
        s.deliveries.unshift(d);
        this.touchedSubs.add(sub.id);
      }
    }
    s.events.length = Math.min(s.events.length, CAP_EVENTS);
    s.deliveries.length = Math.min(s.deliveries.length, CAP_DELIVERIES);
  }

  private apply(cmd: Command): string | undefined {
    const s = this.state;
    const D = this.D;
    const p = s.hotel.parameters;
    switch (cmd.type) {
      // ------------------------------------------------------------ housekeeping
      case 'setHkStatus': {
        if (cmd.status === 'Inspected' && !p.inspectedStatusEnabled) throw new CommandError('Inspected status is not enabled for this property', 'PARAM');
        if (cmd.status === 'Pickup' && !p.pickupStatusEnabled) throw new CommandError('Pickup status is not enabled for this property', 'PARAM');
        if (!cmd.roomIds.length) throw new CommandError('Select at least one room');
        let changed = 0;
        for (const id of cmd.roomIds) {
          const room = this.room(id);
          if (isOooActive(room, D)) {
            this.warnings.push(`Room ${room.number} is ${room.outOfOrder!.type} – return it to inventory first (skipped).`);
            continue;
          }
          if (room.hkStatus !== cmd.status) changed++;
          this.setHk(room, cmd.status);
        }
        if (!changed && this.warnings.length === cmd.roomIds.length) throw new CommandError(this.warnings.join(' '), 'ROOM_OOO');
        return `${changed} room(s) set to ${cmd.status}`;
      }
      case 'setHkOccupancy': {
        const room = this.room(cmd.roomId);
        const old = room.hkOccupancy;
        const persons = cmd.occupancy === 'Vacant' ? 0 : Math.max(1, cmd.persons ?? room.hkPersons ?? 1);
        room.hkOccupancy = cmd.occupancy;
        room.hkPersons = persons;
        this.touchRoom(room);
        this.emit(EVENTS.HK_OCCUPANCY, room.id, [room.id],
          [{ elementName: 'HousekeepingStatus', oldValue: old, newValue: cmd.occupancy }, { elementName: 'HousekeepingPersons', oldValue: null, newValue: String(persons) }],
          `Room ${room.number}: HK observed ${cmd.occupancy}${cmd.occupancy === 'Occupied' ? ` (${persons} pax)` : ''}`);
        const v = roomView(s, room);
        if (v.discrepancies.length) this.warnings.push(`Room ${room.number}: ${v.discrepancies.join(', ')} discrepancy detected.`);
        return `Room ${room.number} housekeeping status recorded`;
      }
      case 'resolveDiscrepancy': {
        // Front desk / HK supervisor confirms the room: align HK observation with FO data.
        const room = this.room(cmd.roomId);
        const v = roomView(s, room);
        if (!v.discrepancies.length) throw new CommandError(`Room ${room.number} has no discrepancy`);
        room.hkOccupancy = v.foStatus;
        room.hkPersons = v.persons;
        this.touchRoom(room);
        this.emit(EVENTS.HK_OCCUPANCY, room.id, [room.id], [{ elementName: 'HousekeepingStatus', oldValue: v.discrepancies.join(','), newValue: `${v.foStatus} (resolved)` }],
          `Room ${room.number}: ${v.discrepancies.join(', ')} discrepancy resolved`);
        return `Discrepancy resolved for room ${room.number}`;
      }
      case 'setServiceStatus': {
        let n = 0;
        for (const id of cmd.roomIds) {
          const room = this.room(id);
          if (cmd.service && !this.occupant(room.id)) {
            this.warnings.push(`Room ${room.number} is vacant – ${cmd.service} only applies to occupied rooms (skipped).`);
            continue;
          }
          if (room.serviceStatus === cmd.service) continue;
          const old = room.serviceStatus;
          room.serviceStatus = cmd.service;
          this.touchRoom(room);
          n++;
          this.emit(EVENTS.SERVICE_STATUS, room.id, [room.id], [{ elementName: 'ServiceStatus', oldValue: old, newValue: cmd.service }],
            `Room ${room.number}: service status ${cmd.service ?? 'cleared'}`);
        }
        if (!n && this.warnings.length) throw new CommandError(this.warnings.join(' '));
        return `${n} room(s) updated`;
      }
      case 'setTurndown': {
        for (const id of cmd.roomIds) {
          const room = this.room(id);
          if (room.turndown === cmd.turndown) continue;
          const old = room.turndown;
          room.turndown = cmd.turndown;
          this.touchRoom(room);
          this.emit(EVENTS.TURNDOWN, room.id, [room.id], [{ elementName: 'TurndownStatus', oldValue: old, newValue: cmd.turndown }],
            `Room ${room.number}: turndown ${cmd.turndown}`);
        }
        return 'Turndown status updated';
      }
      case 'setCondition': {
        if (cmd.conditionCode && !s.conditions.some((c) => c.code === cmd.conditionCode))
          throw new CommandError(`Unknown room condition ${cmd.conditionCode}`);
        for (const id of cmd.roomIds) {
          const room = this.room(id);
          if (room.conditionCode === cmd.conditionCode) continue;
          const cond = s.conditions.find((c) => c.code === cmd.conditionCode);
          if (cond?.blocksAssignment) {
            const a = s.reservations.find((r) => r.roomId === room.id && r.status === 'Reserved' && r.arrival >= D);
            if (a) this.warnings.push(`Room ${room.number} is assigned to ${a.guestName} (#${a.confirmationNo}); condition ${cond.code} blocks new assignments only.`);
          }
          const old = room.conditionCode;
          room.conditionCode = cmd.conditionCode;
          this.touchRoom(room);
          this.emit(EVENTS.CONDITION, room.id, [room.id], [{ elementName: 'RoomCondition', oldValue: old, newValue: cmd.conditionCode }],
            `Room ${room.number}: condition ${cmd.conditionCode ?? 'removed'}`);
        }
        return 'Room condition updated';
      }
      case 'placeOutOfOrder': {
        if (!cmd.roomIds.length) throw new CommandError('Select at least one room');
        if (cmd.from > cmd.to) throw new CommandError('From date must be on or before To date');
        if (cmd.from < D) throw new CommandError(`From date cannot be before the business date ${D}`);
        if (!s.oooReasons.some((r) => r.code === cmd.reasonCode)) throw new CommandError('A valid reason code is required');
        if (cmd.returnStatus === 'Inspected' && !p.inspectedStatusEnabled) throw new CommandError('Return status Inspected is not enabled');
        for (const id of cmd.roomIds) {
          const room = this.room(id);
          if (room.outOfOrder) throw new CommandError(`Room ${room.number} already has an ${room.outOfOrder.type} record (${room.outOfOrder.from} – ${room.outOfOrder.to})`, 'ALREADY_OOO');
          const occ = this.occupant(room.id);
          const conflicts = s.reservations.filter(
            (r) => r.roomId === room.id && (r.status === 'Reserved' || r.status === 'InHouse') &&
              stayOverlaps(r.arrival, r.status === 'InHouse' && r.departure < D ? D : r.departure, cmd.from, cmd.to),
          );
          if (cmd.oooType === 'OOO') {
            if (occ && conflicts.includes(occ)) throw new CommandError(`Room ${room.number} is occupied by ${occ.guestName} until ${occ.departure}. Move the guest before placing it Out of Order.`, 'ROOM_OCCUPIED');
            const res = conflicts.find((r) => r.status === 'Reserved');
            if (res) throw new CommandError(`Room ${room.number} is assigned to reservation #${res.confirmationNo} (${res.guestName}, ${res.arrival}). Unassign it first.`, 'ROOM_ASSIGNED');
          } else if (conflicts.length) {
            this.warnings.push(`Room ${room.number} has ${conflicts.length} reservation(s) in this period – Out of Service keeps it sellable.`);
          }
          room.outOfOrder = {
            id: `OOO-${Date.now().toString(36).slice(-5).toUpperCase()}${room.number}`,
            type: cmd.oooType,
            from: cmd.from,
            to: cmd.to,
            reasonCode: cmd.reasonCode,
            returnStatus: cmd.returnStatus,
            remarks: cmd.remarks,
          };
          this.touchRoom(room);
          this.emit(cmd.oooType === 'OOO' ? EVENTS.OOO_PLACED : EVENTS.OOS_PLACED, room.id, [room.id],
            [
              { elementName: 'RoomStatus', oldValue: room.hkStatus, newValue: cmd.oooType === 'OOO' ? 'OutOfOrder' : 'OutOfService' },
              { elementName: 'FromDate', oldValue: null, newValue: cmd.from },
              { elementName: 'ToDate', oldValue: null, newValue: cmd.to },
              { elementName: 'ReasonCode', oldValue: null, newValue: cmd.reasonCode },
            ],
            `Room ${room.number} placed ${cmd.oooType} ${cmd.from} → ${cmd.to} (${cmd.reasonCode})`);
        }
        return `${cmd.roomIds.length} room(s) placed ${cmd.oooType === 'OOO' ? 'Out of Order' : 'Out of Service'}`;
      }
      case 'releaseOutOfOrder': {
        for (const id of cmd.roomIds) {
          const room = this.room(id);
          const o = room.outOfOrder;
          if (!o) throw new CommandError(`Room ${room.number} is not Out of Order / Service`);
          const wasActive = isOooActive(room, D);
          room.outOfOrder = null;
          this.touchRoom(room);
          this.emit(o.type === 'OOO' ? EVENTS.OOO_RELEASED : EVENTS.OOS_RELEASED, room.id, [room.id],
            [{ elementName: 'RoomStatus', oldValue: o.type === 'OOO' ? 'OutOfOrder' : 'OutOfService', newValue: wasActive ? o.returnStatus : room.hkStatus }],
            `Room ${room.number} returned from ${o.type}${wasActive ? ` as ${o.returnStatus}` : ' (future record deleted)'}`);
          if (wasActive) this.setHk(room, o.returnStatus, 'return status');
        }
        return 'Room(s) returned to inventory';
      }
      case 'assignAttendant': {
        const att = cmd.attendantId ? s.attendants.find((a) => a.id === cmd.attendantId) : null;
        if (cmd.attendantId && !att) throw new CommandError('Unknown attendant');
        for (const id of cmd.roomIds) {
          const room = this.room(id);
          if (room.attendantId === cmd.attendantId) continue;
          const old = room.attendantId;
          room.attendantId = cmd.attendantId;
          this.touchRoom(room);
          this.emit(EVENTS.ATTENDANT, room.id, [room.id], [{ elementName: 'AttendantId', oldValue: old, newValue: cmd.attendantId }],
            `Room ${room.number} assigned to ${att?.name ?? 'nobody'}`);
        }
        return `${cmd.roomIds.length} room(s) assigned to ${att?.name ?? 'nobody'}`;
      }
      case 'autoAssignTasks': {
        const atts = s.attendants.filter((a) => cmd.attendantIds.includes(a.id));
        if (!atts.length) throw new CommandError('Select at least one attendant');
        const idx = indexReservations(s);
        const targets = s.rooms
          .filter((r) => !isOooActive(r, D))
          .filter((r) => (cmd.onlyDirty ? r.hkStatus === 'Dirty' || r.hkStatus === 'Pickup' : r.hkStatus !== 'Inspected' || idx.inHouse.has(r.id)))
          .sort((a, b) => a.id.localeCompare(b.id));
        const load = new Map(atts.map((a) => [a.id, 0]));
        const credits = (r: Room) => s.roomTypes.find((t) => t.code === r.roomType)?.credits ?? 10;
        let unassigned = 0;
        for (const room of targets) {
          // prefer section owner, otherwise least-loaded floater/anyone with capacity
          const c = credits(room);
          const candidates = atts
            .filter((a) => load.get(a.id)! + c <= a.maxCredits)
            .sort((a, b) => Number(b.section === room.section) - Number(a.section === room.section) || load.get(a.id)! - load.get(b.id)!);
          const chosen = candidates[0];
          if (!chosen) {
            unassigned++;
            if (room.attendantId) {
              room.attendantId = null;
              this.touchRoom(room);
            }
            continue;
          }
          load.set(chosen.id, load.get(chosen.id)! + c);
          if (room.attendantId !== chosen.id) {
            room.attendantId = chosen.id;
            this.touchRoom(room);
          }
        }
        this.emit(EVENTS.ATTENDANT, 'TASKSHEET', [...this.touchedRooms],
          atts.map((a) => ({ elementName: a.name, oldValue: null, newValue: `${load.get(a.id)} credits` })),
          `Task sheets generated for ${atts.length} attendant(s), ${targets.length - unassigned} room(s)`);
        if (unassigned) this.warnings.push(`${unassigned} room(s) could not be assigned – attendant credit limits reached.`);
        return `Task sheets generated: ${targets.length - unassigned} room(s) distributed`;
      }
      case 'pbxStatusCode': {
        // Inbound room-status sync from the PBX (attendant dials a code from the guest-room phone).
        const room = this.room(cmd.roomNumber);
        const map: Record<string, Command> = {
          '1': { type: 'setHkStatus', roomIds: [room.id], status: 'Clean' },
          '2': { type: 'setHkStatus', roomIds: [room.id], status: 'Dirty' },
          '3': { type: 'setHkStatus', roomIds: [room.id], status: 'Inspected' },
          '4': { type: 'setHkStatus', roomIds: [room.id], status: 'Pickup' },
          '5': { type: 'setHkOccupancy', roomId: room.id, occupancy: 'Occupied' },
          '6': { type: 'setHkOccupancy', roomId: room.id, occupancy: 'Vacant' },
        };
        const sub = map[cmd.code];
        if (!sub) throw new CommandError(`Unknown PBX room status code "${cmd.code}"`, 'BAD_CODE');
        return this.apply(sub);
      }

      // ------------------------------------------------------------- front desk
      case 'assignRoom': {
        const r = this.resv(cmd.reservationId);
        if (r.status !== 'Reserved') throw new CommandError(`Reservation #${r.confirmationNo} is ${r.status}; use Room Move for in-house guests`, 'BAD_STATE');
        const room = this.room(cmd.roomId);
        if (room.roomType !== r.roomType && !cmd.force)
          throw new CommandError(`Room ${room.number} is ${room.roomType}, reservation is ${r.roomType}. Confirm to upgrade / change room type.`, 'ROOM_TYPE_MISMATCH');
        if (this.oooOverlaps(room, r.arrival, r.departure))
          throw new CommandError(`Room ${room.number} is Out of Order during the stay (${room.outOfOrder!.from} – ${room.outOfOrder!.to})`, 'ROOM_OOO');
        const cond = s.conditions.find((c) => c.code === room.conditionCode);
        if (cond?.blocksAssignment) throw new CommandError(`Room ${room.number} has condition ${cond.code} (${cond.description}) and cannot be assigned`, 'ROOM_CONDITION');
        const conflicts = this.roomConflicts(room.id, r.arrival, r.departure, r.id);
        if (conflicts.length) {
          const c = conflicts[0];
          throw new CommandError(`Room ${room.number} is already ${c.status === 'InHouse' ? 'occupied by' : 'assigned to'} ${c.guestName} (${c.arrival} – ${c.departure})`, 'ROOM_UNAVAILABLE');
        }
        if (room.outOfOrder?.type === 'OOS' && stayOverlaps(r.arrival, r.departure, room.outOfOrder.from, room.outOfOrder.to))
          this.warnings.push(`Room ${room.number} is Out of Service during the stay.`);
        if (room.roomType !== r.roomType) this.warnings.push(`Room type changed ${r.roomType} → ${room.roomType}.`);
        if (r.arrival === D && !isRoomReady(s, room)) this.warnings.push(`Room ${room.number} is ${room.hkStatus} – not ready for check-in yet (consider Queue).`);
        const old = r.roomId;
        r.roomId = room.id;
        if (room.roomType !== r.roomType) r.roomType = room.roomType;
        this.touchedResv.add(r.id);
        this.touchedRooms.add(room.id);
        if (old) this.touchedRooms.add(old);
        this.emit(EVENTS.ROOM_ASSIGN, r.id, old ? [old, room.id] : [room.id],
          [{ elementName: 'RoomId', oldValue: old, newValue: room.number }],
          `#${r.confirmationNo} ${r.guestName} assigned room ${room.number}`);
        return `Room ${room.number} assigned to ${r.guestName}`;
      }
      case 'unassignRoom': {
        const r = this.resv(cmd.reservationId);
        if (r.status !== 'Reserved' || !r.roomId) throw new CommandError('Reservation has no assigned room to release');
        const old = r.roomId;
        r.roomId = null;
        r.queue = null;
        this.touchedResv.add(r.id);
        this.touchedRooms.add(old);
        this.emit(EVENTS.ROOM_UNASSIGN, r.id, [old], [{ elementName: 'RoomId', oldValue: old.replace(/^0/, ''), newValue: null }],
          `#${r.confirmationNo} ${r.guestName} released room ${old.replace(/^0/, '')}`);
        return 'Room released';
      }
      case 'checkIn': {
        const r = this.resv(cmd.reservationId);
        if (r.status !== 'Reserved') throw new CommandError(`Reservation #${r.confirmationNo} is ${r.status}`, 'BAD_STATE');
        if (r.arrival !== D) throw new CommandError(`Arrival date is ${r.arrival}; only today's (${D}) arrivals can check in`, 'NOT_ARRIVAL_DATE');
        if (!r.roomId) throw new CommandError('Assign a room before check-in', 'NO_ROOM');
        const room = this.room(r.roomId);
        if (this.occupant(room.id)) throw new CommandError(`Room ${room.number} is still occupied`, 'ROOM_OCCUPIED');
        if (!isRoomReady(s, room)) {
          const need = p.inspectedStatusEnabled && !p.allowCheckInClean ? 'Inspected' : 'Clean or Inspected';
          throw new CommandError(`Room ${room.number} is ${roomView(s, room).displayStatus}. Rooms must be ${need} for check-in. Add the reservation to the Queue?`, 'ROOM_NOT_READY');
        }
        r.status = 'InHouse';
        r.checkedInAt = new Date().toISOString();
        const wasQueued = !!r.queue;
        r.queue = null;
        if (room.serviceStatus) room.serviceStatus = null;
        this.touchedResv.add(r.id);
        this.touchRoom(room);
        this.emit(EVENTS.CHECK_IN, r.id, [room.id],
          [{ elementName: 'ReservationStatus', oldValue: 'Reserved', newValue: 'InHouse' }, { elementName: 'FrontOfficeStatus', oldValue: 'Vacant', newValue: 'Occupied' }],
          `${r.guestName} checked in to room ${room.number}${wasQueued ? ' (from queue)' : ''}`);
        return `${r.guestName} checked in to room ${room.number}`;
      }
      case 'checkOut': {
        const r = this.resv(cmd.reservationId);
        if (r.status !== 'InHouse' || !r.roomId) throw new CommandError(`Reservation #${r.confirmationNo} is not in house`, 'BAD_STATE');
        const room = this.room(r.roomId);
        if (r.departure > D) {
          this.warnings.push(`Early departure: original departure ${r.departure} changed to ${D}.`);
          r.departure = D;
        }
        r.status = 'CheckedOut';
        r.checkedOutAt = new Date().toISOString();
        this.touchedResv.add(r.id);
        room.hkOccupancy = null;
        room.hkPersons = null;
        room.serviceStatus = null;
        room.turndown = 'Not Required';
        this.touchRoom(room);
        this.emit(EVENTS.CHECK_OUT, r.id, [room.id],
          [{ elementName: 'ReservationStatus', oldValue: 'InHouse', newValue: 'CheckedOut' }, { elementName: 'FrontOfficeStatus', oldValue: 'Occupied', newValue: 'Vacant' }],
          `${r.guestName} checked out of room ${room.number}`);
        this.setHk(room, 'Dirty', 'check-out');
        return `${r.guestName} checked out – room ${room.number} set to Dirty`;
      }
      case 'roomMove': {
        const r = this.resv(cmd.reservationId);
        if (r.status !== 'InHouse' || !r.roomId) throw new CommandError('Only in-house reservations can be moved', 'BAD_STATE');
        const from = this.room(r.roomId);
        const to = this.room(cmd.toRoomId);
        if (from.id === to.id) throw new CommandError('Select a different room');
        if (isOooActive(to, D) || this.oooOverlaps(to, D, r.departure)) throw new CommandError(`Room ${to.number} is Out of Order`, 'ROOM_OOO');
        const cond = s.conditions.find((c) => c.code === to.conditionCode);
        if (cond?.blocksAssignment) throw new CommandError(`Room ${to.number} has condition ${cond.code} and cannot be assigned`, 'ROOM_CONDITION');
        const conflicts = this.roomConflicts(to.id, D, r.departure, r.id);
        if (conflicts.length) throw new CommandError(`Room ${to.number} is not available (${conflicts[0].guestName})`, 'ROOM_UNAVAILABLE');
        if (!isRoomReady(s, to)) throw new CommandError(`Room ${to.number} is ${to.hkStatus}; a room move requires a ready room`, 'ROOM_NOT_READY');
        r.roomId = to.id;
        if (to.roomType !== r.roomType) {
          this.warnings.push(`Room type changed ${r.roomType} → ${to.roomType}.`);
          r.roomType = to.roomType;
        }
        this.touchedResv.add(r.id);
        from.hkOccupancy = null;
        from.hkPersons = null;
        from.serviceStatus = null;
        this.touchRoom(from);
        this.touchRoom(to);
        this.emit(EVENTS.ROOM_MOVE, r.id, [from.id, to.id], [{ elementName: 'RoomId', oldValue: from.number, newValue: to.number }],
          `${r.guestName} moved ${from.number} → ${to.number}${cmd.reason ? ` (${cmd.reason})` : ''}`);
        this.setHk(from, 'Dirty', 'room move');
        return `Moved to room ${to.number}; room ${from.number} set to Dirty`;
      }
      case 'queueReservation': {
        const r = this.resv(cmd.reservationId);
        if (r.status !== 'Reserved' || r.arrival !== D) throw new CommandError("Only today's arrivals can be queued", 'BAD_STATE');
        if (r.queue) throw new CommandError('Reservation is already in the queue');
        const maxP = Math.max(0, ...s.reservations.filter((x) => x.queue).map((x) => x.queue!.priority));
        r.queue = { queuedAt: new Date().toISOString(), priority: cmd.priority ?? maxP + 1 };
        this.touchedResv.add(r.id);
        if (r.roomId) this.touchedRooms.add(r.roomId);
        this.emit(EVENTS.QUEUE_ADD, r.id, r.roomId ? [r.roomId] : [], [{ elementName: 'QueuePriority', oldValue: null, newValue: String(r.queue.priority) }],
          `${r.guestName} added to queue${r.roomId ? ` for room ${r.roomId.replace(/^0/, '')}` : ''} (priority ${r.queue.priority})`);
        if (r.roomId) {
          const room = this.room(r.roomId);
          if (!isRoomReady(s, room)) this.warnings.push(`Housekeeping notified: please prioritise room ${room.number}.`);
        }
        return `${r.guestName} added to the queue`;
      }
      case 'removeFromQueue': {
        const r = this.resv(cmd.reservationId);
        if (!r.queue) throw new CommandError('Reservation is not in the queue');
        r.queue = null;
        this.touchedResv.add(r.id);
        if (r.roomId) this.touchedRooms.add(r.roomId);
        this.emit(EVENTS.QUEUE_REMOVE, r.id, r.roomId ? [r.roomId] : [], [], `${r.guestName} removed from queue`);
        return 'Removed from queue';
      }

      // --------------------------------------------------------------- sync admin
      case 'setSubscriber': {
        const sub = s.subscribers.find((x) => x.id === cmd.subscriberId);
        if (!sub) throw new CommandError('Unknown subscriber');
        if (cmd.enabled !== undefined) sub.enabled = cmd.enabled;
        if (cmd.failureRate !== undefined) sub.failureRate = Math.min(1, Math.max(0, cmd.failureRate));
        this.touchedSubs.add(sub.id);
        return `${sub.name} updated`;
      }
      case 'retryDelivery':
      case 'retryAllFailed': {
        const failed = s.deliveries.filter((d) => d.status === 'FAILED' && (cmd.type === 'retryAllFailed' || d.id === cmd.deliveryId));
        if (!failed.length) throw new CommandError('No failed deliveries to retry');
        let ok = 0;
        for (const d of failed) {
          const sub = s.subscribers.find((x) => x.id === d.subscriberId);
          const ev = s.events.find((e) => e.id === d.eventId);
          if (!sub || !ev) continue;
          d.status = 'RETRYING';
          const nd = attemptDelivery(s, sub, ev, d.attempts + 1, this.rnd);
          if (nd.status === 'DELIVERED') ok++;
          d.status = nd.status === 'DELIVERED' ? 'DELIVERED' : 'FAILED';
          d.attempts = nd.attempts;
          d.timestamp = nd.timestamp;
          this.newDeliveries.push(d);
          this.touchedSubs.add(sub.id);
        }
        return `${ok}/${failed.length} deliveries succeeded on retry`;
      }
      case 'resyncSubscriber': {
        const sub = s.subscribers.find((x) => x.id === cmd.subscriberId);
        if (!sub) throw new CommandError('Unknown subscriber');
        sub.mirror = projection(s, sub.kind);
        sub.lastDeliveryAt = new Date().toISOString();
        this.touchedSubs.add(sub.id);
        return `${sub.name}: full resync completed (${Object.keys(sub.mirror).length} records)`;
      }

      // ------------------------------------------------------------- end of day
      case 'nightAudit': {
        const newDate = addDays(D, 1);
        const pending = s.reservations.filter((r) => r.status === 'InHouse' && r.departure <= D);
        if (pending.length)
          throw new CommandError(`${pending.length} due-out reservation(s) are still in house (e.g. ${pending[0].guestName}, room ${pending[0].roomId?.replace(/^0/, '')}). Check them out or extend before running End of Day.`, 'DUE_OUTS_PENDING');
        let noShows = 0;
        for (const r of s.reservations) {
          if (r.status === 'Reserved' && r.arrival <= D) {
            r.status = 'NoShow';
            if (r.roomId) this.touchedRooms.add(r.roomId);
            r.roomId = null;
            r.queue = null;
            this.touchedResv.add(r.id);
            noShows++;
          }
        }
        let dirtied = 0;
        let released = 0;
        s.hotel.businessDate = newDate;
        this.hotelChanged = true;
        for (const room of s.rooms) {
          const occupied = !!this.occupant(room.id);
          if (occupied && p.autoDirtyOnNightAudit && room.hkStatus !== 'Dirty') {
            room.hkStatus = 'Dirty';
            dirtied++;
          }
          if (room.outOfOrder && room.outOfOrder.to < newDate) {
            room.hkStatus = room.outOfOrder.returnStatus;
            room.outOfOrder = null;
            released++;
          }
          room.hkOccupancy = null;
          room.hkPersons = null;
          // OPERA: Make Up Room is cleared at End of Day, Do Not Disturb is kept for occupied rooms
          if (room.serviceStatus === 'MUR' || !occupied) room.serviceStatus = null;
          room.attendantId = null;
          room.turndown = occupied && (room.roomType === 'ES' || room.roomType === 'JS') ? 'Required' : 'Not Required';
          room.lastStatusChange = new Date().toISOString();
          room.lastChangedBy = 'NIGHT AUDIT';
          this.touchedRooms.add(room.id);
        }
        // keep the demo flowing: generate arrivals for the day after the new business date
        const gen = mulberry32(Date.now() & 0xffffffff);
        const types = ['SK', 'SK', 'ST', 'DK', 'JS'];
        const names = ['Zhou, Lei', 'Moreau, Claire', 'Ito, Hana', 'Singh, Ravi', 'Xu, Yan', 'Novak, Petra', 'He, Bin', 'Silva, Joao'];
        let conf = Math.max(...s.reservations.map((r) => +r.confirmationNo));
        for (let i = 0; i < 8; i++) {
          conf += 11;
          const r: Reservation = {
            id: `R${conf}`, confirmationNo: String(conf), guestName: names[i], vip: null,
            roomType: types[Math.floor(gen() * types.length)], arrival: addDays(newDate, 2), departure: addDays(newDate, 3 + Math.floor(gen() * 3)),
            adults: 2, children: 0, status: 'Reserved', roomId: null, queue: null, eta: '15:00', specials: [], checkedInAt: null, checkedOutAt: null,
          };
          s.reservations.push(r);
          this.touchedResv.add(r.id);
        }
        // drop reservations that are long gone to keep the payload small
        const cutoff = addDays(newDate, -3);
        s.reservations = s.reservations.filter((r) => !((r.status === 'CheckedOut' || r.status === 'NoShow' || r.status === 'Cancelled') && r.departure < cutoff));
        this.emit(EVENTS.NIGHT_AUDIT, newDate, [],
          [
            { elementName: 'BusinessDate', oldValue: D, newValue: newDate },
            { elementName: 'OccupiedRoomsSetDirty', oldValue: null, newValue: String(dirtied) },
            { elementName: 'NoShows', oldValue: null, newValue: String(noShows) },
            { elementName: 'OOOReleased', oldValue: null, newValue: String(released) },
          ],
          `End of Day: business date ${D} → ${newDate}; ${dirtied} occupied room(s) set Dirty, ${noShows} no-show(s), ${released} OOO released`);
        // reservations were pruned: clients must replace their whole snapshot
        this.fullReset = true;
        return `Business date rolled to ${newDate}`;
      }
      case 'setParameters': {
        Object.assign(s.hotel.parameters, cmd.parameters);
        this.hotelChanged = true;
        return 'Property parameters updated';
      }
      default: {
        const never: never = cmd as never;
        throw new CommandError(`Unknown command ${(never as { type: string }).type}`);
      }
    }
  }
}
