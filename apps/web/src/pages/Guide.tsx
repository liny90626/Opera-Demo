/** 演示指南 (doc 03 §4.14): Chinese-first walkthrough of the room-status demo, with jump links to each starting page. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Button, Checkbox, Confirm, PageHeader } from '../components/ui';
import { ALL_DISPLAY_STATUSES, StatusBadge, StatusIcon, useLabels } from '../components/status';
import './Guide.css';

type B = [en: string, zh: string];

const R = {
  home: '/',
  board: '/inventory/housekeeping-board',
  grid: '/inventory/room-grid',
  disc: '/inventory/discrepancies',
  ooo: '/inventory/out-of-order',
  tasks: '/inventory/task-sheets',
  arrivals: '/front-desk/arrivals',
  inhouse: '/front-desk/in-house',
  inhouseDue: '/front-desk/in-house?filter=dueout',
  queue: '/front-desk/queue',
  sync: '/integration/sync-monitor',
  api: '/integration/api-console',
  eod: '/misc/end-of-day',
};

interface Step {
  text: B;
  link?: { to: string; label: B };
  mobile?: boolean;
}
interface Scenario {
  id: string;
  title: B;
  minutes: number;
  goal: B;
  prep?: B;
  steps: Step[];
  expect: B[];
  tip?: B;
}

const SCENARIOS: Scenario[] = [
  {
    id: 's1',
    title: ['S1 Mobile sets Clean, live sync across two windows', 'S1 移动端置 Clean，两个窗口实时联动'],
    minutes: 3,
    goal: [
      'Show that a change made by a room attendant on the phone shows up on the supervisor screen within a second.',
      '演示客房员在移动端的操作如何实时反映到主管的房务看板上。',
    ],
    prep: ['Start from freshly reset data; the Dashboard must be open in this window.', '从刚重置的数据开始；本窗口需打开首页。'],
    steps: [
      { text: ['In this window, open the Housekeeping Board and keep the Sync Monitor open in a second tab.', '在本窗口打开房务看板，并在另一标签页打开同步监控。'], link: { to: R.board, label: ['Housekeeping Board', '房务看板'] } },
      { text: ['Open the attendant mobile view in a NEW window (it stays live with this one).', '点击按钮在新窗口打开客房员移动端（与本窗口实时联动）。'], mobile: true },
      { text: ['On the board, pick a Dirty and Vacant room → I Want To… → Assign Attendant → choose the attendant you selected on the phone.', '在看板上选一间 Dirty 且 Vacant 的房 → I Want To… → Assign Attendant → 选择刚才在手机上选的客房员。'] },
      { text: ['On the phone, the room appears under “My rooms”. Open it and set it to Clean.', '在手机上，该房会出现在「我的房间」里。打开它并设为 Clean。'] },
      { text: ['Switch back to the board and watch the room icon change to Clean (blue).', '切回看板，观察房间图标变为 Clean（蓝色）。'] },
      { text: ['Check the Dashboard room-status tile: Dirty · Vacant goes down one, Clean · Vacant goes up one.', '查看首页房态磁贴：Dirty · Vacant 减一，Clean · Vacant 加一。'], link: { to: R.home, label: ['Dashboard', '首页'] } },
      { text: ['In the Sync Monitor, the newest event is UPDATE ROOM STATUS with source MOBILE; the housekeeping subscriber mirror shows Clean / Vacant.', '在同步监控中，最新事件为 UPDATE ROOM STATUS，来源 MOBILE；房务订阅者镜像显示 Clean / Vacant。'], link: { to: R.sync, label: ['Sync Monitor', '同步监控'] } },
    ],
    expect: [
      ['Both windows show the green connection light.', '两个窗口顶部连接灯均为绿色。'],
      ['The changed room updates in the board window within about a second and flashes yellow.', '看板窗口中该房在约 1 秒内更新，并闪烁黄色提示。'],
      ['Header sync light pulses when the change came from the other window.', '变更来自另一窗口时，顶部同步指示灯闪烁。'],
      ['Sync Monitor event source is MOBILE and no unrelated subscriber receives a new delivery.', '同步监控事件来源为 MOBILE，其他订阅者不产生新投递。'],
    ],
    tip: ['Observe: the Source column in the event stream. Both windows must come from the same browser or the same server.', '观察点：事件流中的 Source 列。两个窗口必须来自同一浏览器（本地模式）或同一服务器。'],
  },
  {
    id: 's2',
    title: ['S2 Arrival to a room that is not ready → queue → ready → check-in', 'S2 到店房未就绪 → 排队 → 房就绪 → 入住'],
    minutes: 4,
    goal: [
      'Show how the front desk handles a guest whose room is still Dirty, and how housekeeping readiness releases the guest.',
      '展示到店住客的房间仍为 Dirty 时，前台如何排队，以及房务完成清洁后如何办理入住。',
    ],
    prep: ['Use reset data; pick an arrival whose assigned room is Dirty (the Arrivals list shows the room status).', '使用重置后的数据；选一位已排房但房间为 Dirty 的预抵住客（预抵列表可见房态）。'],
    steps: [
      { text: ['Open Arrivals and select that guest, then click Check In.', '打开预抵页，选中该住客，点击 Check In。'], link: { to: R.arrivals, label: ['Arrivals', '预抵 / 入住'] } },
      { text: ['A dialog says the room is not ready (ROOM_NOT_READY). Choose Add to Queue.', '弹出房间未就绪提示（ROOM_NOT_READY）。选择 Add to Queue。'] },
      { text: ['Open Queue Rooms: the row shows Readiness Not Ready (Dirty). Note the queue count on the Dashboard.', '打开排队房页：该行显示 Not Ready（Dirty）。记下首页排队数量。'], link: { to: R.queue, label: ['Queue Rooms', '排队房'] } },
      { text: ['Make that room Clean on the Housekeeping Board (or the attendant mobile view).', '在房务看板（或客房员移动端）把该房设为 Clean。'], link: { to: R.board, label: ['Housekeeping Board', '房务看板'] } },
      { text: ['Back on Queue Rooms, the row turns Ready and offers Check In; the warning asks you to notify the guest.', '回到排队房页：该行变为 Ready，并出现 Check In 按钮；提示需通知住客。'] },
      { text: ['Click Check In. The guest moves in-house, the room becomes Occupied, and the queue count drops by one.', '点击 Check In。住客转为在住，房间变为 Occupied，排队数减一。'] },
    ],
    expect: [
      ['Check-in is blocked with a Queue choice, not a silent failure.', '入住被阻止并提供排队选项，而不是静默失败。'],
      ['The queue row changes Not Ready → Ready after the room is cleaned.', '房间清洁后，排队行由 Not Ready 变为 Ready。'],
      ['After check-in the room shows Occupied and the reservation shows in-house.', '入住后房间显示 Occupied，预订显示在住。'],
      ['Sync Monitor shows lock and PBX deliveries for the new key and line.', '同步监控显示门锁与 PBX 为新房卡与外线的投递。'],
    ],
    tip: ['If check-in still fails after cleaning, the parameter “Allow check-in to Clean rooms” is off: the room must be Inspected first.', '若清洁后仍无法入住，说明「允许入住 Clean 房」参数已关闭，需先 Inspected。'],
  },
  {
    id: 's3',
    title: ['S3 Check-out makes the room Dirty; early departure', 'S3 退房后房间变为 Dirty；提前离店'],
    minutes: 3,
    goal: [
      'Show that check-out is a business event and that the room automatically becomes Dirty and Vacant.',
      '演示退房是一个业务事件，房间自动变为 Dirty 与 Vacant。',
    ],
    steps: [
      { text: ['In House: find a Stay Over guest in a Clean room and click Check Out.', '在住页：找到一间 Clean 房的续住住客，点击 Check Out。'], link: { to: R.inhouse, label: ['In House', '在住 / 退房'] } },
      { text: ['A warning appears when the departure date moves earlier (early departure).', '若离店日提前，会出现提前离店提示（warning）。'] },
      { text: ['The room now shows Vacant and Dirty. The event order is CHECK OUT, then UPDATE ROOM STATUS (Clean → Dirty).', '房间变为 Vacant 与 Dirty。事件顺序为 CHECK OUT，然后 UPDATE ROOM STATUS（Clean → Dirty）。'], link: { to: R.sync, label: ['Sync Monitor', '同步监控'] } },
      { text: ['Repeat with a Due Out guest whose room is already Dirty: only CHECK OUT is emitted, because nothing changed.', '对一位房间已是 Dirty 的预离住客重复操作：只产生 CHECK OUT，因为房态没有变化。'] },
      { text: ['In the Sync Monitor, check the mirrors: PBX line barred, lock has no active key, BMS in eco, housekeeping Dirty / Vacant.', '在同步监控中核对镜像：PBX 外线停用，门锁无有效房卡，BMS 为节能模式，房务为 Dirty / Vacant。'] },
    ],
    expect: [
      ['The room is Vacant + Dirty and the reservation is Departed.', '房间为 Vacant + Dirty，预订为已离（Departed）。'],
      ['The event stream shows CHECK OUT followed by UPDATE ROOM STATUS only for the Clean room.', '事件流中，仅 Clean 房的退房会在 CHECK OUT 后出现 UPDATE ROOM STATUS。'],
      ['Subscriber mirrors update for PBX, lock, BMS and housekeeping.', 'PBX、门锁、BMS 与房务的订阅者镜像随之更新。'],
    ],
  },
  {
    id: 's4',
    title: ['S4 Out of Order vs Out of Service, and inventory', 'S4 维修（OOO）与停用（OOS）及库存影响'],
    minutes: 4,
    goal: [
      'Show that OOO removes a room from sellable inventory while OOS keeps it in inventory but blocks check-in.',
      '说明 OOO 会从可售库存中扣除；OOS 仍计入库存但不可入住。',
    ],
    steps: [
      { text: ['Note the Inventory figure on the Dashboard and the Room Summary.', '记下首页与房间汇总中的库存数。'], link: { to: R.home, label: ['Dashboard', '首页'] } },
      { text: ['Out of Order page → New: pick a Clean, Vacant room, dates today to tomorrow, reason PLB, return status Dirty.', '维修/停用页 → New：选一间 Clean 且 Vacant 的房，日期为今天至明天，原因 PLB，返回状态 Dirty。'], link: { to: R.ooo, label: ['Out of Order / Service', '维修 / 停用房'] } },
      { text: ['The inventory count drops by one and the Channel subscriber receives a sellable-count change; the BMS shows the room as Off.', '库存减一，Channel 订阅者收到可售数变化；BMS 显示该房为 Off。'], link: { to: R.sync, label: ['Sync Monitor', '同步监控'] } },
      { text: ['Try to assign a future guest to that room: the room is refused as out of order.', '尝试把该房排给住客：会因维修被拒绝。'] },
      { text: ['Return to Service on the same room: it comes back as Dirty and the inventory recovers.', '对该房执行 Return to Service：房间以 Dirty 返回，库存恢复。'] },
      { text: ['Now place a different room Out of Service (OOS): inventory does not change and Channel receives nothing.', '对另一间房设置 OOS：库存不变，Channel 不会收到投递。'] },
      { text: ['Try to check in a guest to the OOS room: it is refused with Room not ready (OOS blocks check-in).', '尝试将住客入住到 OOS 房：会被拒绝（房间未就绪，OOS 不可入住）。'] },
    ],
    expect: [
      ['OOO reduces sellable inventory by one; OOS does not.', 'OOO 使可售库存减一；OOS 不改变库存。'],
      ['Returning an OOO room sets it to its return status (Dirty) and restores inventory.', 'OOO 房返回后变为返回状态（Dirty）并恢复库存。'],
      ['Overlapping assignment or a room already OOO shows a clear conflict message.', '与已有排房或已 OOO 的房冲突时，会显示明确的冲突提示。'],
    ],
    tip: ['Observe: the Dashboard tile excludes OOO rooms. OOS rooms count in inventory but show the OOS colour.', '观察点：首页磁贴不计入 OOO 房；OOS 房计入库存，但以 OOS 颜色显示。'],
  },
  {
    id: 's5',
    title: ['S5 Room discrepancies: detect and resolve', 'S5 房态差异：发现与解除'],
    minutes: 3,
    goal: [
      'Show the three discrepancy types (Skip, Sleep, Person) and how they clear.',
      '演示三类差异（Skip 走单、Sleep 睡房、Person 人数差异）的发现与解除。',
    ],
    prep: ['On reset data, the Discrepancies page lists three records. Use any of them; no room number is needed.', '在重置后的数据中，房态差异页有三条记录，任选即可，无需记住房号。'],
    steps: [
      { text: ['Open Room Discrepancies. Note the type of each record.', '打开房态差异页，记下每条记录的类型。'], link: { to: R.disc, label: ['Room Discrepancies', '房态差异'] } },
      { text: ['For a Skip record, go to In House and Check Out that room. The Skip record disappears.', '对 Skip 记录，到在住页对该房办理退房，Skip 记录消失。'], link: { to: R.inhouse, label: ['In House', '在住 / 退房'] } },
      { text: ['For a Sleep record, use Resolve. The housekeeping occupancy is set to Vacant (resolved).', '对 Sleep 记录点击 Resolve，房务占用被设为 Vacant（已解决）。'] },
      { text: ['Create one yourself: in the attendant mobile view, report an empty room as Occupied with 2 persons → a Sleep warning appears and the record shows up immediately.', '自己制造一条：在客房员移动端把空房报为 Occupied 2 人 → 出现 Sleep 警告，差异立即出现。'], link: { to: R.disc, label: ['Discrepancies', '房态差异'] } },
      { text: ['Report the same room as Vacant again: the record disappears.', '再把该房报为 Vacant：记录消失。'] },
    ],
    expect: [
      ['Each discrepancy shows its type badge and the FO and HK view side by side.', '每条差异显示类型标签，并并排显示前台与房务的视图。'],
      ['Check-out clears a Skip; Resolve clears a Sleep or Person record.', '退房可清除 Skip；Resolve 可清除 Sleep 或 Person 记录。'],
      ['A new discrepancy appears live without reloading the page.', '新差异无需刷新页面即可实时出现。'],
    ],
  },
  {
    id: 's6',
    title: ['S6 Sync failure, drift, then retry or full resync', 'S6 同步失败 → 漂移 → 重试或全量重同步'],
    minutes: 5,
    goal: [
      'Show that a failing downstream system causes drift, and that Retry and Full resync repair it.',
      '演示下游系统失败会产生漂移，并通过重试或全量重同步修复。',
    ],
    steps: [
      { text: ['In Sync Monitor, set the Door Lock subscriber failure rate to 100%.', '在同步监控中，把门锁订阅者的失败率设为 100%。'], link: { to: R.sync, label: ['Sync Monitor', '同步监控'] } },
      { text: ['In Arrivals, check in a guest whose room is Inspected.', '在预抵页，为一位已排 Inspected 房的住客办理入住。'], link: { to: R.arrivals, label: ['Arrivals', '预抵 / 入住'] } },
      { text: ['The delivery list shows the Door Lock as FAILED (red); the other subscribers succeed. The Drift list gets a line for the lock.', '投递列表中门锁显示 FAILED（红色），其他订阅者成功；漂移列表新增门锁一行。'] },
      { text: ['Set the failure rate back to 0 and click Retry all failed. The delivery becomes DELIVERED after a second attempt and drift clears.', '把失败率设回 0，点击 Retry all failed。投递在第二次尝试后变为 DELIVERED，漂移清空。'] },
      { text: ['Disable the BMS subscriber, then check in a guest to a Clean room. No BMS delivery is created, and drift shows the BMS mismatch.', '禁用 BMS 订阅者，再为一间 Clean 房办理入住。不会产生 BMS 投递，漂移中出现 BMS 不一致。'] },
      { text: ['Retry cannot fix a disabled subscriber, so click Full resync for it. Drift is cleared.', '重试无法修复已禁用的订阅者，因此点击 Full resync，漂移清空。'] },
    ],
    expect: [
      ['The failed count is the number of failed attempts; it does not go down after a successful retry.', 'failed 计数为失败尝试次数；重试成功后不会减少。'],
      ['Retry repairs only FAILED deliveries; Full resync rebuilds the whole mirror of one subscriber.', 'Retry 仅修复 FAILED 投递；Full resync 会重建某个订阅者的整份镜像。'],
    ],
    tip: ['This is what production integrations face: the PMS stays correct, the downstream system needs a repair path.', '这正是生产集成会遇到的情况：PMS 本身正确，下游系统需要修复路径。'],
  },
  {
    id: 's10',
    title: ['S10 OHIP inbound: API Console and PBX simulator', 'S10 OHIP 入站：API 控制台与 PBX 模拟器'],
    minutes: 5,
    goal: [
      'Show that external systems change room status through the same engine, with the same rules and events.',
      '展示外部系统通过同一引擎、同一规则与事件修改房态。',
    ],
    steps: [
      { text: ['Open the API Console. Get a token from the OAuth endpoint, then call any endpoint without the app key: expect 401.', '打开 API 控制台。通过 OAuth 端点获取 token，再在不带应用密钥的情况下调用任意端点：应返回 401。'], link: { to: R.api, label: ['API Console', 'API 控制台'] } },
      { text: ['Call the room status endpoint to set a Dirty room to Clean: expect 200 and the resulting events below the response (source OHIP_API).', '调用房态接口把一间 Dirty 房设为 Clean：应返回 200，并在响应下方看到结果事件（source OHIP_API）。'] },
      { text: ['Send an OutOfOrder housekeeping status through the same endpoint: expect 400, because OOO must use its own endpoint.', '通过同一接口发送 OutOfOrder 房态：应返回 400，因为 OOO 必须使用专用接口。'] },
      { text: ['Open the Dashboard in another window and watch the change arrive live.', '在另一窗口打开首页，观察变化实时到达。'], link: { to: R.home, label: ['Dashboard', '首页'] } },
      { text: ['Call the events endpoint with sinceSeq set to the last seen value: only newer events come back.', '调用事件接口，sinceSeq 设为上次的 lastSeq：只返回更新的事件。'] },
      { text: ['In the PBX simulator, dial 1 for a room (sets Clean, source PBX), 7 (400 BAD_CODE), and 5 (reports Occupied, which can raise a discrepancy).', '在 PBX 模拟器中，为某房拨 1（设为 Clean，source PBX）、拨 7（400 BAD_CODE）、拨 5（报告 Occupied，可能产生差异）。'] },
      { text: ['Turn Inspected off in End of Day, then dial 3: expect 400 PARAM. Turn it back on afterwards.', '在日结页关闭 Inspected 后拨 3：应返回 400 PARAM。之后记得重新开启。'], link: { to: R.eod, label: ['End of Day & Settings', '夜审与参数'] } },
    ],
    expect: [
      ['Requests without the app key are rejected with 401.', '缺少应用密钥的请求被拒绝（401）。'],
      ['A successful call produces the same event that the UI would produce, with source OHIP_API.', '成功的调用产生与界面操作相同的事件，来源为 OHIP_API。'],
      ['Invalid codes and parameter conflicts return clear error bodies, not partial changes.', '无效代码与参数冲突返回清晰的错误信息，不会产生部分修改。'],
    ],
  },
  {
    id: 's11',
    title: ['S11 Night audit (End of Day)', 'S11 夜审（日结）'],
    minutes: 5,
    goal: [
      'Show how the business date advances, what changes in room status, and how a blocked run is resolved.',
      '展示业务日期推进时房态的变化，以及日结被阻止时如何处理。',
    ],
    steps: [
      { text: ['On End of Day, pre-checks show due-out guests still in house. Click Run End of Day and confirm.', '在日结页，预检显示仍在住的预离住客。点击执行日结并确认。'], link: { to: R.eod, label: ['End of Day', '日结'] } },
      { text: ['A dialog lists the due-outs (DUE_OUTS_PENDING). Use Go to In House (Due Out).', '弹出列出预离住客的对话框（DUE_OUTS_PENDING）。点击「前往在住页（预离）」。'], link: { to: R.inhouseDue, label: ['In House (Due Out)', '在住页（预离）'] } },
      { text: ['Check out all due-outs (batch selection is fine).', '为全部预离住客办理退房（可批量选择）。'] },
      { text: ['Back on End of Day, the pre-check due-out count is now zero. Run again.', '回到日结页，预离计数归零，再次执行。'], link: { to: R.eod, label: ['End of Day', '日结'] } },
      { text: ['Confirm the business date rolled forward, occupied rooms are Dirty, MUR is cleared, DND stays for occupied rooms, and un-arrived guests are No Show.', '确认业务日期已推进，占用房为 Dirty，MUR 被清除，占用房的 DND 保留，未到店住客转为 No Show。'] },
      { text: ['Open the Sync Monitor and find the single BUSINESS DATE CHANGE event; every subscriber refreshes its mirror.', '打开同步监控，找到唯一的 BUSINESS DATE CHANGE 事件；每个订阅者整体刷新镜像。'], link: { to: R.sync, label: ['Sync Monitor', '同步监控'] } },
      { text: ['Optional: set the housekeeping subscriber failure rate to 100% and run again. The mirror becomes stale; repair it with Retry or Full resync.', '可选：把房务订阅者失败率设为 100% 后再次执行。镜像会过期；用 Retry 或 Full resync 修复。'] },
    ],
    expect: [
      ['The header business date changes by one day.', '页眉的业务日期推进一天。'],
      ['Out-of-order records that expire at the audit return to inventory with their return status.', '本次到期的维修记录回到库存，并使用其返回状态。'],
      ['Every connected window receives the reset and shows the new date.', '所有连接的窗口都收到重置并显示新日期。'],
    ],
    tip: ['Reset demo data restores the seed data and today’s business date at any time.', '「重置演示数据」可随时恢复种子数据与今天的业务日期。'],
  },
];

const STATUS_NOTES: Record<string, B> = {
  Inspected: ['Clean and checked by a supervisor. Can be checked into.', '已清洁并经主管检查，可入住（参数可调整）。'],
  Clean: ['Cleaned by an attendant. Ready to check into when Clean rooms are allowed.', '客房员已清洁，按参数可入住。'],
  Pickup: ['Only pickup needed (linen or minibar). Optional status.', '仅需收取布草或迷你吧。可选状态。'],
  Dirty: ['Needs cleaning. Not ready for check-in.', '需要清洁，不可入住。'],
  OutOfOrder: ['Under repair. Removed from sellable inventory.', '维修中。从可售库存中扣除。'],
  OutOfService: ['Taken out of service. Still in inventory, not ready for check-in.', '停用。仍计入库存，不可入住。'],
};

const CONCEPTS: { term: B; body: B }[] = [
  { term: ['Vacant / Occupied (FO)', '空房 / 住客占用（前台）'], body: ['Front-office occupancy from in-house reservations.', '根据在住预订得出的前台占用状态。'] },
  { term: ['HK occupancy', '房务观察（占用）'], body: ['What the attendant saw. A mismatch with the FO state raises a discrepancy.', '客房员观察到的占用情况；与前台不一致即产生差异。'] },
  { term: ['Skip', 'Skip 走单'], body: ['Front office shows a guest, but the room is empty (guest left without check-out).', '前台显示有住客，但房间已空（住客未办理退房即离开）。'] },
  { term: ['Sleep', 'Sleep 睡房'], body: ['Attendant sees someone sleeping in a room that FO shows as Vacant.', '客房员看到有人住，前台显示空房。'] },
  { term: ['Person', 'Person 人数差异'], body: ['Guest count differs between front office and housekeeping.', '前台与房务的人数不一致。'] },
  { term: ['DND / MUR', 'DND 请勿打扰 / MUR 请即打扫'], body: ['Service requests. DND means skip or come back later; MUR means clean now. MUR is cleared at night audit.', '服务请求。DND 表示跳过或稍后再来；MUR 表示请即打扫。MUR 在夜审时清除。'] },
  { term: ['Queue (排队房)', '排队房'], body: ['A guest waiting for a room that is not ready. Released when housekeeping makes the room ready.', '等待房间就绪的住客；房务完成清洁后自动释放。'] },
  { term: ['Business Date', '业务日期'], body: ['The hotel’s working day. Advanced only by End of Day (night audit).', '酒店的营业日。只能通过日结（夜审）推进。'] },
  { term: ['Business Event', '业务事件'], body: ['An OHIP-style record of every change (e.g. UPDATE ROOM STATUS). External systems receive these.', 'OHIP 风格的变更记录（如 UPDATE ROOM STATUS），外部系统据此同步。'] },
  { term: ['Drift (漂移)', '漂移'], body: ['A subscriber mirror that no longer matches the PMS. Repaired by Retry or Full resync.', '订阅者镜像与 PMS 不一致。用 Retry 或全量重同步修复。'] },
];

export default function Guide() {
  const { snapshot, exec } = useStore();
  const l = useLabels();
  const t = useT();
  const tb = (b: B) => t(b[0], b[1]);
  const [resetOpen, setResetOpen] = useState(false);

  // per-viewer acceptance checkboxes (localStorage is only a convenience here)
  const [checks, setChecks] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('opera-demo:guide-checks') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const setCheck = (k: string, v: boolean) => {
    setChecks((c) => {
      const n = { ...c, [k]: v };
      try {
        localStorage.setItem('opera-demo:guide-checks', JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  };

  const openMobile = () => {
    const base = window.location.href.split('#')[0];
    window.open(`${base}#/mobile`, 'mobile', 'width=430,height=860');
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const toc: { id: string; label: string }[] = [
    { id: 'g-intro', label: t('0 · About the demo', '0 · 演示是什么') },
    { id: 'g-arch', label: t('Architecture', '架构图') },
    { id: 'g-glossary', label: t('Status glossary', '状态与术语') },
    ...SCENARIOS.map((s) => ({ id: s.id, label: tb(s.title) })),
  ];

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Help', '帮助') }, { label: t('Demo Guide', '演示指南') }]}
        title={t('演示指南 · Demo Guide', '演示指南 · Demo Guide')}
        sub={t('Chinese walkthrough with English labels. Each scenario has jump buttons to its starting page.', '中文演示脚本，界面术语保留英文。每个场景提供跳转按钮到起始页面。')}
        actions={
          <Button onClick={() => setResetOpen(true)} variant="danger">
            {t('Reset demo data', '重置演示数据')}
          </Button>
        }
      />

      <div className="guide-grid">
        <nav className="guide-toc card" aria-label={t('Contents', '目录')}>
          <h4>{t('Contents', '目录')}</h4>
          {toc.map((x) => (
            <button key={x.id} onClick={() => jump(x.id)}>
              {x.label}
            </button>
          ))}
        </nav>

        <div className="guide-body">
          {/* ---------------- intro */}
          <section id="g-intro" className="guide-sec card guide-card">
            <h2>{t('0 · What this demo is', '0 · 演示是什么')}</h2>
            <p style={{ margin: '0 0 8px' }}>
              {t(
                'This is a room-status demo of an OPERA Cloud-style property management system (PMS). It shows how housekeeping, front office, mobile attendants, external systems (OHIP API, PBX, door locks, BMS, channel) and night audit share one room state.',
                '这是一个仿 OPERA Cloud 的房态演示。它展示客房清洁、前台、移动端客房员、外部系统（OHIP API、PBX、门锁、BMS、渠道）与夜审如何共享同一套房态。',
              )}
            </p>
            <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
              <li>
                {t(
                  'Scope: room status, housekeeping, out-of-order inventory, queues, discrepancies, business events and night audit.',
                  '范围：房态、房务、维修库存、排队、差异、业务事件与夜审。',
                )}
              </li>
              <li>
                {t(
                  'Out of scope: the reference video topic “Create a Walk-In Reservation” (reservations and billing are not modelled here).',
                  '不在范围内：参考视频主题「创建散客预订」（预订与账务未在本演示中建模）。',
                )}
              </li>
              <li>
                {t(
                  'Room numbers in this guide are not fixed. Pick a room by its role, e.g. “a Dirty vacant room”.',
                  '本指南不依赖固定房号：请按角色选房，例如「一间 Dirty 的空房」。',
                )}
              </li>
            </ul>
            <div className="muted" style={{ fontSize: 12 }}>
              {t('Current business date', '当前业务日期')}: {snapshot.hotel.businessDate} · {t('Version', '版本')} {snapshot.version}
            </div>
          </section>

          {/* ---------------- architecture */}
          <section id="g-arch" className="guide-sec card guide-card">
            <h2>{t('Architecture', '架构图')}</h2>
            <div className="arch">
              <div className="arch-col">
                <div className="arch-h">{t('Inbound', '入站')}</div>
                <div className="arch-box">
                  {t('Front desk & HK board UI', '前台与房务看板')}
                  <small>{t('Officer actions', '人员操作')}</small>
                </div>
                <div className="arch-box">
                  {t('Mobile attendant', '客房员移动端')}
                  <small>source MOBILE</small>
                </div>
                <div className="arch-box">
                  {t('OHIP REST façade', 'OHIP REST 接口')}
                  <small>source OHIP_API</small>
                </div>
                <div className="arch-box">
                  PBX
                  <small>source PBX</small>
                </div>
              </div>
              <div className="arch-arrow">→</div>
              <div className="arch-col core">
                <div className="arch-h">{t('PMS engine', 'PMS 引擎')}</div>
                <div className="arch-box">
                  {t('Rooms, HK status, reservations', '房间、房态、预订')}
                  <small>{t('single source of truth', '唯一数据源')}</small>
                </div>
                <div className="arch-box">
                  {t('Rules & commands', '规则与命令')}
                  <small>{t('same rules for every channel', '所有入口规则一致')}</small>
                </div>
                <div className="arch-box">
                  {t('Business date, parameters, night audit', '业务日期、参数、夜审')}
                </div>
              </div>
              <div className="arch-arrow">→</div>
              <div className="arch-col">
                <div className="arch-h">{t('Business Events', '业务事件')}</div>
                <div className="arch-box">
                  UPDATE ROOM STATUS
                  <small>{t('one record per change', '每次变更一条')}</small>
                </div>
                <div className="arch-box">
                  CHECK OUT · NEW OUT OF ORDER
                  <small>{t('business-level names', '业务级事件名')}</small>
                </div>
                <div className="arch-box">
                  BUSINESS DATE CHANGE
                  <small>{t('night audit', '夜审')}</small>
                </div>
              </div>
              <div className="arch-arrow">→</div>
              <div className="arch-col">
                <div className="arch-h">{t('Subscribers', '订阅者')}</div>
                {(snapshot.subscribers.length ? snapshot.subscribers.map((s) => s.name) : ['Housekeeping', 'PBX', 'Door Lock', 'BMS', 'Channel']).map((n) => (
                  <div key={n} className="arch-box">{n}</div>
                ))}
              </div>
            </div>
            <div className="arch-note">
              {t(
                'Each subscriber keeps its own mirror of the room state. When a mirror drifts (for example after a failed delivery), the Sync Monitor shows it and Retry or Full resync repairs it.',
                '每个订阅者保存一份房态镜像。镜像漂移（例如投递失败）时，同步监控会显示，并可通过 Retry 或全量重同步修复。',
              )}
            </div>
          </section>

          {/* ---------------- glossary */}
          <section id="g-glossary" className="guide-sec card guide-card">
            <h2>{t('Status glossary', '状态与术语')}</h2>
            <table className="dt" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 60 }} />
                  <th>{t('Status', '状态')}</th>
                  <th>{t('Meaning', '含义')}</th>
                </tr>
              </thead>
              <tbody>
                {ALL_DISPLAY_STATUSES.map((s) => (
                  <tr key={s}>
                    <td>
                      <StatusIcon status={s} size={34} />
                    </td>
                    <td>
                      <StatusBadge status={s} />
                    </td>
                    <td>{tb(STATUS_NOTES[s])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ height: 14 }} />
            <table className="dt" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>{t('Term', '术语')}</th>
                  <th>{t('Meaning', '含义')}</th>
                </tr>
              </thead>
              <tbody>
                {CONCEPTS.map((c) => (
                  <tr key={c.term[0]}>
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{tb(c.term)}</td>
                    <td>{tb(c.body)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {t('Badges used in the demo:', '演示中使用的标签：')} <span className="badge fo-Vacant">{l.fo('Vacant')}</span> <span className="badge fo-Occupied">{l.fo('Occupied')}</span>{' '}
              <span className="badge svc-DND">DND</span> <span className="badge svc-MUR">MUR</span>
            </div>
          </section>

          {/* ---------------- scenarios */}
          {SCENARIOS.map((s) => (
            <section key={s.id} id={s.id} className="guide-sec card guide-card">
              <div className="guide-scn-head">
                <h3>{tb(s.title)}</h3>
                <span className="muted" style={{ fontSize: 12 }}>
                  ≈ {s.minutes} {t('min', '分钟')}
                </span>
              </div>
              <div style={{ marginBottom: 10 }}>
                <strong>{t('Goal', '目标')}：</strong>
                {tb(s.goal)}
              </div>
              <div className="guide-prep">
                <span>{s.prep ? tb(s.prep) : t('Start from reset data (recommended).', '建议从重置后的数据开始。')}</span>
                <Button size="sm" onClick={() => setResetOpen(true)}>
                  {t('Reset demo', 'Reset demo')}
                </Button>
                {s.id === 's1' && (
                  <Button size="sm" variant="primary" onClick={openMobile}>
                    {t('Prepare: open Mobile window', '一键准备：新开 Mobile 窗口')}
                  </Button>
                )}
              </div>
              <ol className="guide-steps">
                {s.steps.map((st, i) => (
                  <li key={i}>
                    <div className="s-body">
                      <span>{tb(st.text)}</span>
                      {st.link && (
                        <Link className="btn btn-sm" to={st.link.to}>
                          {t('Open', '打开')}: {tb(st.link.label)}
                        </Link>
                      )}
                      {st.mobile && (
                        <Button size="sm" onClick={openMobile}>
                          {t('Open Mobile window', '打开移动端窗口')}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              <div className="guide-expect">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('Expected results · acceptance', '预期结果 · 验收勾选')}</div>
                {s.expect.map((e, i) => {
                  const k = `${s.id}:${i}`;
                  return (
                    <Checkbox key={k} checked={!!checks[k]} onChange={(v) => setCheck(k, v)} label={tb(e)} />
                  );
                })}
              </div>
              {s.tip && <div className="guide-tip"><strong>{t('Tip', '提示')}：</strong>{tb(s.tip)}</div>}
            </section>
          ))}
        </div>
      </div>

      <Confirm
        open={resetOpen}
        danger
        title={t('Reset demo data?', '重置演示数据？')}
        message={t('Rooms, reservations, events and deliveries return to the seed state, and the business date returns to today. Every open window resets too.', '房间、预订、事件与投递记录将恢复为种子数据，业务日期回到今天。所有打开的窗口同步重置。')}
        confirmLabel={t('Reset', '重置')}
        cancelLabel={t('Cancel', '取消')}
        onCancel={() => setResetOpen(false)}
        onConfirm={async () => {
          setResetOpen(false);
          await exec({ type: 'resetDemo' });
        }}
      />
    </div>
  );
}
