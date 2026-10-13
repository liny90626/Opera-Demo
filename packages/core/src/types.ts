/**
 * Domain model for the OPERA Cloud room-management demo.
 * Codes mirror OPERA Cloud / OHIP terminology where possible.
 */

/** Housekeeping room status (OPERA "Room Status"). Pickup is optional (parameter controlled). */
export type HkStatus = 'Clean' | 'Dirty' | 'Inspected' | 'Pickup';
/** OOO removes the room from sellable inventory, OOS does not. */
export type OutOfOrderType = 'OOO' | 'OOS';
/** Status shown on boards: the HK status, unless an OOO/OOS is active on the business date. */
export type DisplayRoomStatus = HkStatus | 'OutOfOrder' | 'OutOfService';
/** Front office status, derived from in-house reservations. */
export type FoStatus = 'Vacant' | 'Occupied';
/** Housekeeping occupancy observation entered by attendants. */
export type HkOccupancy = 'Vacant' | 'Occupied';
/** Room-level reservation status (OPERA "Reservation Status" column on HK Board). */
export type RoomResvStatus =
  | 'Not Reserved'
  | 'Arrival'
  | 'Arrived'
  | 'Stay Over'
  | 'Due Out'
  | 'Departed'
  | 'Day Use';
export type ServiceStatus = 'DND' | 'MUR' | null;
export type TurndownStatus = 'Not Required' | 'Required' | 'Completed';
export type DiscrepancyType = 'Skip' | 'Sleep' | 'Person';

export interface RoomType {
  code: string;
  name: string;
  /** Housekeeping credits needed to service a room of this type (task sheets). */
  credits: number;
  maxOccupancy: number;
}

export interface OutOfOrderRecord {
  id: string;
  type: OutOfOrderType;
  /** ISO date (YYYY-MM-DD), inclusive */
  from: string;
  /** ISO date (YYYY-MM-DD), inclusive */
  to: string;
  reasonCode: string;
  returnStatus: HkStatus;
  remarks?: string;
}

export interface Room {
  id: string; // e.g. "0305"
  number: string; // display number e.g. "305"
  floor: number;
  roomType: string; // RoomType.code
  features: string[]; // e.g. ["NS", "VW"]
  hkStatus: HkStatus;
  /** Active or future OOO/OOS record (at most one in this demo). */
  outOfOrder: OutOfOrderRecord | null;
  hkOccupancy: HkOccupancy | null; // null = not yet observed today
  hkPersons: number | null;
  serviceStatus: ServiceStatus;
  turndown: TurndownStatus;
  conditionCode: string | null;
  attendantId: string | null;
  /** Housekeeping section (OPERA "Housekeeping Section"). */
  section: string;
  lastStatusChange: string; // ISO timestamp
  lastChangedBy: string;
}

export type ResvStatus = 'Reserved' | 'InHouse' | 'CheckedOut' | 'Cancelled' | 'NoShow';

export interface Reservation {
  id: string;
  confirmationNo: string;
  guestName: string;
  vip: string | null; // VIP code e.g. "V1"
  roomType: string;
  arrival: string; // ISO date
  departure: string; // ISO date
  adults: number;
  children: number;
  status: ResvStatus;
  roomId: string | null;
  /** Queue reservation info: guest waiting for a room to become ready. */
  queue: { queuedAt: string; priority: number } | null;
  eta: string | null; // "14:30"
  specials: string[];
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

export interface Attendant {
  id: string;
  name: string;
  section: string | null;
  maxCredits: number;
}

export interface RoomCondition {
  code: string;
  description: string;
  /** If true, rooms with this condition cannot be assigned to reservations. */
  blocksAssignment: boolean;
}

export interface ReasonCode {
  code: string;
  description: string;
}

export interface HotelParameters {
  /** Use "Inspected" status (Clean must be inspected before check-in). */
  inspectedStatusEnabled: boolean;
  /** Use "Pickup" status. */
  pickupStatusEnabled: boolean;
  /** Allow check-in to rooms that are Clean but not yet Inspected (OPERA allows Clean or Inspected by default). */
  allowCheckInClean: boolean;
  /** Night audit sets all occupied rooms to Dirty. */
  autoDirtyOnNightAudit: boolean;
}

export interface Hotel {
  hotelId: string; // OHIP x-hotelid
  name: string;
  chainCode: string;
  businessDate: string; // ISO date
  parameters: HotelParameters;
}

/** OHIP-style business event (outbound sync). */
export interface BusinessEvent {
  id: string;
  seq: number;
  /** Event code, e.g. UPDATE_HOUSEKEEPING_STATUS */
  eventName: string;
  module: 'HOUSEKEEPING' | 'FRONT_DESK' | 'RESERVATION' | 'INVENTORY' | 'NIGHT_AUDIT';
  hotelId: string;
  businessDate: string;
  timestamp: string;
  actor: string;
  /** Channel through which the change arrived (UI user, OHIP REST API, PBX code, night audit...). */
  source: ChangeSource;
  primaryKey: string; // e.g. roomId or reservation id
  /** Rooms affected by this event (used to route sync to external systems). */
  roomIds: string[];
  /** Changed fields: name -> {oldValue,newValue} like OHIP business events "detail" */
  details: { elementName: string; oldValue: string | null; newValue: string | null }[];
  summary: string;
}

export type ChangeSource = 'OPERA_UI' | 'MOBILE' | 'OHIP_API' | 'PBX' | 'NIGHT_AUDIT' | 'SYSTEM';

/** External system subscribed to business events (simulated consumers). */
export interface Subscriber {
  id: string;
  name: string;
  kind: 'HOUSEKEEPING_APP' | 'PBX' | 'DOOR_LOCK' | 'ENERGY' | 'CHANNEL' | 'DATA_LAKE';
  description: string;
  /** Event names this subscriber consumes. */
  events: string[];
  enabled: boolean;
  /** Simulated view of room state as the external system knows it (eventual consistency). */
  mirror: Record<string, string>;
  delivered: number;
  failed: number;
  lastDeliveryAt: string | null;
  /** Simulated failure rate 0..1 used to demo retries */
  failureRate: number;
}

export interface Delivery {
  id: string;
  subscriberId: string;
  eventId: string;
  eventName: string;
  status: 'DELIVERED' | 'FAILED' | 'RETRYING' | 'PENDING';
  attempts: number;
  timestamp: string;
  latencyMs: number;
}

export interface ApiLogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
  appKey?: string;
}

export interface Snapshot {
  version: number;
  hotel: Hotel;
  roomTypes: RoomType[];
  rooms: Room[];
  reservations: Reservation[];
  attendants: Attendant[];
  conditions: RoomCondition[];
  oooReasons: ReasonCode[];
  events: BusinessEvent[]; // most recent first, capped
  subscribers: Subscriber[];
  deliveries: Delivery[]; // most recent first, capped
  apiLog: ApiLogEntry[]; // most recent first, capped
}

/** Incremental change set pushed to clients after each command. */
export interface ChangeSet {
  version: number;
  hotel?: Hotel;
  rooms?: Room[];
  reservations?: Reservation[];
  attendants?: Attendant[];
  events?: BusinessEvent[]; // new events (oldest first)
  subscribers?: Subscriber[];
  deliveries?: Delivery[]; // new deliveries
  apiLog?: ApiLogEntry[]; // new api log entries
  /** when true, client should replace the whole snapshot (e.g. after reset) */
  reset?: Snapshot;
}

export interface Actor {
  name: string; // e.g. "OC-TW1"
  source: ChangeSource;
}

export type Command =
  | { type: 'setHkStatus'; roomIds: string[]; status: HkStatus }
  | { type: 'setHkOccupancy'; roomId: string; occupancy: HkOccupancy; persons?: number }
  | { type: 'setServiceStatus'; roomIds: string[]; service: ServiceStatus }
  | { type: 'setTurndown'; roomIds: string[]; turndown: TurndownStatus }
  | { type: 'setCondition'; roomIds: string[]; conditionCode: string | null }
  | {
      type: 'placeOutOfOrder';
      roomIds: string[];
      oooType: OutOfOrderType;
      from: string;
      to: string;
      reasonCode: string;
      returnStatus: HkStatus;
      remarks?: string;
    }
  | { type: 'releaseOutOfOrder'; roomIds: string[] }
  | { type: 'assignAttendant'; roomIds: string[]; attendantId: string | null }
  | { type: 'autoAssignTasks'; attendantIds: string[]; onlyDirty: boolean }
  | { type: 'assignRoom'; reservationId: string; roomId: string; force?: boolean }
  | { type: 'unassignRoom'; reservationId: string }
  | { type: 'checkIn'; reservationId: string }
  | { type: 'checkOut'; reservationId: string }
  | { type: 'roomMove'; reservationId: string; toRoomId: string; reason?: string }
  | { type: 'queueReservation'; reservationId: string; priority?: number }
  | { type: 'removeFromQueue'; reservationId: string }
  | { type: 'resolveDiscrepancy'; roomId: string }
  | { type: 'pbxStatusCode'; roomNumber: string; code: string }
  | { type: 'setSubscriber'; subscriberId: string; enabled?: boolean; failureRate?: number }
  | { type: 'retryDelivery'; deliveryId: string }
  | { type: 'retryAllFailed' }
  | { type: 'resyncSubscriber'; subscriberId: string }
  | { type: 'nightAudit' }
  | { type: 'setParameters'; parameters: Partial<HotelParameters> }
  | { type: 'resetDemo' };

export interface CommandResult {
  ok: boolean;
  /** Blocking error (nothing changed) */
  error?: string;
  /** Machine-readable error code (e.g. ROOM_NOT_READY) so the UI can offer follow-up actions */
  errorCode?: string;
  /** Non-blocking warnings (change applied) */
  warnings: string[];
  /** Human-readable message for toasts */
  message?: string;
  changes: ChangeSet | null;
}

/** Derived per-room view used by boards (computed by selectors). */
export interface RoomView extends Room {
  displayStatus: DisplayRoomStatus;
  foStatus: FoStatus;
  resvStatus: RoomResvStatus;
  inHouse: Reservation | null; // current occupant
  arrival: Reservation | null; // assigned arrival for business date
  departed: Reservation | null; // reservation checked out today
  persons: number; // FO persons
  discrepancies: DiscrepancyType[];
  oooActive: boolean;
  roomTypeName: string;
  credits: number;
  queued: Reservation | null; // queue reservation waiting on this room
}
