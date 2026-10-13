# 04 · 对抗式评审记录 (Adversarial Review Log)

> 评审人：项目负责人（Lead）。评审对象：01 调研报告、02 功能设计、03 交互设计、`packages/core` 引擎与 OHIP façade、`apps/web` 壳层。
> 原则：**文档必须与代码一致**；分歧时要么改代码（行为更贴近 OPERA/更利于演示），要么改文档（代码更合理），并在此留痕。

## 1. 评审范围与方法

| 维度 | 方法 |
|---|---|
| 业务正确性 | 逐条对照 01 调研中的 A 级证据（OHIP OpenAPI 规范 26.3）检查状态枚举、端点路径、字段名 |
| 文档 ↔ 代码一致性 | 02 §6 命令规则表逐条对照 `engine.ts`；02 §8.7 端点表逐条对照 `ohip.ts` |
| 可演示性 | 用 02 §11 场景 S1–S12 作为验收用例，核对种子数据能否支撑 |
| 健壮性 | 失败回滚、多标签并发、版本缺口、非法输入（枚举大小写 `PickUP` 等） |
| 自动化测试 | `packages/core/test/*.test.ts`（引擎 + façade）、`apps/server/test/server.test.ts`（REST + SSE） |

## 2. 发现与处置

| # | 来源 | 发现 | 严重度 | 处置 | 状态 |
|---|---|---|---|---|---|
| R1 | 02 §8.7 | 文档写的鉴权值（`demo-app-key`、字面 `demo-token`）、错误码 `INVALID_HOTEL`、PBX 端点路径 `/interfaces/PBX/roomStatusCodes` 与代码不一致（文档作者编写时 façade 尚未合入） | 高 | **改文档**：§8.7 按 `ohip.ts` 重写（25 个端点、头校验规则、响应格式） | ✅ |
| R2 | 02 §8.7 | 文档提出 `PUT/DELETE queuedReservations/{id}`，代码缺失 | 中 | **改代码**：新增两条路由 | ✅ |
| R3 | 02 §8.7 | 文档提出 `checkIns` 支持 `stopCheckin=true` → 进入排队、`reservation.roomId` → 先排房（贴近 OHIP `postCheckIn`） | 中 | **改代码**：已实现 | ✅ |
| R4 | 02 §8.7 | 升级排房字段：文档 `criteria.updateRoomTypeCharged`，代码 `overrideRoomType` | 低 | **改代码**：两种都接受 | ✅ |
| R5 | 02 §8.7 | 成功响应文档含 `message`/事件列表，代码只有 `warnings` | 低 | **改代码**：响应增加 `status/message/businessEvents` | ✅ |
| R6 | 02 §8.6 | 轮询接口字段 `nextSeq`/200 条 vs 代码 `lastSeq`/100 条/`hasMore` | 低 | **改文档** | ✅ |
| R7 | 02 §8.7 | OOO 经 `rooms/status` 提交应返回明确错误码 | 低 | **改代码**：400 `INVALID_STATUS` | ✅ |
| R8 | 02 D20 | `setHkStatus` 的"全部跳过"判断与排队就绪 warning 混用同一数组，可能误判 | 中 | **改代码**：独立 `skipped` 计数 | ✅ |
| R9 | 02 D12 | `returnStatus=Pickup` 在 Pickup 关闭时未校验；错误码应为 `PARAM` | 中 | **改代码** | ✅ |
| R10 | 02 D18 | 入住不清空 HK 占用观察 → 空房时报过的 "Vacant" 在入住后立刻变成虚假 Skip 差异 | 中 | **改代码**：入住时 `hkOccupancy/hkPersons := null` | ✅ |
| R11 | 02 D21 | `types.ts` 注释过期 | 低 | 改注释 | ✅ |
| R12 | 02 D13 | 客户端只防旧版本，未检测版本缺口（SSE 丢包后状态会悄悄不一致） | 高 | **改代码**：`store.tsx` 收到 `version > local+1` 时自动重拉全量快照；SSE 重连后同样全量重拉 | ✅ |
| R13 | 02 D13 | 多标签本地引擎（GitHub Pages 形态）并发写 | 中 | 采用"每标签一个引擎 + BroadcastChannel 广播 ChangeSet + localStorage 全量快照"；事件序号取 `max(本地, 快照首条)` 防重号；同毫秒并发写同一房间为最后写者生效（演示可接受） | ✅ 记录 |
| R14 | 02 §10 | 文档称 server 仅内存；实际已实现防抖落盘 `apps/server/data/state.json` | 低 | **改文档** | ✅ |
| R15 | 01 §2 / 引擎 | 调研证实 OPERA 默认允许 Clean **或** Inspected 房入住；引擎初版默认只允许 Inspected | 高 | **改代码**：`allowCheckInClean` 默认 `true`，参数页可关闭以演示"必须查房" | ✅ |
| R16 | 01 §2.6 | 夜审：MUR 清除、DND 保留（调研 B 级证据）；引擎初版全部清除 | 中 | **改代码** | ✅ |
| R17 | 01 §5.3 | 业务事件命名：已证实 `UPDATE ROOM STATUS`、`NEW/UPDATE OUT OF ORDER`、`NEW/UPDATE OUT OF SERVICE`、`GUEST SERVICE STATUS REQUEST`；初版自拟名称 | 高 | **改代码**：`events.ts` 采用已证实名称，其余标注 "demo-defined" | ✅ |
| R18 | 03 §2.1 | 文档要求按角色隐藏/只读菜单 | 低 | **不做**：Demo 允许任意角色操作全部功能，角色仅决定 actor 名与默认落地页（减少演示摩擦）；在指南中说明 | ✅ 决议 |
| R19 | 03 §3.13 | 文档建议 exec 返回后乐观合并 + SSE 去重 | 中 | **不采纳**：版本去重会吞掉"更低版本但尚未收到"的远端变更；统一以流（SSE / BroadcastChannel）为唯一写入通道，延迟 < 50ms | ✅ 决议 |
| R20 | 03 §3.2/§3.3 | 键盘网格导航、Shift 范围选择、骨架屏、拖拽改派、打印 | 低 | 列为可选增强，页面实现可跳过 | ✅ 决议 |
| R21 | 02 D2 | OOO 不支持编辑日期 | 低 | 维持：删除后重建；UI 提示 | 待 PO |
| R22 | 02 D1/D14/D3 | 换房旧房状态可配置、OOS 房 override 入住、OOS 可设在住房 | 低 | 维持现状并在文档中说明 | 待 PO |
| R23 | 02 D8 | 夜审只发 1 条 `BUSINESS DATE CHANGE` 而非逐房事件 | 低 | 维持（订阅者整表刷新）；Sync Monitor 中说明 | ✅ 决议 |

## 3. 代码级自检清单

- [x] 每个命令原子：失败时用 `structuredClone` 备份回滚（单测 *failed command rolls back state*）。
- [x] 所有写操作都产生事件；事件投递到订阅者后镜像以"投递时刻真值"更新，重试/乱序天然幂等。
- [x] 失败投递 → 漂移 → 重试修复（单测 *failed delivery creates drift, retry heals it*）。
- [x] OOO 冲突（在住 / 已排房）、OOO 期间改房态被拒、返回状态生效（单测）。
- [x] 入住就绪校验、排队 → 房就绪事件 → 入住（单测）。
- [x] 夜审：待离店阻断、日期滚动、占用房置脏、No Show、整表 reset（单测）。
- [x] façade：头校验、枚举校验（`PickUP` → 400）、OOO 创建/完成、退房、轮询（单测）。
- [x] Server：REST 命令 + SSE 广播 + façade（集成测试）。
- [x] 增量合并 `applyChanges` 与服务器状态一致（单测）。

## 4. 页面实现阶段的评审

页面由 5 个并行子代理实现。各页面完成后由 Lead 进行整体验收与交叉检查，结果记录在 §5。

## 5. 集成验收记录

见 README「验收」一节与提交历史。
