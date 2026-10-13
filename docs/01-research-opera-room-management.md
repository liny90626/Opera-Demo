# WBS-1 调研报告：Oracle OPERA Cloud 房态管理 (Room Status Management) 与房态同步 (Room Status Synchronization)

> 范围：仅房态管理与房态同步；账务/收银 (Billing/Cashiering) 不在范围内。
> 调研日期：2026-10-13。

## 0. 调研方法与证据等级（必读）

本次调研的网络环境对 `docs.oracle.com` 的出站 CONNECT 被组织策略拒绝（403），WebFetch 报 `ENOTFOUND`，因此**无法逐页抓取 OPERA Cloud 用户手册全文**。实际证据来源分三级：

| 等级 | 来源 | 可信度 |
|---|---|---|
| A（直接读取原文） | GitHub `oracle/hospitality-api-docs` 的 OpenAPI 规范（经 `raw.githubusercontent.com` 拉取，版本 **26.3.0.0**）：<br>`https://raw.githubusercontent.com/oracle/hospitality-api-docs/main/rest-api-specs/property/v1/hsk.json`（Housekeeping, `basePath=/hsk/v1`）<br>`.../fof.json`（Front Desk Operations, `/fof/v1`）<br>`.../csh.json`（Cashiering，仅取 checkOut 路径） | 最高：字段名、枚举、路径均为原文 |
| B（搜索结果摘要，含 docs.oracle.com 页面的引用片段） | WebSearch 返回的 Oracle 官方页面摘要（URL 见各节），如 Housekeeping Board、Room Discrepancies、Out of Order/Service、OPERA Controls—Room Management、Queue Rooms、OHIP Workflow 指南 | 中：片段为官方文字，但未见全文，细节可能缺失 |
| C（推测/行业经验） | 无法从上述来源证实的 UI 细节、业务规则 | 低：均标注 "(未证实/推测)" |

**结论性提醒**：Housekeeping Board 的确切列定义、仪表盘 Tile 的内部算法、Business Event 的 payload 字段全文，本次均未能读到官方原文；相关处已标注。建议 PO 在有 OPERA Cloud 试用/培训环境时对照截图校正（见第 8 节开放问题）。

主要引用 URL（B 级，均为 docs.oracle.com，未能直接抓取）：
- Housekeeping Board：https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.3/ocsuh/t_housekeeping_using_the_housekeeping_board.htm
- Room Management 概览：https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.4/ocsuh/c_housekeeping_room_management.htm
- Room Discrepancies：https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.1/ocsuh/t_housekeeping_viewing_room_discrepancies.htm
- Out of Order：https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.5/ocsuh/t_housekeeping_out_of_order.htm
- Out of Service：https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.4/ocsuh/t_housekeeping_out_of_service.htm
- OPERA Controls—Room Management：https://docs.oracle.com/en/industries/hospitality/opera-cloud/24.2/ocsuh/c_opera_controls_room_management.htm
- Queue Rooms / 预订排队：https://docs.oracle.com/en/industries/hospitality/opera-cloud/24.2/ocsuh/t_arrivals_in-house_adding_reservation_to_queue.htm
- Task Sheets：https://docs.oracle.com/en/industries/hospitality/opera-cloud/22.3/ocsuh/c_tasksheets_task_sheets.htm ；生成：https://docs.oracle.com/en/industries/hospitality/opera-cloud/22.3/ocsuh/t_tasksheets_generating_task_sheets.htm
- Auto Generate Task Sheets（视频文字稿）：https://docs.oracle.com/en/industries/hospitality/opera-cloud/24.3/ocsuh/cc-auto-generate-tasksheets.htm
- 移动端 Room Status：https://docs.oracle.com/en/industries/hospitality/opera-cloud/25.1/ocsuh/t_room_status_mobile_app.htm ；PWA：https://docs.oracle.com/en/industries/hospitality/opera-cloud/24.4/ocsuh/t_room_status_mobile_app_pwa.htm
- OHIP 房态更新工作流：https://docs.oracle.com/en/industries/hospitality/integration-platform/hsooo/t_workflow_updating_housekeeping_room_status.htm
- OHIP OOS 工作流：https://docs.oracle.com/en/industries/hospitality/integration-platform/hsooo/t_workflow_update_out_of_service_status.htm
- OHIP 前置条件（事件订阅）：https://docs.oracle.com/en/industries/hospitality/integration-platform/hsooo/r_prerequisites.htm
- OHIP 认证：https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/c_authenticating_to_oracle_hospitality_property_apis_ocim.htm ；OAuth Token：https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/c_oauth_token_api.htm ；WebSocket 授权：https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/t_web_socket_authorization.htm ；Polling API：https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/t_polling_api.htm
- OHIP 规范仓库：https://github.com/oracle/hospitality-api-docs

---

## 1. 导航 / 菜单路径与仪表盘 Tile 含义

### 1.1 顶层菜单（来自参考截图）
黑色顶栏：汉堡菜单、业务日期 (Business Date)、物业 `PROP1 - First Property In this Schema`、用户。菜单栏：
`OPERA Cloud | Client Relations | Bookings | Front Desk | Inventory | Financials | Channel | Miscellaneous | Reports`。

### 1.2 房态相关屏幕菜单路径
| 屏幕 | 路径 | 证据 |
|---|---|---|
| Housekeeping Board（房务看板） | **Inventory > Room Management > Housekeeping Board** | B：25.3 手册摘要 |
| Room Discrepancies（房态差异） | **Inventory > Room Management > Room Discrepancies** | B：25.1 手册摘要 |
| Out of Order Rooms | **Inventory > Room Management > Out of Order**（OOO 与 OOS 为两个独立屏幕） | B（精确菜单文字 未证实） |
| Out of Service Rooms | **Inventory > Room Management > Out of Service** | B（同上） |
| Room Conditions（房间条件） | Inventory > Room Management 下（具体项名 未证实/推测：`Room Conditions`） | 规范有 `/conditions`，菜单名推测 |
| Task Sheets（任务单） | Inventory > Housekeeping（或 Room Management）> Task Sheets（路径 未证实/推测） | 仅知功能存在 |
| Housekeeping Attendant Console | Inventory 下，数据来自 Task Sheet Companion（路径 未证实/推测） | B |
| Queue Rooms（排队房间） | Front Desk > Queue Rooms（推测；摘要显示“Queue Rooms”为 Front Desk 功能，OPERA 5 帮助为 `Queue Reservations`） | 路径 未证实/推测 |
| Room Assignment / 排房 | Front Desk > Arrivals（Assign Room）或 Reservation 内 Room 字段 | 推测 |
| Room Move（换房） | Front Desk > In House > Room Move（或预订内 “Move Room” 按钮）| 推测；API 为 `moveInHouseGuest` |
| 移动端 / PWA | OPERA Cloud Mobile（Room Status PWA）：vacant 房间左滑到右可设 OOO/OOS、Prioritize、改 HK 状态 | B：25.1 PWA 页面摘要 |

### 1.3 仪表盘 Tile 含义（Dashboard）

> 以下含义：结构来自截图描述；数据来源映射由本报告根据 OHIP `fof` 统计 API 的字段**推断**，Tile 内部算法 (未证实/推测)。

**Room Status 磁贴**：4 个状态图标，每个图标下按 FO 状态分 Occupied / Assigned / Vacant 计数。
| 图标 | 含义 | 对应 HK 状态 |
|---|---|---|
| 绿色剪贴板对勾 (green clipboard check) | Inspected（已检查）(IP) | `Inspected` |
| 蓝色闪光 (blue sparkle) | Clean（已清洁）(CL) | `Clean` |
| 橙色 (orange) | 推测为 Pickup(PU) 或 Dirty(DI)（截图仅描述颜色）(未证实/推测) | `Pickup`/`Dirty` |
| 红色垃圾桶 (red trash) | Dirty（脏房）(DI) | `Dirty` |
- Occupied = FO 状态已占用；Vacant = FO 状态空房；Assigned = 已被预订分配但尚未入住的房间（推测；`roomAssignmentStatus` 有 Assigned/Unassigned）。
- 数据来源类 API：`GET /fof/v1/hotels/{hotelId}/roomStatusStatistics`（按 roomClass/roomType、frontOfficeStatus 分组，`roomStats[{housekeepingRoomStatus, housekeepingRoomStatusCount}]`，原文说明：“For current business date, rooms are grouped by the roomClass and roomType to display their housekeeping roomStatus.”）。
- 可点击钻取到 Housekeeping Board 并带上状态过滤（推测）。

**Queue Reservations 磁贴**：已到店但房间未就绪、正在排队的预订。显示：队列数 (count in queue)、当前等待时间 (current wait)、平均等待时间 (average wait)、可用空房按 HK 状态分布。
- 对应 API：`GET /fof/v1/hotels/{hotelId}/queueReservationsStatistics` → `statistics.roomType[{roomType, totalInQueue, fOStatus[{frontOfficeStatus, totalRooms, roomStatus[{housekeepingRoomStatus, totalRooms}]}]}]`，另有 `averageQueueTimeToCheckIn`（整数）与 `averageQueueTimeCurrentReservations`（整数）（A 级，原文字段）。

**Room Summary 磁贴**：
| 指标 | 含义 |
|---|---|
| Physical Rooms | 物理房间总数（含 OOO/OOS、不含伪房 pseudo rooms，推测） |
| Inventory Rooms | 可售库存房间数 = Physical − Out of Order（OOO 从库存扣除，OOS 不扣）（规则见 §2.7；公式 推测） |
| Out of Order | 当日 OOO 房间数 |
| Out of Service | 当日 OOS 房间数 |
- B 级依据：“Out of Order … removed from inventory availability… Out of Service … remains part of inventory”。

**其他**：顶栏业务日期 = OPERA 的 Business Date，只在夜审 (End of Day) 时推进，不随自然日变化（OPERA 通识；Demo 应将 businessDate 作为系统状态）。

---

## 2. 房态模型 (Room Status Model)

### 2.1 五个相互独立又相互影响的维度
OPERA 将“房间当前状态”拆分为多个正交字段（A 级：`hsk.json` 的 `roomStatusType`/`housekeepingType`/`roomType` 定义）：

| 维度 | OHIP 字段 / 枚举 | 取值 | 谁来改 |
|---|---|---|---|
| **HK 房态** (Housekeeping Room Status) | `housekeepingRoomStatus` ∈ `housekeepingRoomStatusType` | `Clean` `Dirty` `Pickup` `Inspected` `OutOfOrder` `OutOfService` | 客房部/前台/接口 |
| **前台状态** (Front Office Status) | `frontOfficeStatus` ∈ `frontOfficeRoomStatusType` | `Vacant` `Occupied` | 由入住/退房驱动（系统） |
| **HK 占用观察** (Housekeeping Occupancy Observation) | `housekeepingStatus`（在 `roomStatusType` 中同为 Vacant/Occupied；在 PUT 请求里 `housekeepingStatus`: Vacant/Occupied）| `Vacant` `Occupied` | 客房员在 Set Room Status 屏幕登记（见 §2.5） |
| **房间预订状态** (Room Reservation Status) | `reservationStatusInfo` ∈ `housekeepingRoomReservationStatusType` | `Arrival` `Arrived` `DayUse` `DueOut` `Departed` `NotReserved` `StayOver` | 系统由预订推导 |
| **客人服务状态** (Guest Service Status) | `guestServiceRequest` ∈ `guestHousekeepingServiceRequestType` | `DoNotDisturb` `MakeUpRoom` `NoStatusSelected` `ServiceDeclined` | PBX/接口/前台 |
| 夜床服务 (Turndown) | `turndownStatus` ∈ `turndownStatusType` | `Required` `NotRequired` `Compeleted`（原文拼写如此，**Completed 拼错为 Compeleted**） | 前台/系统 |
| 清洁优先级 | `cleaningPriority.prioritySequence` (int) | 序号 | 前台/客房 |
| 房间条件 (Room Condition) | `roomCondition{ roomCondition(code+desc), assignmentType, remarks }` | `assignmentType` ∈ `Available`/`NotAvailable` | 客房/前台 |
| 差异 (Discrepancy) | `discrepancy[]` ∈ `roomDiscrepancyType` | `Sleep` `Skip` `PersonDiscrepancy`（描述中另有 Due Out Only 过滤）| 系统派生 |
| 人数 | `roomPersons{ frontOfficePersons, houseKeepingPersons }` | int | FO/HK |

另有 `linenChange`(bool)、`roomCompleted`(bool)、`facilityTaskCode`、`hold{holdUntil, holdUser, comments}`（占房 Hold，`POST /fof/.../rooms/onHold`）。

### 2.2 HK 房态代码（B 级 + A 级）
| 代码 | 状态 | 是否受参数控制 (OPERA Controls) |
|---|---|---|
| **IP** | Inspected（已查房） | **可选**，需 `Inspected Status` 控制开启 |
| **CL** | Clean | 基础状态 |
| **PU** | Pickup（轻度整理 touch-up，例如房间只被占用几分钟） | **可选**，需 `Pickup Status` 控制开启 |
| **DI** | Dirty | 基础状态 |
| **OS** | Out of Service（不可入住，仍计库存，仍可被售卖/分配） | **可选**，需 `Out of Service` 控制开启 |
| **OO** | Out of Order（不可分配，从库存扣除，影响 RevPAR/ADR/入住率） | 需 `Out of Order` 控制（OHIP 前置条件称 OOO/OOS 控制须开启）|
- 状态选择列表由已启用的 Inspected/Pickup/OOS 控制决定（B：OPERA Controls—Room Management 摘要）。
- OOO/OOS **不应通过普通“改房态”入口设置**，须用 Managing Out of Order / Out of Service 专用屏幕（B）。但 OHIP 的 `putRoomRelatedStatus` 枚举里包含 OutOfOrder/OutOfService（A），实际接口是否接受 OOO/OOS 通过该口设置 (未证实/推测，建议 Demo 拒绝)。

### 2.3 状态“层级”与自动更新（夜审）
- B（来自 OPERA 5.x 旧版控制参数说明，OPERA Cloud 是否相同 **未证实**）：夜审的 housekeeping 步骤可把“所有占用房”更新为配置的房态（典型为 Dirty），并把“层级更高的空房”（如 Inspected）降为所选状态。
- B（OPERA Cloud）：Make Up Room (MUR) 服务状态在 **End of Day 清除**，Do Not Disturb (DND) 在 EOD 后**保留**。
- B：OOO/OOS 房间在“Through Date（结束日期）”的 EOD 自动回库存；若当日人工更改了 HK 状态，则也会清除 OOO 状态；若未改状态，则在 EOD 同日自动回到服务。
- Day-use 退房默认状态可配置为 Clean/Dirty/Inspected/Pickup（B：Room Management 控制）。
- 夜审对 Stayover 房的标记（把占用房置 Dirty 以生成次日 stayover 任务）是行业惯例 (未证实/推测)。

### 2.4 状态转换与规则（Demo 规则建议；标注证据）
| 触发 | 转换 | 证据 |
|---|---|---|
| 客人退房 (Check-out) | FO: Occupied → Vacant；HK: → **Dirty**（默认） | 规范 `csh.json` 有 `POST /hotels/{hotelId}/reservations/{reservationId}/checkOuts`；退房后置 Dirty 为 OPERA 通行行为，**原文未在搜索结果中直接证实** (未证实/推测，但与 Day-use 可配置退房状态相符) |
| 客房员清洁完成 | Dirty → Clean（或 Pickup → Clean） | B |
| 主管查房 | Clean → Inspected（仅在启用 Inspected 时） | B |
| 入住 (Check-in) | FO: Vacant → Occupied；要求房间 Vacant 且 HK 为 Clean/Inspected | B：“可在房间 vacant 且 HK 状态为 clean 或 inspected 后完成入住” |
| 入住时房间非 Clean/Inspected | 提示后可 “Stop check-in” 把预订放入 Queue | B（Queue 文档）；`postCheckIn` 有 `stopCheckin` 字段（A） |
| 分配 Dirty 房间 | 需要 override：`overrideInstructions.dirtyRoom = true` | A：`postRoomAssignment` |
| 分配 OOS 房间 | `overrideInstructions.outOfServiceRoom = true` | A |
| 分配 Sleep/Skip 差异房间 | `sleepDiscrepantRoom` / `skipDiscrepantRoom` 覆盖 | A |
| 分配 Hold 房间 | `holdRoom = true` | A |
| 其他覆盖项 | `occupancyRestriction`, `rateRestriction`, `inventoryRestriction`, `roomNumberLocked`, `overrideRoomFeatures`, `overrideRoomOwnership`, `overrideRotationRoom`, `dayUseReserved`... | A |

### 2.5 差异检测 (Discrepancies)
定义（B：25.1 Room Discrepancies 页面摘要）：
- **Sleep（睡房）**：前台显示房间 **Vacant**，但客房部报告为 **Occupied**（有人睡在系统认为空的房里）。
- **Skip（跑单）**：前台显示 **Occupied**（有预订已入住），但客房部报告房间 **Vacant**（客人可能已离店未退房）。
- **Person（人数差异）**：前台登记人数与客房部观察人数不一致；`Person Discrepancy` OPERA Control 开启后才出现（25.1+ 才有；≤24.2 仅 Sleep/Skip）。
- 产生方式：客房员在 **Set Room Status** 屏幕展开 *Housekeeping Status* 区，选 Vacant/Occupied（HK 观察），与 FO 状态不一致即产生差异；Person 差异时屏幕显示 FO 人数，客房员增减 HK 人数。
- 解决：前台必须通过**办理入住或退房**来消除差异（B）；旧版指南提供“Update to Front Office status”快捷方式，将 HK 状态改成与 FO 一致即可清除（B，旧版）。
- 查询：`GET /hsk/v1/hotels/{hotelId}/housekeepingDiscrepancies`，查询参数 `roomDiscrepancyStatus[]`(Sleep|Skip|PersonDiscrepancy)、`fromRoomNumber`、`toRoomNumber`、`roomClass[]`、`floor[]`、`housekeepingStartDate`、`housekeepingEndDate`、`dueOut`(bool，仅今日离店)（A）。
- 差异房间的分配限制：见上，需 override。

### 2.6 服务状态 (Guest Service Status: DND / MUR)
- 需 `Guest Service Status` 控制开启；可由集成系统（如 PBX）设置（B）。
- OHIP 值：`DoNotDisturb`、`MakeUpRoom`、`NoStatusSelected`、`ServiceDeclined`；`serviceRequestStatus` 过滤另含 `Open`、`PendingFollowUp`、`Closed`（A）。
- MUR 在 EOD 清除，DND 保留（B）。
- 写入 API：`PUT /hsk/v1/hotels/{hotelId}/serviceRequests`（`setGuestHousekeepingServiceRequest`）以及 FO 侧 `/fof/v1/hotels/{hotelId}/serviceRequests`（`getServiceRequests/putServiceRequests/postServiceRequests/deleteServiceRequests`）（A，请求体未展开）。
- 任务单生成时可把 DND、NSR(No Service Required) 房间分到单独任务单（`separateDNDRooms`, `separateNSRRooms`）（A）。

### 2.7 OOO vs OOS（库存影响与规则）
| 项目 | Out of Order (OO) | Out of Service (OS) |
|---|---|---|
| 库存 | **从库存可用量中扣除**，不能分配预订；影响 RevPAR、平均房价、入住率 | **仍计入库存**，必要时可被分配/出售 |
| 菜单 | Inventory > Room Management > Out of Order | …> Out of Service |
| 必填/字段 | From Date、Through Date、Reason（下拉；若启用 `Unit Status` 控制，Reason 替换为 Unit Status）、Return Status、Remarks；`Time` 仅在 `Required Return Time` 控制开启时显示（信息性） | 同左 |
| 返回状态 | `returnStatus` ∈ Clean/Dirty/Pickup/Inspected（Complete 时指定） | 同左 |
| 回库存时机 | Through Date 的 End-of-Day 自动回；或当天改 HK 状态即清除；否则 EOD 同日自动回服务 | 同左 |
| 编辑/删除 | 搜索结果选房 → 垂直省略号 Actions → Edit / Delete | 同左 |
| 原因配置 | Configuration > Rooms Management > Out of Order Reasons（旧版路径，Cloud 未证实） | 类似 |
- A 级 API 字段 `roomOutOfOrder`：`repairRemarks`(≤2000)、`returnStatus`、`reasonCode`(≤20)、`reasonDescription`(≤80)、`newDateRange{start,end}`（日期更改时填）、`start`、`end`（日期 `YYYY-MM-DD`）、`endTime`、`roomRepairId`（OO/OS 记录唯一 ID）。
- 只能对 **Vacant** 房设置 OOO/OOS（移动端：“swipe a vacant room”）；对 Occupied 房设置的限制 (未证实/推测)。
- 查询时间跨度：`getOutOfOrderRooms` 限 **90 天**（A，原文 “This API allows a time span of 90 days.”）。

---

## 3. 房务屏幕详解

### 3.1 Housekeeping Board（房务看板）
路径：Inventory > Room Management > Housekeeping Board（B）。

**搜索条件 (Search Filters)**（B：手册 + A：`getHousekeepingOverview` 查询参数，二者互相印证）
| UI 过滤 | OHIP 参数 | 取值 |
|---|---|---|
| Room（房号范围 From/To） | `fromRoomNumber`, `toRoomNumber`, `roomIdText`(通配) | 字符串；房号为字符字段，**非严格数值排序**；只填 From 则返回该房及其后所有房（B） |
| Floor | `floor[]` | |
| Room Type / Room Class | `roomType[]`, `roomClass[]` | |
| Building | `building[]` | |
| Room Features | `roomFeatures[]` | |
| Room Status (HK) | `housekeepingRoomStatus[]` | Clean/Dirty/Pickup/Inspected/OutOfOrder/OutOfService |
| Front Office Status | `frontOfficeRoomStatus[]` | Vacant/Occupied |
| Reservation Status | `reservationStatus[]` | Arrival/Arrived/DayUse/DueOut/Departed/NotReserved/StayOver |
| Turndown Status | `turndownStatus[]` | Required/NotRequired/Compeleted |
| Guest Service Status | `guestServiceRequest`（单值）/`serviceRequestStatus[]` | DoNotDisturb/MakeUpRoom/NoStatusSelected/ServiceDeclined；Open/PendingFollowUp/Closed |
| Room Assignment Status | `roomAssignmentStatus[]` | Assigned/Unassigned |
| Room Parity | `roomParityStatus[]` | Odd/Even（奇偶房号，方便分区） |
| AM/PM Section | `daySection[]`, `eveningSection[]` | 白班/晚班分区码 |
| 其他开关 | `excludeCombo`, `cleaningPriorityOnly`, `scheduledRoomMovesOnly`, `attendantInRoomOnly` | bool |
| 附加返回 | `fetchInstructions[]` | Summary/ResvInfo/TurndownInfo/ScheduedRoomMoveInfo/ResvQueueInfo/AttendantInRoomInfo |
| 分页 | `limit`, `offset` → 返回 `totalPages/offset/limit/hasMore/totalResults/count` | |

**返回结构**（A：`housekeepingBoard`）：`housekeepingRoomInfo.housekeepingRooms.room[]` + `housekeepingRoomStatusInfoList[{housekeepingRoomStatus, numberOfRooms, code}]`（顶部各状态计数汇总条）。
每间房 (`roomType` 对象) 含：`roomId`, `roomType{roomType, roomClass, shortDescription, maximumOccupancy, ...}`, `floor`, `floorDescription`, `building`, `roomFeatures`, `roomSection{daySectionCode, eveningSectionCode}`, `housekeeping{housekeepingRoomStatus{reservationStatusList, housekeepingRoomStatus, frontOfficeStatus, housekeepingStatus}, roomPersons, guestServiceRequest, cleaningPriority, roomCondition, linenChange, facilityTaskCode, roomCompleted}`, `outOfOrder[]`, `discrepancy[]`, `connectingRooms`, `attendant[]{attendantId, attendantName, section, floor, status(Standby|Break|Working|Completed), startTime}`, `hold`, `turndownInfo`, `resvInfo[]{guestName, reservationId, reservationStatusInfo, stayDateInfo, vipStatus, profileId, roomId, adult/child 数...}`。
→ **这些就是看板表格列的合理来源**：Room、Room Type、HK Status、FO Status、Reservation Status、Guest Name/VIP、Arrival/Departure、Persons(FO/HK)、Service Status、Turndown、Attendant、Condition、Discrepancy 等。**精确列名与顺序 (未证实/推测)**。

**操作 (Actions)**（B）：搜索 → 勾选房间 → **Update Room Status** 打开 *Set Room Status* 屏幕（展开 Housekeeping Status 选 Vacant/Occupied，选 HK 房态，Turndown，人数，可 *Prioritize*（置顶清洁优先））；支持**批量**选择多间房同时改状态。查看预订详情（Viewing Reservation Details from the Housekeeping Board）；OOO/OOS 通过专用入口。
- 批量改状态 API：`PUT /hsk/v1/hotels/{hotelId}/rooms/status`（`putRoomRelatedStatus`），请求体见 §5。
- 清洁优先级：`PUT /hsk/v1/hotels/{hotelId}/rooms/{roomId}/cleaningPriority`（body `criteria.roomList[]`）；`DELETE .../rooms/cleaningPriority` 清除。

### 3.2 Room Discrepancies
路径 Inventory > Room Management > Room Discrepancies（B）。过滤：房号范围、Room Class、Floor、**Skip**（客房报占用/前台空）、**Sleep**、**Person**（25.1+）、**Due Out Only**。结果表列 (未证实/推测)：Room、Room Type、FO Status、HK Status、Discrepancy 类型、FO/HK Persons、Reservation 信息。动作：按 §2.5 通过入住/退房解决，或（旧版）Update to Front Office Status。

### 3.3 Out of Order / Out of Service 屏幕
- 搜索：房号/房型/房类、日期范围；结果列表可 Edit/Delete；"New" 创建时选房（支持房号范围 `range.roomRange{fromRoomNumber,toRoomNumber}` 与离散列表 `roomIds[]`）+ From/Through、Reason、Return Status、Remarks（B + A）。
- 新增/更新：`POST /hsk/v1/hotels/{hotelId}/rooms/outOfOrderRooms`（`postOutOfOrderRooms`）、`.../outOfServiceRooms`（`postOutOfServiceRooms`）——“初次设置并可更新已有记录”（原文）。更新日期用 `newDateRange`。
- 完成（回服务）：`PUT .../outOfOrderRooms`（`completeOutOfOrderRooms`），`criteria.roomRepairByRoomNumber[]{roomId, roomOutOfOrder{returnStatus,...}}`；OOS 对应 `PUT .../outOfServiceRooms`（`completeOutOfServiceRooms`）。
- 查询：`GET .../outOfOrderRooms` / `.../outOfServiceRooms`，必填 `startDate`；可选 `endDate`、`roomId`、`roomTypes[]`、`roomClasses[]`（≤90 天）。
- 房间维修单（Room Maintenance，另一概念）：`GET /hsk/v1/hotels/{hotelId}/rooms/maintenances`，`POST .../rooms/maintenanceCodes/{maintenanceCode}`，`PUT .../rooms/{roomId}/maintenances/{maintenanceId}`，`PUT .../maintenances/{id}/resolve|unResolve`，`DELETE .../maintenances/{id}`；`roomMaintenanceType{maintenanceCode, remarks, maintenanceId, roomInfo, resolveInfo, assignedUserInfo, images[], imageCount, createDateTime...}`（A）。维修单**不影响库存**，与 OOO/OOS 不同（推测，未证实）。

### 3.4 Room Conditions（房间条件）
- 用途（A 原文）：“designate rooms that are available for show, set aside for special housekeeping attention, or treated differently”。
- `PUT /hsk/v1/hotels/{hotelId}/conditions` 设置/变更/删除：`criteria{hotelId, roomNumberList[], roomCondition{roomCondition{code,description}, assignmentType(Available|NotAvailable), remarks}, includeOccupiedRooms, overrideHoldRooms}`。
- `GET .../conditions` 过滤：`roomConditionsOnly`, `roomWithoutConditionsOnly`, `room`, `fromRoomNumber/toRoomNumber`, `roomConditions[]`, `roomTypes[]`, `roomClasses[]`, `frontOfficeRoomStatus[]`, `reservationStatuses[]`, `roomAssignmentStatus[]`, `floors[]`, `roomFeatures[]`, `amSections[]`, `pmSections[]`, `buildings[]`, `housekeepingRoomStatus[]`, `roomParityStatus[]`。
- `assignmentType=NotAvailable`：应用条件后房间**不出现在排房 (Room Assignment) 列表**；`getHotelRooms` 参数 `includeAllRoomConditions`（false 时只含 “General Assignment” 条件的房）印证。

### 3.5 Queue Rooms（排队房间）
- 场景：客人已到店，房间未就绪；入住时可将预订加入队列，房就绪（vacant + Clean/Inspected）后完成入住（B）。已指定房号的预订不触发“排队”提示（B）。
- 客房员可在 OPERA Cloud Mobile 中看到排队房以便加急；集成 SMS 后可发“rush room”提醒给客房员，房就绪后短信通知客人（B）。
- API（A）：`GET /fof/v1/hotels/{hotelId}/queuedReservations`（过滤 `roomClassCodes[]`, `roomTypeCodes[]`, `roomNumberWildCard`, `guestNameWildCard`），`PUT .../queuedReservations/{reservationId}` 加入队列，`DELETE` 移出；`PUT .../reservations/{reservationId}/priority`（`putReservationQueuePriority`）；`PUT .../reservations/{reservationId}/textMessages/{messageType}` 发送短信（`deliverQueueRoomsTextMessage`）；`GET .../textMessages/{messageType}`。
- 预订数据含 `queue{reservationQueueInformationType}`、`roomStatus`、`housekeeping{resHousekeepingType}`。

### 3.6 Task Sheets / 客房员分配
概念（B）：
- **Task Sheet（任务单）**：一个客房员（Attendant）一天的任务清单，含房间列表与**积分 Credits**；可手工创建或 **Auto Generate**。
- **Credits 计算**由 `Housekeeping Credits` OPERA Control 决定：`Room`（房间上配置的积分）、`Facility`（任务计划上的积分）、`Room_Task_Rule`；跨楼层加 **Traveling Task Credit**（每换一层加一次）。
- `housekeepingCreditsDefinitionType` 枚举（A）：`Departure, Pickup, Turndown, StayOver, FacilityTask, Travelling, Miscellaneous, Special, Total, ItemInventory`。
- **自动生成**：按客房员人数和每房 credits 平均分配；剩余房间进入**浮动溢出单 (floating overflow sheet)**；示例每单上限 60 credits；"Stayovers First"将续住与离店分成不同单；离店预订的房间总是分配 Departure 任务；DND/NSR 可单独成单（B）。
- A：`POST /hsk/v1/hotels/{hotelId}/autoTaskSheets` body `criteria{ taskCodes[], attendants[], roomClassList[], excludeVIPCodes[], taskDate(YYYYMMDD), numberOfAttendants, sheetOrderBy(Room|Floor|Section|SectionGroups|Building|BuildingGroups), maximumCreditsPerSheet, returnTaskSheets, turndown, vIPOnly, separateNSRRooms, separateDNDRooms, sectionTypeToUse(Day|Evening), templateCode, stayOverFirst, defaultTemplate, ruleCodes[] ...}`。
- 其他 A 级：`POST/PUT/DELETE /taskSheets`，`PUT /taskSheets/rooms`（增改房）、`DELETE /taskSheets/rooms`，`POST /taskSheets/{toTaskSequenceNo}/merge`，`PUT /taskSheets/{sheetNumber}/lock|unlock`，`PUT /taskSheet/{taskSequenceNumber}/complete|reopen`，`PUT /taskSheetSet/{taskCodesBreakOutId}/complete|reopen`，`PUT /moveTaskRooms`，任务模板 `/taskSheetTemplates`，休息 `PUT /taskSheets/{taskSheetNumber}/start|end`（`startServiceBreak/endServiceBreak`）。
- 单房任务生命周期（A）：`PUT /rooms/{roomId}/sheets/{sheetNumber}/start` → `/complete` 或 `/skip`，或 `PUT .../sheets/{sheetNumber}`（cancel）。
- **Sections（分区）**：`housekeepingSectionType{hotelId, code, description, sectionGroup, targetCredits}`；房间有 `daySectionCode`（AM）与 `eveningSectionCode`（PM）。`Housekeeping Sections` 参数开启后可配置分区与分区组（B）。
- 客房员排班：`GET /attendants/houseKeepingTasks`、`POST /schedules/houseKeepingTasks`。attendant 字段含 `attendantId, attendantName, activeFlag, sunday..saturday（每周可上班日）, attendantInstructions, status`。
- 统计：`GET /fof/v1/hotels/{hotelId}/houseKeepingStatistics`（`getTaskSheetStatistics`）。

### 3.7 Housekeeping Attendant Console 与移动端
- Attendant Console（B）：评估每间房服务用时、任务完成百分比、总 credits / 已完成 credits、客房员相对位置；数据来自 **Task Sheet Companion**（Mobile Task Sheet Companion）。客房员状态：`Standby/Break/Working/Completed`（A 枚举）。
- 移动端 Room Status（B）：按状态过滤房间列表；对 vacant 房**左滑→右**可设 OOO/OOS、Prioritize 或改 HK 状态。
- 客房员在房间任务页 Start/Complete/Skip → 触发房态变化（Complete 后 → Clean，推测）。

---

## 4. 前台触点 (Front Desk Touch Points)

### 4.1 排房 (Room Assignment)
- `POST /fof/v1/hotels/{hotelId}/reservations/{reservationId}/roomAssignments`（`postRoomAssignment`）：“assign a room to a reservation in reserved status”。body：`criteria{hotelId, reservationIdList[], roomId, overrideInstructions{dirtyRoom, outOfServiceRoom, sleepDiscrepantRoom, skipDiscrepantRoom, holdRoom, occupancyRestriction, rateRestriction, inventoryRestriction, roomNumberLocked, rateChange, overrideRoomFeatures, overrideRoomOwnership, overrideRotationRoom, dayUseReserved, overrideExternalChecks, overrideSharesStayingPastDepartureCheck}, includedBackToBack[], includedSharers[], updateRoomTypeCharged, includeDepartureRooms, ignoreMoveOutRooms, roomNumberLocked, orderBy(ForecastRotationPoints), scheduledRoomSegmentNumber, roomSegmentBeginDate, roomSegmentEndDate, comments}`（A）。
- 选房：`GET /fof/v1/hotels/{hotelId}/rooms`（`getHotelRooms`）：`hotelRoomStatus[]`, `hotelFORoomStatus[]`, `fromRoomNumber/toRoomNumber`, `hotelRoomStartDate/EndDate`, `roomType[]`, `roomClass`, `floor`, `includeDueOut`（含将离店的房）+`departureTime`, `roomFeatureCode[]`, `excludeRoomFeatures[]`, `smokingPreference`, `includePseudoRooms`, `connectingRoomsOnly`, `reservationId`, `orderBy`(ForecastRotationPoints|VacantDays|LastStayDate|NightsToNextStay|NextStayDate|RoomNumber|RoomType), `sortOrder`, 分页 `limit/offset`（A，时间跨度 ≤180 天）。`GET .../reservations/{id}/suggestedRooms`（A）。
- 自动排房：`POST /reservations/autoRoomAssignments`，`DELETE` 取消；AI 排房 `POST /reservations/ai/rooms`（A）。
- 取消排房：`PUT /reservations/{id}/rooms`（`deleteAssignRoom`）。
- 业务规则（B+A 推导）：默认只可分配 Vacant 且 Clean/Inspected（若参数允许 Pickup 则亦可，推测）的房；Dirty/OOS/Sleep/Skip/Hold/条件不可用 → 需显式 override 或被过滤；OOO 不可分配（从库存扣除）。

### 4.2 入住 (Check-in)
- `POST /fof/v1/hotels/{hotelId}/reservations/{reservationId}/checkIns`：前置条件“预订需为 *due in* 状态”；可选 body 内 `reservation.roomId` 选房；字段 `checkOutTime, startCheckInProcessTime, endCheckInProcessTime, lockHandle, profilePrivacyPrompted, ignoreWarnings, stopCheckin, printRegistration, overrideAdvancePaymentValidation, checkInInitiatedBy`；`fetchReservationInstruction[]` ∈ ReservationDetail/AutoFolios/ExcludeRoomSuggestion。
- 撤销入住：`DELETE .../checkIns`；预入住 `POST/DELETE .../advanceCheckIns`；批量 `POST /reservations/massCheckIns`、`massAdvanceCheckIns`；校验 `GET .../verifyCheckIns`。
- 入住后：FO 状态 Occupied；预订状态 Arrival → Arrived（房态视角，推测）；发房卡 `roomKeys`（`POST /reservations/{id}/roomKeys`）。

### 4.3 退房 (Check-out)
- 属于 Cashiering API：`POST /csh/v1/hotels/{hotelId}/reservations/{reservationId}/checkOuts`，`PUT .../checkOuts/reinstate`（撤销退房），`POST /hotels/{hotelId}/autoCheckoutReservations/batchJobs`，`POST .../zeroBalanceCheckoutReservations/batchJobs`（A，`csh.json`）。本 Demo 不做账务，退房动作简化为“无账务校验的退房”。
- 房态效果：FO Occupied → Vacant，HK → Dirty（默认，推测，见 §2.4）。

### 4.4 换房 (Room Move)
- `PUT /fof/v1/hotels/{hotelId}/reservations/{reservationId}/rooms/{roomId}/roomMoves`（`moveInHouseGuest`）：body `criteria{ reservationIdList[], roomId(新房), overrideInstructions{同上}, includedSharers[], updateRoomTypeCharged, includeDepartureRooms, roomNumberLocked, oldRoomStatus(HK 状态，即旧房换出后的状态), reasonCode, description, orderBy ...}`。**`oldRoomStatus`** 决定旧房换出后的房态（Clean/Dirty/Pickup/Inspected…）(A)。
- 换房历史：`GET .../reservations/{id}/roomMoveHistory`；换房互换：`shiftRooms`/`swapRooms`（两个预订间）。
- 预定换房（scheduled room move）：见看板 `scheduledRoomMovesOnly` 与 `ScheduedRoomMoveInfo`。

### 4.5 其它前台相关
- 房间占用保留 Hold：`POST /fof/v1/hotels/{hotelId}/rooms/onHold`、`.../onHold/release`（A）。
- 房间接口状态（PBX/电话）：`GET/PUT /fof/v1/hotels/{hotelId}/interfaces/{interfaceId}/roomStatuses`（`putRoomInterfaceStatus`；body `reservationInterfaceStatus{logo, interfaceStatusList[{reservationId, roomExtension, interfaceRights[]}]}`）。
- 叫醒服务 `/wakeUpCalls`（与房态同步无关，略）。

---

## 5. OHIP 集成

### 5.1 认证与通用头 (A：规范参数定义 + B：OHIP 认证文档)
| Header | 说明 |
|---|---|
| `Authorization: Bearer <token>` | 必填。OAuth 令牌。客户端凭证环境：`POST {gateway}/oauth/v1/tokens`，`grant_type=client_credentials`，附 scope，头带 `x-app-key`/enterprise id；另一种是 Resource Owner（密码授权 + 集成用户）。令牌约 60 分钟过期，建议到期前约 2 分钟刷新（B） |
| `x-app-key` | 必填。应用密钥 (Client/Partner's Application Key) |
| `x-hotelid` | 必填（Property API）。物业代码，与 URL 的 `{hotelId}` 对应；规范原文：“identify the hotel code where the end user is logged in” |
| `x-externalsystem` | 可选。外部系统代码（接口配置的 External System） |
| `x-originating-application` | 可选。集成应用 ID |
| `x-request-id` | 可选。请求追踪 ID |
| `externalData` | 可选；`true` 表示 payload 需 DVM（值映射） |
| `Accept-Language` | 可选 |
| `x-hubid` | 在规范参数表中存在（用途未展开，未证实）|

响应中通用：`links[]`（HATEOAS：`href, rel, method, operationId...`）、`warnings[]`（`code, shortText, ...`）。

### 5.2 房态相关 REST 端点汇总（A 级，basePath `/hsk/v1` 与 `/fof/v1`）
| 功能 | 方法 + 路径 | operationId | 关键字段 |
|---|---|---|---|
| 批量改 HK 房态 | `PUT /hsk/v1/hotels/{hotelId}/rooms/status` | putRoomRelatedStatus | body: `roomList[{roomId, reservationId}]`, `housekeepingStatus`(Vacant/Occupied), `housekeepingRoomStatus`(Clean/Dirty/Pickup/Inspected/OutOfOrder/OutOfService), `turndownStatus`(Required/NotRequired/Compeleted), `roomPersons{houseKeepingPersons}`；示例 `{"roomList":[{"roomId":"112"},{"roomId":"114"}],"housekeepingStatus":"Vacant","housekeepingRoomStatus":"Clean"}` |
| 看板/概览 | `GET /hsk/v1/hotels/{hotelId}/housekeepingOverview` | getHousekeepingOverview | 见 §3.1 |
| 差异 | `GET /hsk/v1/hotels/{hotelId}/housekeepingDiscrepancies` | getHousekeepingDiscrepancies | 见 §2.5 |
| 设 OOO | `POST /hsk/v1/hotels/{hotelId}/rooms/outOfOrderRooms` | postOutOfOrderRooms | `criteria.roomRangeList{roomIds[], range, roomOutOfOrder{...}}`（数组包裹）|
| 完成 OOO | `PUT /hsk/v1/hotels/{hotelId}/rooms/outOfOrderRooms` | completeOutOfOrderRooms | `criteria.roomRepairByRoomNumber[]` / `roomRangeList` |
| 查 OOO | `GET .../rooms/outOfOrderRooms?startDate=` | getOutOfOrderRooms | ≤90 天 |
| 设/完成/查 OOS | `POST/PUT/GET .../rooms/outOfServiceRooms` | postOutOfServiceRooms / completeOutOfServiceRooms / getOutOfServiceRooms | 同 OOO |
| 房间条件 | `GET/PUT /hsk/v1/hotels/{hotelId}/conditions` | getRoomConditions / setRoomCondition | 见 §3.4 |
| 清洁优先级 | `PUT /hsk/v1/hotels/{hotelId}/rooms/{roomId}/cleaningPriority`；`DELETE .../rooms/cleaningPriority` | setRoomCleaningPriority / putRoomCleaningPriority | |
| 服务请求 DND/MUR | `PUT /hsk/v1/hotels/{hotelId}/serviceRequests` | setGuestHousekeepingServiceRequest | |
| 访客 HK 备注 | `GET/PUT .../reservations/{reservationId}/houseKeepingNotes` | | |
| 任务单 | 见 §3.6 | | |
| 房态统计 | `GET /fof/v1/hotels/{hotelId}/roomStatusStatistics` | getRoomsByRoomStatus | 参数 `frontOfficeStatus` |
| 房间检索 | `GET /fof/v1/hotels/{hotelId}/rooms` | getHotelRooms | 见 §4.1 |
| 排房 | `POST /fof/v1/hotels/{hotelId}/reservations/{reservationId}/roomAssignments` | postRoomAssignment | |
| 入住 | `POST /fof/v1/hotels/{hotelId}/reservations/{reservationId}/checkIns` | postCheckIn | |
| 退房 | `POST /csh/v1/hotels/{hotelId}/reservations/{reservationId}/checkOuts` | | |
| 换房 | `PUT /fof/v1/hotels/{hotelId}/reservations/{reservationId}/rooms/{roomId}/roomMoves` | moveInHouseGuest | |
| 排队 | `GET /fof/v1/hotels/{hotelId}/queuedReservations`、`.../queueReservationsStatistics` | | |
| 房间接口状态 | `GET/PUT /fof/v1/hotels/{hotelId}/interfaces/{interfaceId}/roomStatuses` | | |
| 门锁/房卡 | `/fof/.../reservations/{id}/roomKeys`、`/externalRoomKeys`、`/keyInterfaces` | | |

**OHIP 工作流提示**（B）：合作方系统用 `putRoomRelatedStatus` 更新房态；OOO/OOS 需先在 OPERA Controls 开启 Out of Order / Out of Service；原因码必须来自物业的 OPERA Cloud 配置；`returnStatus` 示例 Dirty/Clean；规范示例里甚至出现 `"returnStatus": "PickUP"`（大小写与枚举 `Pickup` 不一致，说明示例有瑕疵，Demo 应校验枚举）。

### 5.3 Business Events（B 级；payload 全文 未获取）
OHIP Streaming API 订阅的业务事件（官方文档措辞，事件名为大写带空格）：
| 事件 | 触发 | 前置 |
|---|---|---|
| `UPDATE ROOM STATUS` | 房态（HK 状态等）变化 | 订阅该 Streaming Business Event |
| `NEW OUT OF ORDER` / `UPDATE OUT OF ORDER` | OOO 新建/更新（含回服务，推测） | 订阅两者；OOO 控制开启 |
| `NEW OUT OF SERVICE` / `UPDATE OUT OF SERVICE` | OOS 新建/更新 | 同上 |
| `GUEST SERVICE STATUS REQUEST` | DND / MUR 变化 | Guest Service Status 控制开启 |
- 其它可能相关事件（名称 未证实/推测）：入住/退房（Reservation 状态变更类，如 `CHECK IN`/`CHECK OUT` 或 `UPDATE RESERVATION`）、`ROOM MOVE`、Housekeeping 任务单类事件。官方说：最新版 OPERA Cloud 的全部业务事件均可通过 Streaming 消费；完整事件列表与数据元素见 *Business Events Data Elements* 指南（未能抓取）。
- **Payload 形状（推测）**：典型为 `{"moduleName":"HOUSEKEEPING","eventName":"UPDATE ROOM STATUS","publisherId":..., "primaryKey":..., "hotelId":"PROP1","timestamp":..., "detail":[{"oldValue":..,"newValue":..,"elementName":"..."}]}`（oldValue/newValue 差异数组为 OHIP Business Event 的已知风格，但具体字段名 **(未证实/推测)**；GraphQL 订阅 via WebSocket）。
- 传输：**Streaming API** = WebSocket（网关 URL 把 `https` 换成 `wss`，路径推测为 `/subscriptions`；使用 GraphQL 订阅；受 OAuth + 应用密钥保护；需 OPERA 环境启用 Streaming API）；**Polling API (pull)** = 轮询拉取事件缓冲，作为不能保持长连接时的替代（B：Polling API 页面存在）。取舍：Streaming 低延迟、需长连接与重连/去重；Polling 简单可靠、有延迟。

### 5.4 集成模式
| 对接方 | 模式 |
|---|---|
| **第三方客房/清洁 App** | 拉：`housekeepingOverview`、`rooms/outOfOrderRooms`；写：`putRoomRelatedStatus`（Clean/Inspected）；订阅：`UPDATE ROOM STATUS`、`NEW/UPDATE OUT OF ORDER|SERVICE` 同步任务列表；DND/MUR 通过 `GUEST SERVICE STATUS REQUEST`。 |
| **PBX / 电话系统** | 房间分机状态 `putRoomInterfaceStatus`（`roomExtension`, `interfaceRights[]`）；PBX 推 DND/MUR 到 OPERA；房态码（如“房客清洁完毕=Clean”）由 PBX 话机拨号码上报（行业通用，例如 `*SS` 码；具体码值 **(未证实/推测)**）。 |
| **门锁 / 房卡** | `roomKeys` 系列 API；入住事件触发制卡，退房/换房事件触发注销（推测）。 |
| **能耗管理 (BMS/Energy)** | 订阅入住/退房/房态事件：Occupied+Checked-in → 舒适模式；Vacant/Dirty → 节能模式；OOO → 关闭（推测）。 |
| **渠道库存 (Channel)** | OOO 扣减库存 → 触发渠道可用量更新；OOS 不扣库存（因此不推送变化）。库存 API 在 `inv.json`（本次已下载，未展开）。 |
- 建议：Demo 的“同步”以**应用内事件总线 + SSE/WebSocket 推送**模拟 Streaming API，并提供 `poll` 接口模拟 Polling API；事件名沿用上表。

---

## 6. UI 风格笔记 (模仿 OPERA Cloud)

> 本节来自截图描述 + 行业知识；Oracle JET/Redwood 的具体 token (未证实/推测)。

- **整体**：Oracle JET 组件，新版 Redwood 主题（OPERA Cloud 22+ 采用）。顶部深色 Header（深灰/近黑 `#161513` 一类，推测）含：汉堡菜单、业务日期（Business Date）、物业名“代码 - 名称”、用户菜单；下方为菜单栏（OPERA Cloud | Client Relations | Bookings | Front Desk | Inventory | Financials | Channel | Miscellaneous | Reports），悬停展开二级菜单（如 Inventory > Room Management > Housekeeping Board）。
- **“I Want To…”**：屏幕右上/页面内的操作菜单（下拉），收纳上下文动作（如在看板中：Update Room Status、Out of Order、Out of Service、Create Task Sheet 等；具体项 未证实/推测）。
- **布局**：典型“**搜索面板 + 结果表**”：顶部可折叠 Search 面板（基础字段 + “更多筛选 Filters”按钮，字段按 Room / Status / Reservation 分组），底部 `Search` 与 `Clear` 按钮；结果为带复选框的表格，表头可排序，行末垂直省略号（⋮）Actions 菜单；表格上方显示结果计数与状态汇总。
- **抽屉 (Drawer) / 侧滑面板**：编辑类操作（Set Room Status、OOO/OOS 创建、预订详情）常以右侧抽屉或模态对话框出现，底部 `Save`/`Cancel`（`OK`/`Cancel`）。
- **状态色**（来自截图 + 惯例）：Inspected=绿（对勾剪贴板）、Clean=蓝（闪光）、Pickup=橙（推测）、Dirty=红（垃圾桶）、OOO=红/深灰、OOS=灰或紫（推测）；Occupied/Vacant 用文字或实心/空心图标；差异用警告三角（推测）。
- **仪表盘**：页签 (Dashboard page tabs) + 磁贴 (Tiles/Cards) 网格；磁贴含标题、图标行、数字计数；可点击钻取。
- **文案**：按钮标签沿用英文：`Search`, `Clear`, `Update Room Status`, `Prioritize`, `Edit`, `Delete`, `New`, `Save`, `Cancel`；房态 Tooltip 使用“Inspected (IP) / Clean (CL) / Pickup (PU) / Dirty (DI) / Out of Service (OS) / Out of Order (OO)”。
- **可访问性与响应式**：JET 表格键盘可操作；移动端为独立 PWA（滑动操作），Demo 可先做桌面端。

---

## 7. Demo 取舍建议

### 7.1 MVP（建议 Demo 必做）
1. **数据模型**：Room（roomId, type, class, floor, building, section AM/PM）、RoomStatus（hkStatus、foStatus、hkOccupancy、reservationStatus 派生、guestService、turndown、persons、condition、priority）、OutOfOrder/Service 记录（含 reason、dates、returnStatus、remarks）、Reservation（最小集：Reserved/DueIn/InHouse/DueOut/CheckedOut + 房号）、业务日期。
2. **状态机**：Clean/Dirty/Inspected/Pickup/OO/OS（Inspected/Pickup/OOS 用“参数开关”演示 OPERA Controls）；入住（要求 Vacant + Clean/Inspected，否则需 override 或排队）；退房→Dirty；OOO 扣库存，OOS 不扣；OOO/OOS 到期 EOD 自动回库存并置 returnStatus。
3. **Housekeeping Board**：搜索面板（房号范围/楼层/房型/房类/HK/FO/预订状态/服务状态）+ 结果表 + 多选批量 Update Room Status + 顶部各状态计数。
4. **Room Discrepancies**：Sleep/Skip（Person 可选）+ 通过入住/退房或“Update to FO status”解决。
5. **OOO/OOS 屏幕**：新增/编辑/删除/完成。
6. **Dashboard**：Room Status 磁贴、Queue Reservations 磁贴、Room Summary 磁贴（计算口径同 §1.3）。
7. **房态同步**：事件总线 + 事件 `UPDATE ROOM STATUS`、`NEW/UPDATE OUT OF ORDER|SERVICE`、`GUEST SERVICE STATUS REQUEST`，通过 SSE/WebSocket 推送到“模拟客房 App / PBX / 渠道库存”三个订阅者页面，并提供 Polling 接口；REST 端点命名与 `hsk`/`fof` 对齐（`PUT /hsk/v1/hotels/{hotelId}/rooms/status` 等），带 `x-hotelid`/`x-app-key`/`Authorization` 头的简化校验。

### 7.2 Nice-to-have
- Task Sheets 自动生成（credits、分区、Stayovers First、overflow sheet）+ Attendant Console + 移动端 PWA 滑动操作。
- Room Conditions（Available/NotAvailable 影响排房）、Cleaning Priority、Turndown、DND/MUR 夜审清除逻辑。
- Queue Rooms 完整流程 + 短信模拟；Room Move 的 `oldRoomStatus`；Hold 房；Room Maintenance 维修单。
- 夜审 (End of Day) 模拟：推进业务日期、占用房置 Dirty、MUR 清除、OOO/OOS 到期回库存。
- Polling vs Streaming 对比演示；Person Discrepancy；Room Parity 过滤。

### 7.3 明确不做
账务/收银、预订创建全流程、费率/可用性引擎、渠道真实对接、真实 OAuth。

---

## 8. 开放问题 (Open Questions for Product Owner)

1. 是否有真实 OPERA Cloud 环境或培训视频截图，可用于校对 Housekeeping Board 的**确切列名/顺序**和 Tile 配色（本次未能读取用户手册全文）？
2. 仪表盘“橙色”图标到底是 Pickup 还是 Dirty？“Assigned”计数的定义（已排房未入住？）是否与本报告推测一致？
3. 退房后默认 HK 状态是否固定为 Dirty，还是要演示可配置（OPERA 有 Day-use 退房状态参数）？夜审是否要把占用房置 Dirty？
4. Inspected / Pickup / OOS / Person Discrepancy / Guest Service Status / Turndown 这些**参数开关**是否都要在 Demo 中可配置（设置页）？
5. 是否需要多物业 (multi-property) 与 `x-hotelid` 路由？还是单物业 `PROP1`？
6. 同步部分要展示哪些下游：客房 App、PBX、门锁、能耗、渠道库存？是否需要真实 WebSocket + GraphQL 订阅形态，还是仅 SSE？
7. 事件 payload：是否需要严格模拟 OHIP Business Event 结构（本次未能读取 *Business Events Data Elements*，目前为推测）？
8. OOO 的“只能对 Vacant 房设置”、对已分配预订的冲突处理（需要重新排房/警告）是否纳入范围？
9. 语言：UI 全英文（贴近 OPERA）还是中英双语？
10. 用户角色：前台、客房主管、客房员、系统管理员各自的权限范围？

---

## 附：规范原文要点摘录（便于后续建模）

- `housekeepingRoomStatusType`：`Clean | Dirty | Pickup | Inspected | OutOfOrder | OutOfService`
- `frontOfficeRoomStatusType`：`Vacant | Occupied`
- `housekeepingRoomReservationStatusType`：`Arrival | Arrived | DayUse | DueOut | Departed | NotReserved | StayOver`
- `roomDiscrepancyType`：`Sleep | Skip | PersonDiscrepancy`
- `guestHousekeepingServiceRequestType`：`DoNotDisturb | MakeUpRoom | NoStatusSelected | ServiceDeclined`
- `turndownStatusType`：`Required | NotRequired | Compeleted`
- `servicingAttendantStatusType`：`Standby | Break | Working | Completed`
- `roomConditionAssigmentType`：`Available | NotAvailable`
- `roomParityStatus`：`Odd | Even`；`roomAssignmentStatus`：`Assigned | Unassigned`
- `pMS_ResStatusType`（预订状态）：`Reserved | Requested | NoShow | Cancelled | InHouse | CheckedOut | Waitlisted | DueIn | DueOut | Walkin | PendingCheckout`
- 规范版本：OPERA Cloud Housekeeping Service API / Front Desk Operations Service **26.3.0.0**。
