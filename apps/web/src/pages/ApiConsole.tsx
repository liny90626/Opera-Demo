import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEMO_APP_KEY, DEMO_TOKEN, isRoomReady, type BusinessEvent, type Snapshot, type RoomView } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Alert, Button, Field, PageHeader, Select, TextInput, cx } from '../components/ui';
import { roomNo } from '../components/status';
import './ApiConsole.css';

type Hdr = { k: string; v: string; on: boolean };
interface Sample {
  id: string;
  group: string;
  name: string;
  method: string;
  path: string;
  query?: string;
  body?: unknown;
  off?: string[]; // headers to disable
  hdr?: Record<string, string>; // header overrides
  note?: string;
}

const GROUPS = ['Auth', 'Housekeeping (hsk)', 'OOO / OOS', 'Front Office (fof / csh)', 'Queue', 'Interfaces / PBX', 'Polling'];

const ERR_HINT: Record<string, string> = {
  INVALID_TOKEN: 'Bearer token missing/invalid – call POST /oauth/v1/tokens first',
  MISSING_APP_KEY: 'x-app-key header is required',
  HOTEL_MISMATCH: 'x-hotelid header must equal the hotelId in the path',
  HOTEL_NOT_FOUND: 'Unknown hotel id',
  INVALID_STATUS: 'housekeepingRoomStatus must be Clean/Dirty/Pickup/Inspected',
  ROOM_NOT_READY: 'Room is not Clean/Inspected or has a blocking condition (queue the guest instead)',
  ROOM_TYPE_MISMATCH: 'Room type differs from the reservation (set overrideRoomType)',
  BAD_CODE: 'PBX code not in 1-6',
  NOT_FOUND: 'Room / reservation not found',
  VALIDATION: 'Request failed business validation',
};

const PBX_CODES = [
  { c: '1', l: 'Clean' },
  { c: '2', l: 'Dirty' },
  { c: '3', l: 'Inspected' },
  { c: '4', l: 'Pickup' },
  { c: '5', l: 'HK Occupied' },
  { c: '6', l: 'HK Vacant' },
];

function buildSamples(s: Snapshot, views: RoomView[]): Sample[] {
  const H = s.hotel.hotelId;
  const D = s.hotel.businessDate;
  const vacant = views.filter((v) => v.foStatus === 'Vacant' && !v.oooActive);
  const dirty = vacant.find((v) => v.displayStatus === 'Dirty') ?? vacant[0];
  const ready = (type?: string) => vacant.find((v) => v.displayStatus !== 'Dirty' && v.displayStatus !== 'Pickup' && (!type || v.roomType === type) && isRoomReady(s, s.rooms.find((r) => r.id === v.id)!) && !v.arrival);
  const inHouseRoom = views.find((v) => v.inHouse && !v.oooActive);
  const dueOut = s.reservations.find((r) => r.status === 'InHouse' && r.departure <= D);
  const stay = s.reservations.find((r) => r.status === 'InHouse' && r.departure > D);
  const arrivals = s.reservations.filter((r) => r.status === 'Reserved' && r.arrival <= D);
  const unassigned = arrivals.find((r) => !r.roomId && ready(r.roomType)) ?? arrivals.find((r) => !r.roomId);
  const assignedReady = arrivals.find((r) => r.roomId && views.find((v) => v.id === r.roomId && v.displayStatus !== 'Dirty' && v.displayStatus !== 'Pickup' && !v.oooActive && !v.inHouse));
  const dirtyForType = (type: string) => vacant.find((v) => v.roomType === type && v.displayStatus === 'Dirty') ?? dirty;
  const queued = s.reservations.find((r) => r.queue);
  const ooo = views.find((v) => v.outOfOrder?.type === 'OOO' && v.oooActive);
  const oos = views.find((v) => v.outOfOrder?.type === 'OOS' && v.oooActive);
  const reason = s.oooReasons[0]?.code ?? 'PLB';
  const rn = (v?: RoomView) => v?.number ?? '0101';
  const rid = (r?: { confirmationNo: string }) => r?.confirmationNo ?? '1';
  const base = `/hsk/v1/hotels/${H}`;
  const fof = `/fof/v1/hotels/${H}`;
  const oooFree = vacant.find((v) => v !== dirty && v.displayStatus !== 'Dirty') ?? vacant[1] ?? dirty;
  const moveTarget = ready(stay?.roomType);

  const L: Sample[] = [
    { id: 'tok', group: GROUPS[0], name: 'Get token', method: 'POST', path: '/oauth/v1/tokens', body: { grant_type: 'client_credentials' }, off: ['Authorization'], note: 'Returns access_token; the "Get token" button fills the Authorization header.' },
    { id: 'noKey', group: GROUPS[0], name: 'Missing app key (401)', method: 'GET', path: `${fof}/roomStatusStatistics`, off: ['x-app-key'] },
    { id: 'badTok', group: GROUPS[0], name: 'Invalid token (401)', method: 'GET', path: `${fof}/roomStatusStatistics`, hdr: { Authorization: 'Bearer wrong-token' } },
    { id: 'badHotel', group: GROUPS[0], name: 'Hotel mismatch (400)', method: 'GET', path: `${fof}/roomStatusStatistics`, hdr: { 'x-hotelid': 'OTHER' } },

    { id: 'ov', group: GROUPS[1], name: 'Housekeeping overview', method: 'GET', path: `${base}/housekeepingOverview`, query: 'housekeepingRoomStatus=Dirty&frontOfficeStatus=Vacant&limit=20' },
    { id: 'setClean', group: GROUPS[1], name: `Set room status: ${rn(dirty)} → Clean`, method: 'PUT', path: `${base}/rooms/status`, body: { roomList: [{ roomId: rn(dirty) }], housekeepingRoomStatus: 'Clean' }, note: 'Emits UPDATE ROOM STATUS (source OHIP_API) to subscribers.' },
    { id: 'setInsp', group: GROUPS[1], name: `Set room status: ${rn(dirty)} → Inspected`, method: 'PUT', path: `${base}/rooms/status`, body: { roomList: [{ roomId: rn(dirty) }], housekeepingRoomStatus: 'Inspected' } },
    { id: 'setBad', group: GROUPS[1], name: 'Set status OutOfOrder (400)', method: 'PUT', path: `${base}/rooms/status`, body: { roomList: [{ roomId: rn(dirty) }], housekeepingRoomStatus: 'OutOfOrder' } },
    { id: 'hkOcc', group: GROUPS[1], name: `HK occupancy: ${rn(dirty)} → Occupied`, method: 'PUT', path: `${base}/rooms/status`, body: { roomList: [{ roomId: rn(dirty) }], housekeepingStatus: 'Occupied', roomPersons: { houseKeepingPersons: 2 } }, note: 'Creates a Skip/Sleep discrepancy when FO says otherwise.' },
    { id: 'turn', group: GROUPS[1], name: 'Turndown status', method: 'PUT', path: `${base}/rooms/status`, body: { roomList: [{ roomId: rn(inHouseRoom) }], turndownStatus: 'Required' } },
    { id: 'disc', group: GROUPS[1], name: 'Discrepancies', method: 'GET', path: `${base}/housekeepingDiscrepancies` },
    { id: 'svc', group: GROUPS[1], name: `Guest service: ${rn(inHouseRoom)} DND`, method: 'PUT', path: `${base}/serviceRequests`, body: { roomId: rn(inHouseRoom), guestServiceStatus: 'DoNotDisturb' } },
    { id: 'cond', group: GROUPS[1], name: 'Set room condition', method: 'PUT', path: `${base}/conditions`, body: { roomList: [{ roomId: rn(dirty) }], condition: s.conditions[0]?.code ?? null } },
    { id: 'conds', group: GROUPS[1], name: 'Room conditions', method: 'GET', path: `${base}/conditions` },

    { id: 'oooList', group: GROUPS[2], name: 'List Out of Order', method: 'GET', path: `${base}/rooms/outOfOrderRooms` },
    { id: 'oosList', group: GROUPS[2], name: 'List Out of Service', method: 'GET', path: `${base}/rooms/outOfServiceRooms` },
    { id: 'oooPlace', group: GROUPS[2], name: `Place OOO: ${rn(oooFree)}`, method: 'POST', path: `${base}/rooms/outOfOrderRooms`, body: { criteria: { roomRangeList: [{ roomIds: [rn(oooFree)], roomOutOfOrder: { start: D, end: D.replace(/\d\d$/, (d) => String(Math.min(28, +d + 2)).padStart(2, '0')), reasonCode: reason, returnStatus: 'Dirty', repairRemarks: 'Created from API console' } }] } }, note: 'OOO reduces sellable inventory → Channel Manager mirror changes.' },
    { id: 'oosPlace', group: GROUPS[2], name: `Place OOS: ${rn(oooFree)}`, method: 'POST', path: `${base}/rooms/outOfServiceRooms`, body: { criteria: { roomRangeList: [{ roomIds: [rn(oooFree)], roomOutOfService: { start: D, end: D, reasonCode: reason, returnStatus: 'Dirty' } }] } } },
    { id: 'oooConflict', group: GROUPS[2], name: `Place OOO on occupied ${rn(inHouseRoom)} (conflict)`, method: 'POST', path: `${base}/rooms/outOfOrderRooms`, body: { criteria: { roomRangeList: [{ roomIds: [rn(inHouseRoom)], roomOutOfOrder: { start: D, end: D, reasonCode: reason, returnStatus: 'Dirty' } }] } } },
    { id: 'oooRet', group: GROUPS[2], name: `Return OOO: ${rn(ooo)}`, method: 'PUT', path: `${base}/rooms/outOfOrderRooms`, body: { criteria: { roomRepairByRoomNumber: [{ roomId: rn(ooo) }] } } },
    { id: 'oosRet', group: GROUPS[2], name: `Return OOS: ${rn(oos)}`, method: 'PUT', path: `${base}/rooms/outOfServiceRooms`, body: { criteria: { roomRepairByRoomNumber: [{ roomId: rn(oos) }] } } },

    { id: 'stats', group: GROUPS[3], name: 'Room status statistics', method: 'GET', path: `${fof}/roomStatusStatistics` },
    { id: 'rooms', group: GROUPS[3], name: 'Hotel rooms (filtered)', method: 'GET', path: `${fof}/rooms`, query: 'frontOfficeStatus=Vacant&housekeepingRoomStatus=Clean' },
    { id: 'assign', group: GROUPS[3], name: `Assign room ${rn(ready(unassigned?.roomType))} to #${rid(unassigned)}`, method: 'POST', path: `${fof}/reservations/${rid(unassigned)}/roomAssignments`, body: { roomId: rn(ready(unassigned?.roomType)) } },
    { id: 'checkin', group: GROUPS[3], name: `Check in #${rid(assignedReady)}`, method: 'POST', path: `${fof}/reservations/${rid(assignedReady)}/checkIns`, body: {} },
    { id: 'checkinNR', group: GROUPS[3], name: `Check in #${rid(unassigned)} (room not ready)`, method: 'POST', path: `${fof}/reservations/${rid(unassigned)}/checkIns`, body: { reservation: { roomId: rn(dirtyForType(unassigned?.roomType ?? '')) } }, note: 'Expect 409 ROOM_NOT_READY (dirty room).' },
    { id: 'move', group: GROUPS[3], name: `Room move #${rid(stay)} → ${rn(moveTarget)}`, method: 'PUT', path: `${fof}/reservations/${rid(stay)}/rooms/${rn(moveTarget)}/roomMoves`, body: { reason: 'Guest request' } },
    { id: 'checkout', group: GROUPS[3], name: `Check out #${rid(dueOut)}`, method: 'POST', path: `/csh/v1/hotels/${H}/reservations/${rid(dueOut)}/checkOuts`, body: {}, note: 'Emits CHECK OUT → Door lock/PBX/BMS and sets the room Dirty.' },

    { id: 'qList', group: GROUPS[4], name: 'Queued reservations', method: 'GET', path: `${fof}/queuedReservations` },
    { id: 'qStats', group: GROUPS[4], name: 'Queue statistics', method: 'GET', path: `${fof}/queueReservationsStatistics` },
    { id: 'qAdd', group: GROUPS[4], name: `Add #${rid(unassigned)} to queue`, method: 'PUT', path: `${fof}/queuedReservations/${rid(unassigned)}`, body: { priority: 1 } },
    { id: 'qStop', group: GROUPS[4], name: `Check in with stopCheckin (queue) #${rid(unassigned)}`, method: 'POST', path: `${fof}/reservations/${rid(unassigned)}/checkIns`, body: { stopCheckin: true, reservation: { roomId: rn(dirtyForType(unassigned?.roomType ?? '')) } } },
    { id: 'qDel', group: GROUPS[4], name: `Remove #${rid(queued)} from queue`, method: 'DELETE', path: `${fof}/queuedReservations/${rid(queued)}` },

    { id: 'pbx2', group: GROUPS[5], name: `PBX code 2 (Dirty): ${rn(ready())}`, method: 'PUT', path: `${fof}/interfaces/PBX/roomStatuses`, body: { roomId: rn(ready()), statusCode: '2' } },
    { id: 'pbx1', group: GROUPS[5], name: `PBX code 1 (Clean): ${rn(dirty)}`, method: 'PUT', path: `${fof}/interfaces/PBX/roomStatuses`, body: { roomId: rn(dirty), statusCode: '1' } },
    { id: 'pbxBad', group: GROUPS[5], name: 'PBX bad code 7 (400)', method: 'PUT', path: `${fof}/interfaces/PBX/roomStatuses`, body: { roomId: rn(dirty), statusCode: '7' } },

    { id: 'poll0', group: GROUPS[6], name: 'GET /api/events?sinceSeq=0', method: 'GET', path: '/api/events', query: 'sinceSeq=0', off: ['Authorization', 'x-app-key', 'x-hotelid'], note: 'Polling API – no auth required in the demo.' },
    { id: 'pollN', group: GROUPS[6], name: 'Poll since latest seq', method: 'GET', path: '/api/events', query: `sinceSeq=${Math.max(0, (s.events[0]?.seq ?? 0) - 5)}`, off: ['Authorization', 'x-app-key', 'x-hotelid'] },
  ];
  return L;
}

const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function highlight(json: string) {
  return esc(json).replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, (m, str, colon, bool, num) => {
    if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
    if (bool) return `<span class="b">${bool}</span>`;
    if (num) return `<span class="n">${num}</span>`;
    return m;
  });
}

function jsonError(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const msg = String((e as Error).message);
    const m = /position (\d+)/.exec(msg);
    if (m) {
      const line = text.slice(0, +m[1]).split('\n').length;
      return `Line ${line}: ${msg.replace(/^.*?JSON\.parse: /, '')}`;
    }
    return msg;
  }
}

const statusClass = (n: number) => (n >= 500 || n === 0 ? 's5' : n >= 400 ? 's4' : 's2');
const fmtSec = (iso: string) => new Date(iso).toLocaleTimeString('en-GB');
const defaultHeaders = (hotel: string): Hdr[] => [
  { k: 'x-hotelid', v: hotel, on: true },
  { k: 'x-app-key', v: DEMO_APP_KEY, on: true },
  { k: 'Authorization', v: `Bearer ${DEMO_TOKEN}`, on: true },
  { k: 'Content-Type', v: 'application/json', on: true },
];

export default function ApiConsole() {
  const t = useT();
  const nav = useNavigate();
  const { snapshot, views, ohip, toast } = useStore();
  const hotel = snapshot.hotel.hotelId;
  const samples = useMemo(() => buildSamples(snapshot, views), [snapshot, views]);

  const [selId, setSelId] = useState('setClean');
  const [method, setMethod] = useState('PUT');
  const [path, setPath] = useState(`/hsk/v1/hotels/${hotel}/rooms/status`);
  const [query, setQuery] = useState('');
  const [headers, setHeaders] = useState<Hdr[]>(() => defaultHeaders(hotel));
  const [bodyText, setBodyText] = useState(() => JSON.stringify(samples.find((x) => x.id === 'setClean')?.body ?? {}, null, 2));
  const [sending, setSending] = useState(false);
  const [resp, setResp] = useState<{ status: number; body: unknown; ms: number } | null>(null);
  const [netErr, setNetErr] = useState<string | null>(null);
  const [sinceSeq, setSinceSeq] = useState<number | null>(null);

  const headSeq = snapshot.events[0]?.seq ?? 0;
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

  const applySample = (sm: Sample) => {
    setSelId(sm.id);
    setMethod(sm.method);
    setPath(sm.path);
    setQuery(sm.query ?? '');
    setBodyText(sm.body === undefined ? '' : JSON.stringify(sm.body, null, 2));
    setHeaders((cur) => cur.map((h) => ({ ...h, v: sm.hdr?.[h.k] ?? h.v, on: !sm.off?.includes(h.k) })));
    setResp(null);
    setNetErr(null);
  };

  const bodyErr = jsonError(bodyText);
  const hasBody = method !== 'GET' && method !== 'DELETE' && bodyText.trim() !== '';

  const send = async (over?: { method?: string; path?: string; query?: string; headers?: Hdr[]; body?: string }) => {
    const m = over?.method ?? method;
    let p = over?.path ?? path;
    let q = over?.query ?? query;
    if (p.includes('?')) {
      const [a, b] = p.split('?');
      p = a;
      q = q ? `${b}&${q}` : b;
    }
    const hs = over?.headers ?? headers;
    const bt = over?.body ?? bodyText;
    const hdrs: Record<string, string> = {};
    hs.filter((h) => h.on && h.k.trim()).forEach((h) => (hdrs[h.k.trim()] = h.v));
    const qs: Record<string, string> = {};
    new URLSearchParams(q).forEach((v, k) => (qs[k] = v));
    let body: unknown;
    if (m !== 'GET' && bt.trim()) body = JSON.parse(bt);
    const before = snapRef.current.events[0]?.seq ?? 0;
    setSinceSeq(before);
    setSending(true);
    setNetErr(null);
    try {
      const r = await ohip({ method: m, path: p, query: qs, headers: hdrs, body });
      setResp({ status: r.status, body: r.body, ms: r.durationMs });
    } catch (e) {
      setResp(null);
      setNetErr(String((e as Error).message ?? e));
    } finally {
      setSending(false);
    }
    return;
  };

  const getToken = async () => {
    setSending(true);
    try {
      const r = await ohip({ method: 'POST', path: '/oauth/v1/tokens', headers: { 'x-app-key': headers.find((h) => h.k === 'x-app-key')?.v ?? DEMO_APP_KEY, 'Content-Type': 'application/json' }, body: { grant_type: 'client_credentials' } });
      setResp({ status: r.status, body: r.body, ms: r.durationMs });
      const tok = (r.body as { access_token?: string })?.access_token;
      if (tok) {
        setHeaders((hs) => hs.map((h) => (h.k === 'Authorization' ? { ...h, v: `Bearer ${tok}`, on: true } : h)));
        toast('success', t('Token received and placed in the Authorization header', '已获取 token 并填入 Authorization'));
      }
    } catch (e) {
      setNetErr(String((e as Error).message ?? e));
    } finally {
      setSending(false);
    }
  };

  const newEvents: BusinessEvent[] = sinceSeq === null ? [] : snapshot.events.filter((e) => e.seq > sinceSeq);
  const respErrCode = (resp?.body as Record<string, unknown> | undefined)?.['o:errorCode'] as string | undefined;
  const respText = resp ? JSON.stringify(resp.body, null, 2) : '';

  // pickers
  const pickRoom = (v: string) => {
    if (!v) return;
    const cur = samples.find((x) => x.id === selId);
    const old = JSON.stringify(cur?.body ?? '').match(/"roomId":"(\w+)"/)?.[1];
    if (old) {
      setBodyText((b) => b.split(`"${old}"`).join(`"${v}"`));
      setPath((p) => p.split(`/${old}/`).join(`/${v}/`));
    } else setBodyText((b) => b.replace(/"roomId":\s*"\w+"/, `"roomId": "${v}"`));
  };
  const pickResv = (v: string) => {
    if (!v) return;
    setPath((p) => p.replace(/(reservations|queuedReservations)\/[^/]+/, `$1/${v}`));
  };

  const mountLog = useRef(new Set(snapshot.apiLog.map((a) => a.id)));

  return (
    <div className="page">
      <PageHeader
        title={t('OHIP API Console', 'OHIP API 控制台')}
        breadcrumb={[{ label: 'Integration (OHIP)' }, { label: 'API Console' }]}
        sub={t(
          `Postman-style client for the OHIP-style façade of hotel ${hotel}. Requests go through the same engine as the UI, so every call produces real business events.`,
          `针对酒店 ${hotel} 的 OHIP 风格 REST 门面的 Postman 式客户端。请求与界面共用同一引擎，因此每次调用都会产生真实业务事件。`,
        )}
        actions={<Button onClick={() => nav('/integration/sync-monitor')}>Sync Monitor →</Button>}
      />

      <div className="ac-layout">
        {/* ------------------------------------------ catalogue */}
        <div className="card ac-cat">
          {GROUPS.map((g) => (
            <details key={g} open={g === GROUPS[1] || samples.find((x) => x.id === selId)?.group === g}>
              <summary>{g}</summary>
              {samples.filter((x) => x.group === g).map((sm) => (
                <button key={sm.id} className={cx('ac-item', sm.id === selId && 'on')} onClick={() => applySample(sm)}>
                  <span className={`ac-m ${sm.method}`}>{sm.method}</span>
                  <span>{sm.name}</span>
                </button>
              ))}
            </details>
          ))}
        </div>

        <div className="ac-main">
          {/* ------------------------------------------ request */}
          <div className="card card-pad col" style={{ gap: 10 }}>
            <div className="ac-urlbar">
              <Select value={method} onChange={(v) => setMethod(v || 'GET')} options={['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => ({ value: m, label: m }))} />
              <input className="input path" value={path} onChange={(e) => setPath(e.target.value)} aria-label="path" spellCheck={false} />
              <Button variant="primary" disabled={sending || (hasBody && !!bodyErr)} onClick={() => void send()}>
                {sending ? '…' : 'Send'}
              </Button>
            </div>
            <Field label={t('Query string', '查询参数')}>
              <TextInput value={query} onChange={setQuery} placeholder="sinceSeq=0&limit=20" />
            </Field>
            {samples.find((x) => x.id === selId)?.note && <div className="ac-hint">ⓘ {samples.find((x) => x.id === selId)!.note}</div>}

            <div>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <b style={{ fontSize: 13 }}>Headers</b>
                <div className="row-wrap">
                  <Button size="sm" onClick={() => void getToken()}>{t('Get token', '获取 token')}</Button>
                  <Button size="sm" variant="link" onClick={() => setHeaders(defaultHeaders(hotel))}>{t('Reset', '重置')}</Button>
                </div>
              </div>
              {headers.map((h, i) => (
                <div key={i} className={cx('ac-hdr', !h.on && 'off')}>
                  <input type="checkbox" checked={h.on} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} aria-label={`enable ${h.k}`} />
                  <input className="input" value={h.k} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                  <input className="input" value={h.v} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                  <button className="x-btn" aria-label="remove" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
              <Button size="sm" variant="link" onClick={() => setHeaders([...headers, { k: '', v: '', on: true }])}>+ header</Button>
            </div>

            <div>
              <div className="row-wrap" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <b style={{ fontSize: 13 }}>Body (JSON)</b>
                <div className="row-wrap">
                  <Select
                    value=""
                    onChange={pickRoom}
                    placeholder={t('Pick a room…', '选择房间…')}
                    options={views.slice(0, 400).map((v) => ({ value: v.number, label: `${v.number} · ${v.displayStatus} · ${v.foStatus}` }))}
                  />
                  <Select
                    value=""
                    onChange={pickResv}
                    placeholder={t('Pick a reservation…', '选择预订…')}
                    options={snapshot.reservations.filter((r) => r.status !== 'CheckedOut').slice(0, 300).map((r) => ({ value: r.confirmationNo, label: `#${r.confirmationNo} ${r.guestName} · ${r.status}` }))}
                  />
                  <Button size="sm" disabled={!!bodyErr || !bodyText.trim()} onClick={() => setBodyText(JSON.stringify(JSON.parse(bodyText), null, 2))}>Format</Button>
                </div>
              </div>
              <textarea className={cx('textarea ac-body', bodyErr && 'bad')} value={bodyText} onChange={(e) => setBodyText(e.target.value)} spellCheck={false} placeholder={method === 'GET' ? t('(no body for GET)', '（GET 无请求体）') : '{ }'} />
              {bodyErr ? <div className="field-error">✖ {bodyErr}</div> : bodyText.trim() ? <div className="ac-hint" style={{ color: '#2a7a2e' }}>✔ valid JSON</div> : null}
            </div>
          </div>

          {netErr && <Alert kind="error">{t('Request failed (network)', '请求失败（网络）')}: {netErr}</Alert>}

          {/* ------------------------------------------ response */}
          <div className="card card-pad col" style={{ gap: 8 }}>
            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <div className="row-wrap">
                <b>Response</b>
                {resp && (
                  <>
                    <span className={cx('ac-st', statusClass(resp.status))}>{resp.status}</span>
                    <span className="muted">{resp.ms} ms</span>
                    {respErrCode && <span className="badge warn" title={ERR_HINT[respErrCode] ?? ''}>o:errorCode {respErrCode}</span>}
                  </>
                )}
              </div>
              {resp && (
                <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(respText); toast('info', t('Copied', '已复制')); }}>Copy</Button>
              )}
            </div>
            {respErrCode && ERR_HINT[respErrCode] && <div className="ac-hint">⚠ {ERR_HINT[respErrCode]}</div>}
            {resp ? <pre className="ac-resp" dangerouslySetInnerHTML={{ __html: highlight(respText) }} /> : <div className="muted">{t('Choose a sample on the left and press Send.', '在左侧选择样例并点击 Send。')}</div>}
          </div>

          {/* ------------------------------------------ resulting events */}
          <div className="card card-pad">
            <div className="row-wrap" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <b>{t('Resulting business events', '产生的业务事件')} <span className="muted" style={{ fontWeight: 400 }}>({t('seq >', 'seq >')} {sinceSeq ?? headSeq})</span></b>
              <span className={cx('badge', newEvents.length ? 'ok' : 'neutral')}>{newEvents.length}</span>
            </div>
            {newEvents.length === 0 ? (
              <div className="muted">{sinceSeq === null ? t('Send a request that changes state (e.g. Set room status).', '发送一个会改变状态的请求（如 Set room status）。') : t('This request produced no business events.', '该请求未产生业务事件。')}</div>
            ) : (
              newEvents.map((e) => (
                <div key={e.id} className="ac-evrow" onClick={() => nav('/integration/sync-monitor')}>
                  <b className="mono">#{e.seq}</b>
                  <span>{e.eventName}</span>
                  <span className="muted">{e.summary}</span>
                  <span className="badge neutral">{e.source}</span>
                </div>
              ))
            )}
          </div>

          <div className="grid-2">
            <PbxPanel />
            <PollPanel />
          </div>

          {/* ------------------------------------------ history */}
          <div className="card card-pad">
            <b>{t('API call log', 'API 调用日志')} <span className="muted" style={{ fontWeight: 400 }}>({t('live, includes other tabs / curl', '实时，含其他标签页/curl')})</span></b>
            <div className="table-wrap" style={{ maxHeight: 320, marginTop: 8 }}>
              <table className="dt">
                <thead><tr><th>{t('Time', '时间')}</th><th>Method</th><th>Path</th><th>Status</th><th>app-key</th></tr></thead>
                <tbody>
                  {snapshot.apiLog.slice(0, 60).map((a) => (
                    <tr
                      key={a.id}
                      className={cx('clickable', !mountLog.current.has(a.id) && 'ac-log-new')}
                      onClick={() => {
                        const [p, q] = a.path.split('?');
                        setMethod(a.method);
                        setPath(p);
                        setQuery(q ?? '');
                        setBodyText(a.requestBody === undefined ? '' : JSON.stringify(a.requestBody, null, 2));
                        setSelId('');
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      <td className="mono">{fmtSec(a.timestamp)}</td>
                      <td><span className={`ac-m ${a.method}`}>{a.method}</span></td>
                      <td className="mono" style={{ minWidth: 260 }}>{a.path}</td>
                      <td><span className={cx('ac-st', statusClass(a.status))}>{a.status}</span></td>
                      <td className="mono subtle">{a.appKey ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {snapshot.apiLog.length === 0 && <div className="empty"><div className="title">{t('No API calls yet', '暂无 API 调用')}</div></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ======================================================================= PBX simulator
function PbxPanel() {
  const t = useT();
  const { snapshot, ohip, views } = useStore();
  const [room, setRoom] = useState('');
  const [code, setCode] = useState('2');
  const [res, setRes] = useState<{ status: number; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const found = views.find((v) => v.number === room.trim() || v.id === room.trim());
  const roomErr = room.trim() && !found ? t('Unknown room', '房间不存在') : null;

  const dial = async (c: string) => {
    if (!found) return;
    setBusy(true);
    setCode(c);
    try {
      const hotel = snapshot.hotel.hotelId;
      const r = await ohip({
        method: 'PUT',
        path: `/fof/v1/hotels/${hotel}/interfaces/PBX/roomStatuses`,
        headers: { Authorization: `Bearer ${DEMO_TOKEN}`, 'x-app-key': DEMO_APP_KEY, 'x-hotelid': hotel, 'x-externalsystem': 'PBX', 'Content-Type': 'application/json' },
        body: { roomId: found.number, statusCode: c },
      });
      const b = r.body as Record<string, unknown>;
      setRes({ status: r.status, msg: String(b.message ?? b.detail ?? b.title ?? '') + (b['o:errorCode'] ? ` [${b['o:errorCode']}]` : '') });
    } catch (e) {
      setRes({ status: 0, msg: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad col" style={{ gap: 10 }}>
      <b>{t('PBX status-code simulator', 'PBX 房态码模拟器')}</b>
      <div className="ac-hint">{t('The attendant dials a code from the guest-room phone; the PBX posts it inbound to the PMS.', '服务员在客房电话拨码，PBX 把它作为入站消息回写 PMS。')} <span className="mono">PUT …/interfaces/PBX/roomStatuses</span></div>
      <Field label={t('Room number', '房号')} error={roomErr}>
        <TextInput value={room} onChange={setRoom} placeholder="e.g. 0305" invalid={!!roomErr} />
      </Field>
      {found && <div className="ac-hint">{found.number}: {found.displayStatus} · {found.foStatus}</div>}
      <div className="ac-keypad">
        {PBX_CODES.map((k) => (
          <button key={k.c} className={cx('ac-key', code === k.c && 'on')} disabled={!found || busy} onClick={() => void dial(k.c)} title={`${k.c} = ${k.l}`}>
            <b>{k.c}</b>
            <span>{k.l}</span>
          </button>
        ))}
      </div>
      <div className="row-wrap">
        <TextInput value={code} onChange={setCode} className="mono" placeholder="code" />
        <Button disabled={!found || busy} onClick={() => void dial(code)}>Dial</Button>
        <span className="ac-hint">{t('try 7 → BAD_CODE', '试试 7 → BAD_CODE')}</span>
      </div>
      {res && (
        <div className="row-wrap">
          <span className={cx('ac-st', statusClass(res.status))}>{res.status}</span>
          <span>{res.msg}</span>
        </div>
      )}
      <div className="ac-hint">{t('3 Inspected only applies when the Inspected parameter is on. 5/6 set HK occupancy (may create Skip/Sleep discrepancies).', '3 Inspected 仅在启用 Inspected 参数时有效；5/6 设置 HK 占用（可能产生 Skip/Sleep 差异）。')}</div>
    </div>
  );
}

// ======================================================================= Polling API
function PollPanel() {
  const t = useT();
  const { snapshot, ohip, toast } = useStore();
  const [since, setSince] = useState('0');
  const [lastSeq, setLastSeq] = useState<number | null>(null);
  const [events, setEvents] = useState<BusinessEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const head = snapshot.events[0]?.seq ?? 0;

  const poll = async () => {
    try {
      const n = Math.max(0, parseInt(since, 10) || 0);
      const r = await ohip({ method: 'GET', path: '/api/events', query: { sinceSeq: String(n) } });
      const b = r.body as { events?: BusinessEvent[]; lastSeq?: number; hasMore?: boolean };
      setEvents(b.events ?? []);
      setHasMore(!!b.hasMore);
      if (typeof b.lastSeq === 'number') {
        setLastSeq(b.lastSeq);
        setSince(String(b.lastSeq));
      }
      toast('info', `${b.events?.length ?? 0} ${t('event(s) returned', '条事件返回')}`);
    } catch (e) {
      toast('error', String((e as Error).message));
    }
  };

  return (
    <div className="card card-pad col" style={{ gap: 10 }}>
      <b>Polling API <span className="muted" style={{ fontWeight: 400 }}>— GET /api/events?sinceSeq=N</span></b>
      <div className="ac-hint">{t('Instead of a pushed stream, the consumer remembers lastSeq and asks for everything newer.', '消费方不接收推送，而是记住 lastSeq 并询问更新的全部事件。')}</div>
      <div className="row-wrap">
        <span>sinceSeq</span>
        <TextInput value={since} onChange={setSince} className="mono" type="number" />
        <Button variant="primary" onClick={() => void poll()}>{t(`Poll since seq ${since || 0}`, `从 seq ${since || 0} 起轮询`)}</Button>
        <Button size="sm" variant="link" onClick={() => setSince(String(head))}>{t('set to head', '设为最新')} (#{head})</Button>
      </div>
      <div className="ac-hint mono">curl "$HOST/api/events?sinceSeq={since || 0}"</div>
      <div className="row-wrap">
        <span className="badge info">lastSeq: {lastSeq ?? '—'}</span>
        {hasMore && <span className="badge warn">hasMore</span>}
        <span className="badge neutral">{events.length} events</span>
      </div>
      <div style={{ maxHeight: 180, overflow: 'auto' }}>
        {events.map((e) => (
          <div key={e.id} className="ac-evrow" style={{ cursor: 'default' }}>
            <b className="mono">#{e.seq}</b>
            <span>{e.eventName}</span>
            <span className="muted">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
