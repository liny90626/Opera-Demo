# 07 · OPERA Demo × Akubela GRMS 云平台对接设计（含 WBS）

> 版本 v1.0 · 2026-10-13 · 对接对象：Akubela GRMS OpenAPI V4.1（Hotel Function API），UAT 项目「TMG-环境」。
> 输入：`docs/06-akubela-grms-api-digest.md`（API 摘要与实测）、GRMS 控制台视觉核查（§2.3）、本仓库既有 PMS 引擎（docs/02）。

---

## 1. 目标与范围

**目标**：让 OPERA Demo（PMS）与 Akubela GRMS（客房控制云平台）双向打通——前台在 OPERA 里入住/退房/换房、客房改房态，GRMS 侧的订单、房态、门锁授权、客房设备与场景随之联动；GRMS 侧发生的变化（客人自助退房、客房设备上报的清洁/勿扰、告警）回流到 OPERA。

| 方向 | 内容 | 状态 |
|---|---|---|
| PMS → GRMS | 入住（创建/激活订单 + 住客）、退房、提前离店、换房、预排房（预登记订单）、No-Show 取消、HK 房态脏/净、门锁 PIN 授权（可选）、入住欢迎场景/退房节能场景（可选）、设备控制（运营手工） | 本期实现 |
| GRMS → PMS | 房态 dirty→clean（客房员在 HyPanel/GRMS 清洁完成）、DND 勿扰、订单在 GRMS 侧退房（客人自助退房）、告警（SOS/烟感/低电量）、房间/房型主数据 | 本期实现（轮询） |
| 不支持 | OOO/OOS → GRMS「维护中」（OpenAPI 无写接口）、MUR、开夜床、Inspected/Pickup 细分（GRMS 只有 dirty 布尔） | 文档说明，UI 标注 |

**非目标**：账务；GRMS 后台内部接口（`/api/hotel-portal/...`，仅控制台使用，不作为集成通道）；会员/停车/设施预订（Booking）只读展示，不做业务联动。

---

## 2. 对接对象分析

### 2.1 API 形态（证据：开发者文档 + UAT 实测）
- 鉴权：`POST /api/v1.0/invoke/open-ability/method/oauth2/token`，`application/x-www-form-urlencoded`，`grant_type=client_credentials`、`scope=hotel`；返回 JWT，`expires_in=7200`；支持 `grant_type=refresh_token`。
- 业务：**单一命令端点** `POST /api/v1.0/invoke/open-ability/method/hotel-commands`，Body `{command, id, param}`，`Authorization: Bearer`。`id` 为调用方生成的命令 ID（用作幂等/追踪）。
- 返回：`{success, timestamp, result}`；失败 `result = {code, message, detail:{trace_id}}`。
- UAT Base URL：`https://api.cbcloud.uat.akubela.com`（`grms.cbcloud.uat.akubela.com` 同样可用）。
- 实测约束：「Required」字段**不可为空字符串**（否则 `50104080 bind body`）；`create_order_info.start_time` **不得早于当前时间**（`50105580`）；时间格式 `YYYY-MM-DD HH:mm:ss`，UTC。

### 2.2 领域模型对照

| OPERA Demo | GRMS | 说明 |
|---|---|---|
| Room（`0201`/`201`） | residence（`residence_id`/`residence_name`），隶属 building/floor | 以房号自动匹配，支持手工映射（UAT 仅 1 间房 `101`） |
| RoomType（SK/ST/…） | room type（`room_type_id`，如「单人房」） | 只读对照，展示用 |
| Reservation（Reserved/InHouse/CheckedOut/NoShow） | order（`order_id`/`order_number`，`order_state` = `check_in` 待入住 / `checked_in` 已入住 / `checked_out` 已退房） | 一个 OPERA 预订 ↔ 一个 GRMS 订单（换房时链式多个） |
| 预订主客 | order.guest / guest（`guest_id`） | GRMS 要求 name/email/phone/id_card/passport 非空 → 缺省值策略见 §4.4 |
| HK 房态 Clean/Inspected/Pickup/Dirty | `dirty: boolean` | Dirty/Pickup→true；Clean/Inspected→false |
| FO 状态 Occupied/Vacant | `occupied: boolean`（由订单派生） | 只读，用于一致性校验 |
| serviceStatus DND | `dnd: boolean` | GRMS→PMS 单向 |
| OOO/OOS | `maintenance_status`（仅控制台） | 不支持（无 OpenAPI） |
| 门锁 / 房卡 | authorization record（`access_type` PIN/卡）、lock temp key | 入住下发 PIN、退房撤销（可选功能） |
| 客房设备（灯、空调、继电器、传感器） | device / ability（`control_device`） | Room 详情展示 + 手工控制；入住/退房自动化（可选） |
| 场景 | scene（`manual_trigger_scene`） | 入住欢迎 / 退房节能（可选，配置 scene_id） |
| 告警 | alarm record | GRMS→PMS 只读提醒 |

### 2.3 GRMS 控制台视觉核查（UAT TMG-环境）
- 概览：待入住 / 已退房 / 请清洁卡片；房间状态数据（空房、入住、入住人数、入住率）；设备数据（总数 7、在线 3）。
- 房间 › 房间状态：房卡片「101 · 单人房 · b1/1楼层 · 空房脏」；右侧统计：空房清洁/住客房脏/空房脏/住客房清洁/待清洁/勿扰/维护中，订单「预计今天到达/预计今日离开」。
- 订单 › 订单列表：Tab「全部 / 入住 / 已入住 / 已退房 / 延时退房」，字段 登记号码、房间号、房间类型、住客信息。
- 结论：GRMS 房态 = `occupied × dirty` 组合 + 勿扰 + 维护；订单三态与 OpenAPI `order_state` 一致。对接验收时以控制台这两页为视觉核对对象。

### 2.4 UAT 环境阻塞问题（需 Akubela 侧处理）

| 命令 | 现象 | 错误码 | 影响 |
|---|---|---|---|
| `get_room_info`（真实 residence_id） | `api room bind body`（不存在的 ID 则正常返回"不存在"，说明请求格式正确） | 20950001 | 无法读取 dirty/occupied/dnd |
| `update_room_state` | 同上 | 20950001 | 无法写脏/净 |
| `create_order_info` | 通过网关校验后，订单服务 `api order bind body` | 20950005 | **无法创建入住订单** |
| `get_project_info` | `api get project timezone bind header` | 24400347 | 无法读取项目时区 |
| `get_staff_list` / `get_alarm_config` / `get_alarm_record_list` / `get_public_access_group_list` | `bind body/header` | 2095000x | 次要 |

推断：开放网关转发到房间/订单等服务时缺少项目时区等 Header（`get_project_info` 的报错直指 timezone header），属平台侧配置/缺陷。trace_id 记录于 `docs/06` 附录。**设计应对**：①连接器按文档完整实现；②提供与文档契约一致的 **GRMS 模拟器**（明确标注），保证演示与自动化测试可跑通；③提供 `npm run akubela:verify` 实网验收脚本，平台修复后一键回归。

---

## 3. 总体架构

```
┌──────────── OPERA Demo（既有）────────────┐            ┌────── Akubela GRMS ──────┐
│ PmsEngine ──BusinessEvent──┐               │            │ OpenAPI hotel-commands    │
│     ▲                      ▼               │  HTTPS      │  rooms / orders / guests │
│     │            ┌──────────────────────┐  │  ─────────► │  devices / scenes / auth │
│ exec(cmd,        │ AkubelaConnector      │  │  ◄───────── │  (轮询读取)               │
│ source=AKUBELA)  │  · Outbound Planner   │──┤             └──────────────────────────┘
│     ▲            │  · Job Queue(重试/幂等)│  │   GrmsTransport 接口
│     └────────────│  · Inbound Poller     │  │    ├─ RealTransport（server，持有密钥）
│                  │  · Mapping Store      │  │    └─ SimTransport（GRMS 模拟器，core）
│                  └──────────────────────┘  │
└────────────────────────────────────────────┘
```

| 模块 | 位置 | 职责 |
|---|---|---|
| `akubela/contract.ts` | packages/core | 类型契约：命令/实体/配置/作业/状态（Lead 编写，各 WBS 共用） |
| `akubela/simulator.ts` | packages/core | 内存版 GRMS：实现所用命令、与文档一致的校验与错误码；可注入 UAT 实测的故障以复现 |
| `akubela/connector.ts` | packages/core | 纯逻辑：事件→作业规划、作业执行、映射、入站对账、回声抑制；依赖注入 transport/clock/engine |
| `akubela/client.ts` | apps/server | RealTransport：令牌缓存与刷新、命令调用、超时、错误解析、日志脱敏 |
| `akubela/service.ts` | apps/server | 装配：读取 env、选择 Real/Sim、持久化 `data/akubela.json`、定时轮询、REST + SSE 推送 |
| 前端页面 | apps/web `#/integration/akubela` | 连接状态、房间映射与房态对照、订单链接、作业与 API 日志、功能开关、设备面板 |

**运行形态**：Node 后端形态下可选 `real`（默认，需 env 凭据）或 `sim`；GitHub Pages 纯静态形态仅 `sim`（密钥不进浏览器）。

---

## 4. 业务流程设计

### 4.1 出站：事件 → GRMS 动作

| OPERA 事件 | GRMS 动作（按序） | 备注 |
|---|---|---|
| `ASSIGN ROOM`（今日/未来到店，开关 `preRegisterOnAssign`） | `create_order_info`（start=max(now+60s, 到店日 14:00 本地)，finish=离店日 12:00 本地，state 默认 `check_in`）→ 记录链接 | GRMS 显示「待入住 / 预计今天到达」 |
| `ASSIGN ROOM` 改派 / `RELEASE ROOM` | 旧订单 `delete_order_info`（若仍 `check_in`）→ 必要时新建 | |
| `CHECK IN` | 有链接订单：`update_order_info(order_state=checked_in)`；无：`create_order_info` → `update_order_info(checked_in)`；可选：`create_authorization_record_info`（门锁 PIN）、`manual_trigger_scene`（欢迎场景）或 `control_device`（空调舒适） | start_time 不得早于 now → 取 now+60s |
| `CHECK OUT`（含提前离店） | `update_order_info(order_state=checked_out, finish_time=now)`；`update_room_state(dirty=true)`；可选：删除授权记录、触发节能场景 | |
| `ROOM MOVE` | 旧订单 checked_out + 旧房 dirty；新房 create + checked_in（remark 记"Room move from X"） | GRMS 订单无改房字段 |
| `UPDATE ROOM STATUS` | Dirty/Pickup → `update_room_state(dirty=true)`；Clean/Inspected → `dirty=false` | 仅映射房间 |
| `BUSINESS DATE CHANGE`（No-Show） | 被 No-Show 预订的 `check_in` 订单 → `delete_order_info` | |
| OOO/OOS、MUR、Turndown、Condition | 不发送（GRMS 无对应写接口），作业记为 `SKIPPED_UNSUPPORTED` | 可见于作业日志 |

**回声抑制**：`source = AKUBELA` 的事件（由入站同步产生）不再出站。

### 4.2 入站：轮询对账（默认每 20s，可配）

| 读取 | 规则 | 写入 OPERA |
|---|---|---|
| `get_room_list`（每 5 min） | 刷新 residence 清单，自动映射新房 | 映射表 |
| `get_room_info`（每个映射房） | GRMS `dirty=false` 且 OPERA 为 Dirty/Pickup 且最近一次出站不是我们写的 dirty=true（防抖 30s）→ 置 Clean | `setHkStatus Clean`（source=AKUBELA） |
| | GRMS `dirty=true` 且 OPERA Clean/Inspected → 置 Dirty | `setHkStatus Dirty` |
| | `dnd` 变化 → DND 置位/清除（仅在住） | `setServiceStatus` |
| | `occupied` 与 OPERA FO 不一致 → 不改数据，记"不一致"告警 | 对照表标红 |
| `get_order_list`（分页） | 链接订单在 GRMS 变 `checked_out` 而 OPERA 仍 InHouse（客人自助退房，开关 `acceptGrmsCheckout`）→ 退房 | `checkOut`（source=AKUBELA） |
| | GRMS 侧新建、OPERA 无链接的订单 → 列为"外部订单"，不自动建预订 | 仅展示 |
| `get_alarm_record_list` | 新告警 → OPERA Toast + 集成页告警列表 | 通知 |

### 4.3 作业队列与可靠性
- 每个出站动作是一个 **Job**：`{id, reservationId?, roomId?, eventId, command, param, status: PENDING|RUNNING|SUCCEEDED|FAILED|DEAD|SKIPPED, attempts, lastError{code,message,traceId}, createdAt, updatedAt}`。
- **按预订/房间串行**（同 key 的作业 FIFO），不同 key 并行。
- 重试：网络错误/5xx/令牌失效 → 指数退避 2s/4s/8s/16s/32s，最多 5 次后 `DEAD`；业务错误（4xx + code）直接 `FAILED`（可手工重试）。
- 令牌：缓存至过期前 120s；收到鉴权类错误立即刷新一次再重试。
- 幂等：命令 `id` = `opera-<jobId>`；创建订单前检查链接表，避免重复建单。
- 对账（Reconcile Now）：比对全部链接预订与 GRMS 订单状态、映射房 dirty 与 OPERA 房态，生成修复作业。

### 4.4 数据转换规则
- 时间：OPERA 日期 + 本地时刻（入住 14:00 / 退房 12:00，可配）按酒店时区（默认 `Asia/Shanghai`，可配；`get_project_info` 修复后自动读取）转 UTC `YYYY-MM-DD HH:mm:ss`；立即入住 start=now+60s。
- 住客：`guest_name` = OPERA 姓名（`Last, First` → `First Last`）；email/phone/id_card/passport 取预订字段，缺失时用占位（`no-email@opera-demo.local`、`N/A`）——因平台要求非空。
- `source` = `OPERA`（可配），`remark` = `OPERA #<确认号>`，`enable_booking` = false。

---

## 5. 配置（服务端 env，均不入库）

| 变量 | 说明 | 默认 |
|---|---|---|
| `AKUBELA_MODE` | `real` / `sim` / `off` | 有凭据则 `real`，否则 `sim` |
| `AKUBELA_BASE_URL` | API 网关 | `https://api.cbcloud.uat.akubela.com` |
| `AKUBELA_CLIENT_ID` / `AKUBELA_CLIENT_SECRET` | 客户端凭据 | — |
| `AKUBELA_HOTEL_TZ` | 酒店时区 | `Asia/Shanghai` |
| `AKUBELA_ROOM_MAP` | 手工映射 `operaRoom:grmsRoomNo,...`（如 `201:101`） | 空（按房号自动） |
| `AKUBELA_POLL_SECONDS` | 入站轮询周期 | 20 |

功能开关（UI 可切换并持久化）：`preRegisterOnAssign`、`syncHkStatus`、`acceptGrmsClean`、`acceptGrmsDnd`、`acceptGrmsCheckout`、`doorPinOnCheckIn`、`welcomeSceneId`、`checkoutSceneId`、`checkoutEnergySaving`。

---

## 6. 接口（服务端 REST，前端使用）

| 方法 + 路径 | 说明 |
|---|---|
| `GET /api/integrations/akubela/state` | 连接、配置、映射、订单链接、最近作业/日志/告警、GRMS 房态快照 |
| `POST /api/integrations/akubela/test` | 获取令牌 + `get_room_list` 连通性测试 |
| `POST /api/integrations/akubela/mode` | 切换 real/sim/off |
| `PUT /api/integrations/akubela/settings` | 更新功能开关 |
| `PUT /api/integrations/akubela/mapping` | 手工映射 `{roomId, residenceId|null}` |
| `POST /api/integrations/akubela/reconcile` | 立即对账 |
| `POST /api/integrations/akubela/jobs/:id/retry` | 重试作业 |
| `POST /api/integrations/akubela/poll` | 立即轮询一次 |
| `GET /api/integrations/akubela/rooms/:roomId/devices` | 设备与能力（实时调用） |
| `POST /api/integrations/akubela/devices/:deviceId/control` | 设备控制（透传 `control_device`） |
| `POST /api/integrations/akubela/scenes/:sceneId/trigger` | 触发场景 |
| SSE `event: akubela` | 集成状态增量推送 |

---

## 7. WBS 与分工

| WBS | 内容 | 依赖 | 执行 |
|---|---|---|---|
| A1 | API 摘要与只读实测（docs/06） | — | 子代理（Sonnet）✔ |
| A2 | 对接设计（本文）+ 契约 `contract.ts` | A1 | Lead |
| B1 | GRMS 模拟器 + 单测（复现文档校验规则与 UAT 故障注入） | A2 | 子代理（Sonnet） |
| B2 | Connector：规划/队列/重试/映射/入站对账/回声抑制 + 单测（基于 B1） | A2 | 子代理（Sonnet） |
| B3 | Server：RealTransport（令牌/命令/脱敏日志）、装配、持久化、REST、SSE、实网验收脚本 | A2 | 子代理（Sonnet） |
| B4 | 前端：集成页 + 房间详情 GRMS/设备区块 + 演示指南补充 | A2（REST 契约） | 子代理（Sonnet） |
| B5 | 文档：集成使用手册、部署 env 说明、README 更新 | B1–B4 | 子代理（Haiku） |
| C1 | 集成联调：Sim 端到端 + UAT 实网（可用部分）+ 浏览器视觉核对 GRMS 控制台 | B* | Lead |
| C2 | 对抗式评审与修复、合并 | C1 | Lead |

---

## 8. 验收标准

1. Sim 模式：入住→GRMS 订单 `checked_in`；退房→`checked_out` + dirty；换房→旧单退、新单入；预排房→`check_in` 待入住；No-Show→删除；HK Clean/Dirty ↔ dirty 双向；GRMS 侧退房→OPERA 自动退房；DND 回流；全部有作业日志。
2. Real 模式（UAT）：令牌、房间清单、房型、设备、订单列表等可用接口实网通过；被平台阻塞的命令在作业日志中显示 code/trace_id，平台修复后 `npm run akubela:verify` 一键回归。
3. 凭据不出现在仓库、前端产物、日志中（日志脱敏）。
4. 浏览器视觉核对：OPERA 集成页截图；GRMS 控制台房间状态/订单列表与 OPERA 一致（实网可写后）。
