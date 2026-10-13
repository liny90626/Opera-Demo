/**
 * OHIP-style REST façade over the PMS engine.
 * Paths / field names follow oracle/hospitality-api-docs (hsk.json, fof.json, csh.json v26.3) where verified;
 * payloads are simplified for the demo. Shared by the Node server and the in-browser backend.
 */
import type { ChangeSet, Command, CommandResult, HkStatus, Reservation, RoomView } from './types.ts';
import type { PmsEngine } from './engine.ts';
import { queueReservations, roomStatusTile, roomSummary, roomViews, minutesSince } from './selectors.ts';

export interface OhipRequest {
  method: string;
  path: string; // without query string
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface OhipResponse {
  status: number;
  body: unknown;
  /** Change sets produced (commands + api log), to be broadcast to clients. */
  changes: ChangeSet[];
}

export const DEMO_APP_KEY = 'demo-app-key-0001';
export const DEMO_CLIENT_ID = 'demo_client';
export const DEMO_CLIENT_SECRET = 'demo_secret';
export const DEMO_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.demo-ohip-token.signature';

type Handler = (ctx: Ctx) => { status: number; body: unknown };
interface Ctx {
  engine: PmsEngine;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: any;
  changes: ChangeSet[];
  actor: string;
}

const HK_ENUM: HkStatus[] = ['Clean', 'Dirty', 'Pickup', 'Inspected'];
const SERVICE_MAP: Record<string, 'DND' | 'MUR' | null> = {
  DoNotDisturb: 'DND',
  MakeUpRoom: 'MUR',
  NoStatusSelected: null,
  ServiceDeclined: null,
};
const TURNDOWN_MAP: Record<string, 'Required' | 'Not Required' | 'Completed'> = {
  Required: 'Required',
  NotRequired: 'Not Required',
  Compeleted: 'Completed', // sic – OHIP spec spelling
  Completed: 'Completed',
};

const err = (status: number, title: string, detail?: string, code?: string) => ({
  status,
  body: { type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1', title, status, detail: detail ?? title, 'o:errorCode': code ?? String(status) },
});

function run(ctx: Ctx, cmd: Command, source: 'OHIP_API' | 'PBX' = 'OHIP_API'): CommandResult {
  const r = ctx.engine.exec(cmd, { name: ctx.actor, source });
  if (r.changes) ctx.changes.push(r.changes);
  return r;
}

const STATUS_400 = new Set(['VALIDATION', 'PARAM', 'BAD_CODE']);
const ok = (r: CommandResult, extra: Record<string, unknown> = {}) =>
  r.ok
    ? {
        status: 200,
        body: {
          ...extra,
          status: 'success',
          message: r.message,
          businessEvents: (r.changes?.events ?? r.changes?.reset?.events.slice(0, 1) ?? []).map((e) => `${e.id} ${e.eventName}`),
          warnings: r.warnings.map((w) => ({ code: 'WARNING', shortText: w })),
          links: [],
        },
      }
    : err(r.errorCode === 'NOT_FOUND' ? 404 : STATUS_400.has(r.errorCode ?? '') ? 400 : 409, r.error ?? 'Error', r.error, r.errorCode);

function roomOut(v: RoomView) {
  return {
    roomId: v.number,
    roomType: { roomType: v.roomType, description: v.roomTypeName },
    floor: String(v.floor),
    housekeepingSection: v.section,
    roomFeatures: v.features,
    housekeeping: {
      housekeepingRoomStatus: { housekeepingRoomStatus: v.displayStatus },
      frontOfficeStatus: v.foStatus,
      housekeepingStatus: v.hkOccupancy ?? undefined,
      reservationStatus: v.resvStatus.replace(/ /g, ''),
      roomDiscrepancy: v.discrepancies.map((d) => (d === 'Person' ? 'PersonDiscrepancy' : d)),
      guestServiceStatus: v.serviceStatus === 'DND' ? 'DoNotDisturb' : v.serviceStatus === 'MUR' ? 'MakeUpRoom' : 'NoStatusSelected',
      turndownStatus: v.turndown.replace(' ', '').replace('Completed', 'Compeleted'),
      roomCondition: v.conditionCode ?? undefined,
      attendantId: v.attendantId ?? undefined,
      housekeepingPersons: v.hkPersons ?? undefined,
      frontOfficePersons: v.persons,
    },
    outOfOrder: v.outOfOrder
      ? { type: v.outOfOrder.type, start: v.outOfOrder.from, end: v.outOfOrder.to, reasonCode: v.outOfOrder.reasonCode, returnStatus: v.outOfOrder.returnStatus, repairRemarks: v.outOfOrder.remarks }
      : undefined,
  };
}

function resvOut(r: Reservation) {
  return {
    reservationIdList: [{ id: r.id, type: 'Reservation' }, { id: r.confirmationNo, type: 'Confirmation' }],
    guestName: r.guestName,
    roomStay: { arrivalDate: r.arrival, departureDate: r.departure, roomType: r.roomType, roomId: r.roomId?.replace(/^0/, '') ?? null, adultCount: r.adults, childCount: r.children },
    reservationStatus: r.status,
    queue: r.queue ? { queueDate: r.queue.queuedAt, priority: r.queue.priority, minutesInQueue: minutesSince(r.queue.queuedAt) } : undefined,
  };
}

const ROUTES: { method: string; pattern: string; handler: Handler; operationId: string }[] = [];
const route = (method: string, pattern: string, operationId: string, handler: Handler) => ROUTES.push({ method, pattern, handler, operationId });

// ---------------------------------------------------------------- auth
route('POST', '/oauth/v1/tokens', 'getOAuthToken', ({ body }) => {
  const b = body ?? {};
  if (b.grant_type && b.grant_type !== 'client_credentials') return err(400, 'unsupported_grant_type');
  return { status: 200, body: { access_token: DEMO_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'urn:opc:hgbu:ws:__myscopes__' } };
});

// ---------------------------------------------------------------- housekeeping (hsk)
route('GET', '/hsk/v1/hotels/:hotelId/housekeepingOverview', 'getHousekeepingOverview', ({ engine, query }) => {
  let views = roomViews(engine.state);
  const list = (k: string) => query[k]?.split(',').map((x) => x.trim()).filter(Boolean);
  const st = list('housekeepingRoomStatus');
  if (st) views = views.filter((v) => st.includes(v.displayStatus));
  const fo = list('frontOfficeStatus');
  if (fo) views = views.filter((v) => fo.includes(v.foStatus));
  const fl = list('floor');
  if (fl) views = views.filter((v) => fl.includes(String(v.floor)));
  if (query.fromRoomNumber) views = views.filter((v) => +v.number >= +query.fromRoomNumber!);
  if (query.toRoomNumber) views = views.filter((v) => +v.number <= +query.toRoomNumber!);
  const limit = Math.min(+(query.limit ?? 200) || 200, 500);
  const counts = roomStatusTile(roomViews(engine.state));
  return {
    status: 200,
    body: {
      housekeepingRoomInfo: { housekeepingRooms: { room: views.slice(0, limit).map(roomOut) }, totalResults: views.length },
      housekeepingRoomStatusInfoList: counts.map((c) => ({ housekeepingRoomStatus: c.status, occupied: c.occupied, assigned: c.assigned, vacant: c.vacant })),
      links: [],
    },
  };
});

route('PUT', '/hsk/v1/hotels/:hotelId/rooms/status', 'putRoomRelatedStatus', (ctx) => {
  const b = ctx.body ?? {};
  const rooms: string[] = (b.roomList ?? []).map((r: any) => String(r.roomId));
  if (!rooms.length) return err(400, 'roomList is required');
  const extra: Record<string, unknown> = {};
  let last: CommandResult | null = null;
  if (b.housekeepingRoomStatus) {
    if (!HK_ENUM.includes(b.housekeepingRoomStatus))
      return err(400, `Invalid housekeepingRoomStatus "${b.housekeepingRoomStatus}"`, 'Use Clean, Dirty, Pickup or Inspected. OutOfOrder/OutOfService are set via rooms/outOfOrderRooms and rooms/outOfServiceRooms.', 'INVALID_STATUS');
    last = run(ctx, { type: 'setHkStatus', roomIds: rooms, status: b.housekeepingRoomStatus });
    if (!last.ok) return ok(last);
  }
  if (b.housekeepingStatus) {
    if (b.housekeepingStatus !== 'Vacant' && b.housekeepingStatus !== 'Occupied') return err(400, 'housekeepingStatus must be Vacant or Occupied');
    for (const id of rooms) {
      last = run(ctx, { type: 'setHkOccupancy', roomId: id, occupancy: b.housekeepingStatus, persons: b.roomPersons?.houseKeepingPersons });
      if (!last.ok) return ok(last);
    }
  }
  if (b.turndownStatus) {
    const t = TURNDOWN_MAP[b.turndownStatus];
    if (!t) return err(400, 'Invalid turndownStatus');
    last = run(ctx, { type: 'setTurndown', roomIds: rooms, turndown: t });
    if (!last.ok) return ok(last);
  }
  if (!last) return err(400, 'Nothing to update', 'Provide housekeepingRoomStatus, housekeepingStatus or turndownStatus');
  return ok(last, extra);
});

route('GET', '/hsk/v1/hotels/:hotelId/housekeepingDiscrepancies', 'getHousekeepingDiscrepancies', ({ engine, query }) => {
  const want = query.roomDiscrepancyStatus?.split(',').map((x) => (x === 'PersonDiscrepancy' ? 'Person' : x));
  const views = roomViews(engine.state).filter((v) => v.discrepancies.length && (!want || v.discrepancies.some((d) => want.includes(d))));
  return { status: 200, body: { roomDiscrepancies: views.map(roomOut), totalResults: views.length, links: [] } };
});

const oooList = (type: 'OOO' | 'OOS'): Handler => ({ engine }) => {
  const rooms = engine.state.rooms.filter((r) => r.outOfOrder?.type === type);
  return {
    status: 200,
    body: {
      [type === 'OOO' ? 'outOfOrderRooms' : 'outOfServiceRooms']: rooms.map((r) => ({
        roomId: r.number,
        roomRepairId: r.outOfOrder!.id,
        start: r.outOfOrder!.from,
        end: r.outOfOrder!.to,
        reasonCode: r.outOfOrder!.reasonCode,
        reasonDescription: engine.state.oooReasons.find((x) => x.code === r.outOfOrder!.reasonCode)?.description,
        returnStatus: r.outOfOrder!.returnStatus,
        repairRemarks: r.outOfOrder!.remarks,
      })),
      links: [],
    },
  };
};
const oooCreate = (type: 'OOO' | 'OOS'): Handler => (ctx) => {
  const rr = ctx.body?.criteria?.roomRangeList?.[0] ?? ctx.body?.roomRangeList?.[0];
  const ro = rr?.roomOutOfOrder ?? rr?.roomOutOfService ?? {};
  const roomIds: string[] = (rr?.roomIds ?? []).map(String);
  if (!roomIds.length) return err(400, 'criteria.roomRangeList[0].roomIds is required');
  const D = ctx.engine.state.hotel.businessDate;
  const returnStatus = ro.returnStatus ?? 'Dirty';
  if (!HK_ENUM.includes(returnStatus)) return err(400, `Invalid returnStatus "${returnStatus}"`);
  return ok(run(ctx, {
    type: 'placeOutOfOrder', roomIds, oooType: type,
    from: ro.start ?? rr?.range?.start ?? D, to: ro.end ?? rr?.range?.end ?? D,
    reasonCode: ro.reasonCode ?? '', returnStatus, remarks: ro.repairRemarks,
  }));
};
const oooComplete: Handler = (ctx) => {
  const list = ctx.body?.criteria?.roomRepairByRoomNumber ?? ctx.body?.roomRepairByRoomNumber ?? [];
  const roomIds: string[] = list.map((x: any) => String(x.roomId));
  if (!roomIds.length) return err(400, 'criteria.roomRepairByRoomNumber[].roomId is required');
  return ok(run(ctx, { type: 'releaseOutOfOrder', roomIds }));
};
route('GET', '/hsk/v1/hotels/:hotelId/rooms/outOfOrderRooms', 'getOutOfOrderRooms', oooList('OOO'));
route('POST', '/hsk/v1/hotels/:hotelId/rooms/outOfOrderRooms', 'postOutOfOrderRooms', oooCreate('OOO'));
route('PUT', '/hsk/v1/hotels/:hotelId/rooms/outOfOrderRooms', 'completeOutOfOrderRooms', oooComplete);
route('GET', '/hsk/v1/hotels/:hotelId/rooms/outOfServiceRooms', 'getOutOfServiceRooms', oooList('OOS'));
route('POST', '/hsk/v1/hotels/:hotelId/rooms/outOfServiceRooms', 'postOutOfServiceRooms', oooCreate('OOS'));
route('PUT', '/hsk/v1/hotels/:hotelId/rooms/outOfServiceRooms', 'completeOutOfServiceRooms', oooComplete);

route('PUT', '/hsk/v1/hotels/:hotelId/serviceRequests', 'setGuestHousekeepingServiceRequest', (ctx) => {
  const b = ctx.body ?? {};
  const roomId = b.roomId ?? b.housekeepingServiceRequest?.roomId;
  const status = b.guestServiceStatus ?? b.housekeepingServiceRequest?.guestServiceStatus;
  if (!roomId || !(status in SERVICE_MAP)) return err(400, 'roomId and guestServiceStatus (DoNotDisturb|MakeUpRoom|NoStatusSelected) are required');
  return ok(run(ctx, { type: 'setServiceStatus', roomIds: [String(roomId)], service: SERVICE_MAP[status] }));
});

route('GET', '/hsk/v1/hotels/:hotelId/conditions', 'getRoomConditions', ({ engine }) => ({
  status: 200,
  body: {
    roomConditions: engine.state.rooms.filter((r) => r.conditionCode).map((r) => ({ roomId: r.number, condition: r.conditionCode })),
    conditionCodes: engine.state.conditions.map((c) => ({ code: c.code, description: c.description, assignmentType: c.blocksAssignment ? 'NotAvailable' : 'Available' })),
    links: [],
  },
}));
route('PUT', '/hsk/v1/hotels/:hotelId/conditions', 'setRoomCondition', (ctx) => {
  const b = ctx.body ?? {};
  const rooms: string[] = (b.roomList ?? (b.roomId ? [{ roomId: b.roomId }] : [])).map((r: any) => String(r.roomId));
  if (!rooms.length) return err(400, 'roomList is required');
  return ok(run(ctx, { type: 'setCondition', roomIds: rooms, conditionCode: b.condition ?? b.conditionCode ?? null }));
});

// ---------------------------------------------------------------- front office (fof / csh)
route('GET', '/fof/v1/hotels/:hotelId/roomStatusStatistics', 'getRoomsByRoomStatus', ({ engine }) => {
  const views = roomViews(engine.state);
  const sum = roomSummary(engine.state, views);
  return { status: 200, body: { roomStatusStatistics: roomStatusTile(views), roomSummary: sum, links: [] } };
});
route('GET', '/fof/v1/hotels/:hotelId/rooms', 'getHotelRooms', ({ engine, query }) => {
  let views = roomViews(engine.state);
  if (query.roomType) views = views.filter((v) => v.roomType === query.roomType);
  if (query.frontOfficeStatus) views = views.filter((v) => v.foStatus === query.frontOfficeStatus);
  if (query.housekeepingRoomStatus) views = views.filter((v) => v.displayStatus === query.housekeepingRoomStatus);
  return { status: 200, body: { hotelRoomsDetails: { room: views.map(roomOut) }, totalResults: views.length, links: [] } };
});
route('GET', '/fof/v1/hotels/:hotelId/queuedReservations', 'getQueuedReservations', ({ engine }) => ({
  status: 200,
  body: { reservations: queueReservations(engine.state).map(resvOut), links: [] },
}));
route('GET', '/fof/v1/hotels/:hotelId/queueReservationsStatistics', 'getQueueReservationsStatistics', ({ engine }) => {
  const q = queueReservations(engine.state);
  const avg = q.length ? Math.round(q.reduce((a, r) => a + minutesSince(r.queue!.queuedAt), 0) / q.length) : 0;
  return { status: 200, body: { totalInQueue: q.length, averageQueueTimeCurrentReservations: avg, links: [] } };
});
route('POST', '/fof/v1/hotels/:hotelId/reservations/:reservationId/roomAssignments', 'postRoomAssignment', (ctx) => {
  const b = ctx.body ?? {};
  const roomId = b.roomId ?? b.criteria?.roomId;
  if (!roomId) return err(400, 'roomId (or criteria.roomId) is required');
  const force = !!(b.overrideRoomType ?? b.criteria?.updateRoomTypeCharged ?? b.criteria?.overrides?.roomType ?? b.upgradeAllowed);
  return ok(run(ctx, { type: 'assignRoom', reservationId: ctx.params.reservationId, roomId: String(roomId), force }));
});
route('POST', '/fof/v1/hotels/:hotelId/reservations/:reservationId/checkIns', 'postCheckIn', (ctx) => {
  const b = ctx.body ?? {};
  const roomId = b.reservation?.roomId ?? b.roomId;
  if (roomId) {
    const a = run(ctx, { type: 'assignRoom', reservationId: ctx.params.reservationId, roomId: String(roomId) });
    if (!a.ok) return ok(a);
  }
  // OHIP stopCheckin=true: put the arrival in the room queue instead of checking in
  if (b.stopCheckin) return ok(run(ctx, { type: 'queueReservation', reservationId: ctx.params.reservationId }));
  return ok(run(ctx, { type: 'checkIn', reservationId: ctx.params.reservationId }));
});
route('PUT', '/fof/v1/hotels/:hotelId/queuedReservations/:reservationId', 'putQueuedReservation', (ctx) =>
  ok(run(ctx, { type: 'queueReservation', reservationId: ctx.params.reservationId, priority: ctx.body?.priority })),
);
route('DELETE', '/fof/v1/hotels/:hotelId/queuedReservations/:reservationId', 'deleteQueuedReservation', (ctx) =>
  ok(run(ctx, { type: 'removeFromQueue', reservationId: ctx.params.reservationId })),
);
route('PUT', '/fof/v1/hotels/:hotelId/reservations/:reservationId/rooms/:roomId/roomMoves', 'moveInHouseGuest', (ctx) =>
  ok(run(ctx, { type: 'roomMove', reservationId: ctx.params.reservationId, toRoomId: ctx.params.roomId, reason: ctx.body?.reason ?? ctx.body?.roomMoveReason })),
);
route('POST', '/csh/v1/hotels/:hotelId/reservations/:reservationId/checkOuts', 'postCheckOut', (ctx) =>
  ok(run(ctx, { type: 'checkOut', reservationId: ctx.params.reservationId })),
);
route('PUT', '/fof/v1/hotels/:hotelId/interfaces/:interfaceId/roomStatuses', 'putRoomInterfaceStatus', (ctx) => {
  // Demo semantics: PBX posts the room status code dialled from the guest room phone.
  const b = ctx.body ?? {};
  const roomId = b.roomId ?? b.roomExtension;
  if (!roomId || !b.statusCode) return err(400, 'roomId and statusCode are required (codes 1-6, see API console)');
  return ok(run(ctx, { type: 'pbxStatusCode', roomNumber: String(roomId), code: String(b.statusCode) }, 'PBX'));
});

// ---------------------------------------------------------------- polling API (business events)
route('GET', '/api/events', 'pollBusinessEvents', ({ engine, query }) => {
  const since = +(query.sinceSeq ?? 0) || 0;
  const events = engine.state.events.filter((e) => e.seq > since).reverse().slice(0, 100);
  return { status: 200, body: { events, lastSeq: events.at(-1)?.seq ?? since, hasMore: engine.state.events.some((e) => e.seq > (events.at(-1)?.seq ?? since)) } };
});

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export const OHIP_ROUTES = () => ROUTES.map((r) => ({ method: r.method, path: r.pattern.replace(/:(\w+)/g, '{$1}'), operationId: r.operationId }));

/** Dispatch an OHIP-style request. Validates the OHIP headers like the real gateway (simplified). */
export function handleOhip(engine: PmsEngine, req: OhipRequest, opts: { log?: boolean } = {}): OhipResponse {
  const changes: ChangeSet[] = [];
  const method = req.method.toUpperCase();
  const h = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let res: { status: number; body: unknown };
  const r = ROUTES.map((x) => ({ x, params: x.method === method ? match(x.pattern, req.path) : null })).find((m) => m.params);
  if (!r) {
    res = err(404, `No route for ${method} ${req.path}`);
  } else {
    const isAuth = r.x.pattern.startsWith('/oauth');
    const isPoll = r.x.pattern.startsWith('/api/');
    if (!isAuth && !isPoll && h['authorization'] !== `Bearer ${DEMO_TOKEN}`) res = err(401, 'Unauthorized', 'Missing or invalid Bearer token. Call POST /oauth/v1/tokens first.', 'INVALID_TOKEN');
    else if (!h['x-app-key'] && !isPoll) res = err(401, 'Unauthorized', 'x-app-key header is required', 'MISSING_APP_KEY');
    else if (!isAuth && !isPoll && r.params!.hotelId !== undefined && h['x-hotelid'] !== r.params!.hotelId)
      res = err(400, 'Bad Request', `x-hotelid header (${h['x-hotelid'] ?? 'missing'}) must match hotelId in the path (${r.params!.hotelId})`, 'HOTEL_MISMATCH');
    else if (r.params!.hotelId !== undefined && r.params!.hotelId !== engine.state.hotel.hotelId)
      res = err(404, 'Hotel not found', `Unknown hotel ${r.params!.hotelId}; this demo property is ${engine.state.hotel.hotelId}`, 'HOTEL_NOT_FOUND');
    else {
      try {
        res = r.x.handler({ engine, params: r.params!, query: req.query ?? {}, body: req.body, changes, actor: h['x-externalsystem'] ?? h['x-app-key'] ?? 'OHIP' });
      } catch (e) {
        res = err(500, 'Internal error', String(e));
      }
    }
  }
  if (opts.log !== false && !(method === 'GET' && req.path === '/api/events')) {
    changes.push(engine.logApi({ method, path: req.path + (req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query as Record<string, string>).toString() : ''), status: res.status, requestBody: req.body, responseBody: res.status >= 400 ? res.body : undefined, appKey: h['x-app-key'] }));
  }
  return { ...res, changes };
}
