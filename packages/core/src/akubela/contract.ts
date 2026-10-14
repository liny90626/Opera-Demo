/**
 * Akubela GRMS integration – shared contract (see docs/07-akubela-integration-design.md).
 * Owned by the lead; simulator (B1), connector (B2), server (B3) and web (B4) all code against these types.
 * Field names of GRMS entities follow the Akubela OpenAPI V4.1 (snake_case) exactly.
 */
import type { Actor, BusinessEvent, Command, CommandResult, Snapshot } from '../types.ts';

// ───────────────────────────────────────────────────────────── transport
export type TransportKind = 'real' | 'sim';

/** Calls one GRMS OpenAPI command (`POST .../hotel-commands {command,id,param}`) and returns `result` on success. */
export interface GrmsTransport {
  readonly kind: TransportKind;
  call<T = unknown>(command: GrmsCommand | string, param: Record<string, unknown>, opts?: { commandId?: string }): Promise<T>;
  /** Token status (real: OAuth2 client-credentials token; sim: synthetic). */
  tokenInfo(): { expiresAt: number; scope: string } | null;
}

/** Error thrown by transports. `retryable` = network/5xx/token problems; business errors are not retryable. */
export class GrmsError extends Error {
  constructor(
    message: string,
    public code: number,
    public traceId?: string,
    public httpStatus?: number,
    public retryable = false,
  ) {
    super(message);
    this.name = 'GrmsError';
  }
}

/** Commands used by the integration (subset of the 120+ OpenAPI commands). */
export type GrmsCommand =
  | 'get_room_list'
  | 'get_room_info'
  | 'update_room_state'
  | 'get_room_type_list'
  | 'get_order_list'
  | 'get_order_info'
  | 'create_order_info'
  | 'update_order_info'
  | 'delete_order_info'
  | 'get_guest_list'
  | 'create_guest_info'
  | 'get_authorization_record_list'
  | 'create_authorization_record_info'
  | 'delete_authorization_record_info'
  | 'get_device_list'
  | 'get_device_info'
  | 'control_device'
  | 'get_scene_list'
  | 'manual_trigger_scene'
  | 'get_alarm_record_list'
  | 'get_project_info';

// ───────────────────────────────────────────────────────────── GRMS entities (OpenAPI shapes)
export interface GrmsRoomListBuilding {
  building_id: string;
  building_name: string;
  floors: { floor_id: string; floor_name: string; residences: { residence_id: string; residence_name: string }[] }[];
}

/** Flattened residence used by the integration. */
export interface GrmsResidence {
  residence_id: string;
  residence_name: string; // room number, e.g. "101"
  building_id: string;
  building_name: string;
  floor_name: string;
}

export interface GrmsRoomInfo {
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_name: string;
  residence_no: string;
  room_type_id: string;
  room_type_name: string;
  room_tag_id: string;
  room_tag_name: string;
  order_id: string;
  dirty: boolean;
  occupied: boolean;
  dnd: boolean;
}

export type GrmsOrderState = 'check_in' | 'checked_in' | 'checked_out';

export interface GrmsGuest {
  guest_id?: string;
  guest_name: string;
  email: string;
  phone: string;
  id_card: string;
  passport: string;
}

export interface GrmsOrder {
  order_id: string;
  order_number: string;
  residence_id: string;
  residence_no: string;
  room_type_id: string;
  room_type_name: string;
  start_time: string; // "YYYY-MM-DD HH:mm:ss" UTC
  finish_time: string;
  order_state: GrmsOrderState;
  guests: GrmsGuest[];
  source?: string;
  remark?: string;
  enable_booking?: boolean;
}

export interface GrmsAbility {
  ability_id: string;
  ability_name: string;
  ability_type: string; // switch | light | climate | sensor | binary_sensor | lock | cover | ...
  ability_attribute: string[] | null;
  state: string;
  attribute: Record<string, unknown>;
}

export interface GrmsDevice {
  device_id: string;
  device_name: string;
  product_name: string;
  device_type: string;
  device_picture_url?: string;
  online: boolean;
  abilities: GrmsAbility[];
  space?: { parent_space_id: string; space_id: string; space_name: string };
  sub_devices: GrmsDevice[];
  parent_device_id?: string;
}

export interface GrmsScene {
  scene_id: string;
  scene_name: string;
  [k: string]: unknown;
}

export interface GrmsAlarmRecord {
  [k: string]: unknown;
}

// ───────────────────────────────────────────────────────────── integration state
export type IntegrationMode = TransportKind | 'off';

/**
 * Which system is the source of truth.
 * - opera-master (default): OPERA owns reservations and housekeeping status; GRMS is kept in line by pushing OPERA state
 *   (startup push, change events, reconcile). Only GRMS-only facts flow back: DND, guest self check-out, alarms.
 * - bidirectional: additionally accept clean/dirty changes made in GRMS (HyPanel / GRMS console).
 */
export type SyncMode = 'opera-master' | 'bidirectional';

export interface AkubelaSettings {
  syncMode: SyncMode;
  /** Push the full OPERA state to GRMS whenever the connector starts (after master data is loaded). */
  pushOnStart: boolean;
  /** Create a pending ("check_in") GRMS order when a room is assigned to an arrival. */
  preRegisterOnAssign: boolean;
  /** Push HK status (dirty/clean) to GRMS. */
  syncHkStatus: boolean;
  /** Accept dirty→clean / clean→dirty changes made in GRMS. */
  acceptGrmsClean: boolean;
  /** Accept DND from GRMS (in-house rooms). */
  acceptGrmsDnd: boolean;
  /** Check the reservation out in OPERA when GRMS reports the order checked_out (guest self check-out). */
  acceptGrmsCheckout: boolean;
  /** Create a door PIN authorization record on check-in, delete it on check-out. */
  doorPinOnCheckIn: boolean;
  welcomeSceneId: string | null;
  checkoutSceneId: string | null;
  /** Hotel timezone (IANA) used to convert OPERA dates to GRMS UTC times. */
  hotelTimezone: string;
  checkInTime: string; // "14:00" local
  checkOutTime: string; // "12:00" local
  pollSeconds: number;
  orderSource: string; // GRMS order "source"
}

export const DEFAULT_SETTINGS: AkubelaSettings = {
  syncMode: 'opera-master',
  pushOnStart: true,
  preRegisterOnAssign: true,
  syncHkStatus: true,
  acceptGrmsClean: false, // only honoured when syncMode = 'bidirectional'
  acceptGrmsDnd: true,
  acceptGrmsCheckout: true,
  doorPinOnCheckIn: false,
  welcomeSceneId: null,
  checkoutSceneId: null,
  hotelTimezone: 'Asia/Shanghai',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  pollSeconds: 20,
  orderSource: 'OPERA',
};

export interface RoomMapping {
  roomId: string; // OPERA room id, e.g. "0201"
  residenceId: string | null;
  residenceName: string | null; // GRMS room number
  /** auto = matched by room number; manual = set by user / AKUBELA_ROOM_MAP */
  origin: 'auto' | 'manual';
}

export interface OrderLink {
  reservationId: string;
  confirmationNo: string;
  orderId: string;
  orderNumber: string;
  residenceId: string;
  roomId: string;
  state: GrmsOrderState;
  guestId?: string;
  authRecordId?: string;
  pin?: string;
  /** true when superseded (e.g. room move created a new order) */
  closed: boolean;
  createdAt: string;
  updatedAt: string;
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD' | 'SKIPPED';

/** One outbound unit of work. `action` is a connector-level step that may issue one or more GRMS commands. */
export interface Job {
  id: string;
  key: string; // serialization key: "resv:<id>" or "room:<id>"
  action: JobAction;
  eventId: string | null;
  eventName: string | null;
  reservationId: string | null;
  roomId: string | null;
  summary: string; // human readable, e.g. "Check-in #482909 → room 101"
  status: JobStatus;
  attempts: number;
  nextRunAt: number; // epoch ms
  lastError: { code: number; message: string; traceId?: string } | null;
  createdAt: string;
  updatedAt: string;
}

export type JobAction =
  | 'PRE_REGISTER' // create pending order for an assigned arrival
  | 'CANCEL_ORDER' // delete pending order (unassign / no-show / reassign)
  | 'CHECK_IN'
  | 'CHECK_OUT'
  | 'ROOM_MOVE'
  | 'ROOM_STATE' // dirty / clean
  | 'UNSUPPORTED'; // recorded as SKIPPED (OOO, MUR, ...)

export interface ApiCallLog {
  id: string;
  ts: string;
  direction: 'OUT' | 'IN'; // OUT = write/command for PMS change, IN = polling/read
  command: string;
  /** param with secrets/PII redacted */
  param: unknown;
  ok: boolean;
  code?: number;
  message?: string;
  traceId?: string;
  durationMs: number;
  jobId?: string;
}

export interface GrmsRoomSnapshot {
  residenceId: string;
  dirty: boolean | null;
  occupied: boolean | null;
  dnd: boolean | null;
  orderId: string | null;
  fetchedAt: string;
  error: { code: number; message: string; traceId?: string } | null;
}

export interface AkubelaAlarm {
  id: string;
  ts: string;
  residenceId: string | null;
  roomId: string | null;
  type: string;
  message: string;
  raw: unknown;
}

export interface AkubelaState {
  mode: IntegrationMode;
  baseUrl: string | null;
  clientIdMasked: string | null; // e.g. "cd43…2c5f5"
  connected: boolean;
  token: { expiresAt: number } | null;
  lastPollAt: string | null;
  lastError: { code: number; message: string; traceId?: string } | null;
  settings: AkubelaSettings;
  residences: GrmsResidence[];
  roomTypes: { room_type_id: string; room_type_name: string }[];
  mappings: RoomMapping[]; // one per OPERA room
  links: OrderLink[];
  grmsRooms: Record<string, GrmsRoomSnapshot>; // by residenceId
  externalOrders: GrmsOrder[]; // GRMS orders without an OPERA reservation
  jobs: Job[]; // newest first, capped 200
  apiLog: ApiCallLog[]; // newest first, capped 300
  alarms: AkubelaAlarm[]; // newest first, capped 100
  stats: { jobsSucceeded: number; jobsFailed: number; inboundApplied: number };
  /** Last full OPERA → GRMS push (startup or manual). */
  lastPushAt?: string | null;
  version: number;
}

// ───────────────────────────────────────────────────────────── connector API
/** How the connector talks to the PMS. exec() must broadcast the resulting changes to UI clients. */
export interface PmsPort {
  snapshot(): Snapshot;
  exec(cmd: Command, actor: Actor): CommandResult;
}

export interface ConnectorDeps {
  transport: GrmsTransport | null; // null when mode = off
  mode: IntegrationMode;
  pms: PmsPort;
  now?: () => number;
  /** Called (debounced by caller if needed) whenever state changes. */
  onStateChange?: (state: AkubelaState) => void;
  /** Called for user-facing notifications (alarms, inbound changes). */
  onNotice?: (n: { kind: 'info' | 'warning' | 'error'; text: string }) => void;
  initialState?: Partial<AkubelaState>;
  /** Manual room map, e.g. { "0201": "101" } (OPERA roomId or number → GRMS residence_name). */
  roomMap?: Record<string, string>;
  baseUrl?: string | null;
  clientIdMasked?: string | null;
}

/** Actor used for every PMS change originating from GRMS (echo-suppressed on the way out). */
export const AKUBELA_ACTOR: Actor = { name: 'AKUBELA-GRMS', source: 'AKUBELA' };

/** Public surface of AkubelaConnector (implemented in connector.ts). */
export interface AkubelaConnectorApi {
  getState(): AkubelaState;
  /** Feed business events produced by the PMS (after every command). Events with source AKUBELA are ignored. */
  handleEvents(events: BusinessEvent[]): void;
  /** Process due jobs (respecting per-key FIFO + backoff). Resolves when the current batch is done. */
  drain(): Promise<void>;
  /** One inbound polling cycle (room list refresh when stale, room info for mapped rooms, orders, alarms). */
  poll(): Promise<void>;
  /** Compare all links/rooms and enqueue repair jobs; returns number of issues found. */
  reconcile(): Promise<number>;
  /**
   * Full OPERA → GRMS push for every mapped room: housekeeping dirty/clean, in-house guests as checked_in orders,
   * today's assigned arrivals as pending orders (if preRegisterOnAssign), stale GRMS orders closed/cancelled.
   * Enqueues jobs and returns their number; sets state.lastPushAt.
   */
  pushAll(): Promise<number>;
  /** Fetch room list + room types, rebuild auto mappings, test credentials. */
  refreshMasterData(): Promise<void>;
  retryJob(jobId: string): void;
  setMapping(roomId: string, residenceId: string | null): void;
  updateSettings(patch: Partial<AkubelaSettings>): void;
  listDevices(roomId: string): Promise<GrmsDevice[]>;
  controlDevice(param: { device_id: string; ability_id: string; control: string; attribute?: Record<string, unknown> }): Promise<void>;
  listScenes(): Promise<GrmsScene[]>;
  triggerScene(sceneId: string, roomIds: string[]): Promise<void>;
  /** Start background timers (drain every 1s, poll every settings.pollSeconds). */
  start(): void;
  stop(): void;
}

// ───────────────────────────────────────────────────────────── simulator control (sim mode only)
/** Actions that emulate changes made on the GRMS side (HyPanel, housekeeping, guest self check-out). */
export type SimAction =
  | { type: 'setRoomState'; residenceId: string; dirty?: boolean; dnd?: boolean }
  | { type: 'guestSelfCheckout'; orderId: string }
  | { type: 'raiseAlarm'; residenceId: string; alarmType: 'sos' | 'smoke' | 'low_power' | 'water_leak'; message?: string }
  | { type: 'setFaults'; profile: 'none' | 'uat' };

// ───────────────────────────────────────────────────────────── server REST contract (B3 implements, B4 consumes)
export const AKUBELA_API = {
  state: 'GET /api/integrations/akubela/state',
  test: 'POST /api/integrations/akubela/test',
  mode: 'POST /api/integrations/akubela/mode', // body {mode}
  settings: 'PUT /api/integrations/akubela/settings', // body Partial<AkubelaSettings>
  mapping: 'PUT /api/integrations/akubela/mapping', // body {roomId, residenceId|null}
  reconcile: 'POST /api/integrations/akubela/reconcile',
  push: 'POST /api/integrations/akubela/push', // full OPERA → GRMS push, returns {jobs}
  poll: 'POST /api/integrations/akubela/poll',
  retry: 'POST /api/integrations/akubela/jobs/:id/retry',
  devices: 'GET /api/integrations/akubela/rooms/:roomId/devices',
  control: 'POST /api/integrations/akubela/devices/control', // body {device_id, ability_id, control, attribute?}
  scenes: 'GET /api/integrations/akubela/scenes',
  triggerScene: 'POST /api/integrations/akubela/scenes/:sceneId/trigger', // body {roomIds}
  sim: 'POST /api/integrations/akubela/sim', // body SimAction (sim mode only)
  /** SSE on /api/stream: `event: akubela` with data = AkubelaState (full, small enough) */
  sseEvent: 'akubela',
} as const;

export function maskSecret(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length <= 9 ? '•••' : `${s.slice(0, 4)}…${s.slice(-5)}`;
}

// ───────────────────────────────────────────────────────────── service (mode switching; shared by server & browser)
/** A GRMS simulator is a transport with extra controls for demoing GRMS-side changes. */
export interface GrmsSimulatorApi extends GrmsTransport {
  apply(action: SimAction): void;
  /** Debug/inspection dump of the simulated GRMS database. */
  dump(): unknown;
}

export interface AkubelaServiceDeps {
  pms: PmsPort;
  /** Builds the real transport (server only; null in the browser). */
  realTransportFactory: (() => GrmsTransport) | null;
  initialMode: IntegrationMode;
  initialState?: Partial<AkubelaState>;
  roomMap?: Record<string, string>;
  baseUrl?: string | null;
  clientIdMasked?: string | null;
  onStateChange?: (state: AkubelaState) => void;
  onNotice?: (n: { kind: 'info' | 'warning' | 'error'; text: string }) => void;
  now?: () => number;
  /** Start background timers automatically (false in tests). */
  autoStart?: boolean;
}

export interface AkubelaServiceApi {
  state(): AkubelaState;
  connector(): AkubelaConnectorApi | null;
  simulator(): GrmsSimulatorApi | null;
  setMode(mode: IntegrationMode): Promise<void>;
  /** Credentials + connectivity test (token + get_room_list). */
  test(): Promise<{ ok: boolean; message: string; residences: number; code?: number; traceId?: string }>;
  /** Forward PMS business events (call after every successful command, including OHIP/API ones). */
  onPmsEvents(events: BusinessEvent[]): void;
  dispose(): void;
}
