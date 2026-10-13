# OPERA Cloud 房态管理 & OHIP 房态同步 · 学习 Demo

> 一个**学习研究**项目：复刻 Oracle OPERA Cloud PMS 在酒店管理端的**房态管理 (Room Management)** 与通过 **OHIP (Oracle Hospitality Integration Platform)** 的**房态同步**交互。账务 (Billing) 不在范围内。
> 非 Oracle 官方产品，界面与数据均为模拟，仅用于学习。

**在线演示（GitHub Pages）**：<https://liny90626.github.io/Opera-Demo/>
（纯前端形态：PMS 引擎运行在浏览器中，用多个标签页即可观察实时同步。）

---

## 1. 能演示什么

| 模块 | 页面 | 要点 |
|---|---|---|
| 首页仪表盘 | `#/` | 仿 OPERA Cloud 首页：Room Status（Inspected/Clean/Pickup/Dirty × Occupied/Assigned/Vacant）、Queue Reservations、Room Summary（Physical/Inventory/OOO/OOS）、差异、客房员进度、同步健康度；数字可钻取 |
| 房务看板 | Inventory › Housekeeping Board | 多条件搜索、批量 Set Room Status、DND/MUR、Turndown、房间条件、分配客房员、OOO/OOS、房间历史 |
| 楼层房态图 | Inventory › Room Status Grid | 楼层×房间色块，一键改房态 |
| 房态差异 | Inventory › Room Discrepancies | Skip / Sleep / Person 检测与解除 |
| 维修/停用房 | Inventory › Out of Order / Service | OOO 扣库存、OOS 不扣；冲突校验（在住/已排房）；返回状态 |
| 任务单 | Inventory › Task Sheets | 按 credits + 楼层区域自动分房，手工改派 |
| 客房员移动端 | `#/mobile` | 手机框体，客房员把房间置 Clean、报告占用、DND——其他标签页实时联动 |
| 前台 | Front Desk › Arrivals / In House / Queue Rooms | 排房（房型/就绪校验、升级确认）、入住（房未就绪→排队）、退房→脏房、换房、排队就绪通知 |
| **房态同步** | Integration › Sync Monitor | OHIP 业务事件流；5 个模拟外部系统（客房 App、PBX、门锁、能耗 BMS、渠道库存）的镜像、**投递失败注入 → 漂移 (drift) → 重试 / 全量重同步** |
| OHIP API | Integration › API Console | 调用仿 OHIP REST 接口（`/hsk/v1`、`/fof/v1`、`/csh/v1`、OAuth 令牌）、PBX 拨码回写房态、Polling API |
| 夜审 | Miscellaneous › End of Day | 业务日期滚动、占用房置脏、No Show、OOO 到期；物业参数开关；重置演示数据 |
| 演示指南 | `#/guide` | 中文分步演示脚本 |

**推荐 2 分钟体验**：打开在线演示 → 右上角「指南」→ 场景 S1：左边一个标签页开 *Housekeeping Board*，右边开 *Room Attendant Mobile*，在手机里把一间脏房置为 Clean，观察看板/仪表盘/同步监控的实时变化。

---

## 2. 架构

```
┌──────────────── apps/web (React + Vite) ────────────────┐
│ 14 个页面 · OPERA 风格 UI Kit · 中/EN 切换                │
│            │ Backend 接口（两种实现）                     │
│   HttpBackend ──REST + SSE──┐      LocalBackend          │
└─────────────────────────────┼──────(浏览器内引擎 +        │
                              │       localStorage +       │
┌──── apps/server (Express) ──▼─┐     BroadcastChannel)    │
│ POST /api/commands            │           │              │
│ GET  /api/stream  (SSE)       │           │              │
│ OHIP façade /hsk /fof /csh    │           │              │
└──────────────┬────────────────┘           │              │
               └──────────┬─────────────────┘
              ┌───────────▼────────────────────────────┐
              │ packages/core  (纯 TypeScript，前后端共用) │
              │ PmsEngine：命令→校验→状态变更→业务事件    │
              │ selectors：FO 状态/预订状态/差异/Tile 口径 │
              │ sync：订阅者镜像、投递、漂移               │
              │ ohip：仿 OHIP REST 路由与鉴权头校验        │
              └────────────────────────────────────────┘
```

- **同一引擎两种部署**：Node 服务端形态（真正的前后端，SSE 推送），以及 GitHub Pages 纯静态形态（引擎在浏览器内运行，多标签页通过 BroadcastChannel 同步）。
- 两条"同步"链路：①**UI 同步**——每个命令产生 `ChangeSet` 实时推送到所有客户端；②**OHIP 业务事件同步**——事件投递给外部订阅者，订阅者维护各自镜像，演示最终一致性与失败补偿。

---

## 3. 本地运行

需要 Node.js ≥ 20。

```bash
npm ci
npm run dev          # 启动 Node 后端 (3001) + Vite 前端 (5173)，浏览器打开 http://localhost:5173
# 或
npm run dev:local    # 只起前端，引擎跑在浏览器里（与 GitHub Pages 相同形态）
# 或（单端口生产模式）
npm start            # 构建前端并由 Express 在 http://localhost:3001 提供 UI + API
npm test             # 引擎、OHIP façade、服务端 SSE 测试
npm run typecheck
```

也可以用 **GitHub Codespaces** 打开本仓库（已带 `.devcontainer`），会自动构建并在 3001 端口启动完整的 Node 后端形态，可把端口设为 Public 远程访问。

### OHIP façade 调用示例（Node 后端形态）

```bash
TOKEN=$(curl -s -X POST localhost:3001/oauth/v1/tokens -H 'x-app-key: demo' \
  -H 'content-type: application/json' -d '{"grant_type":"client_credentials"}' | jq -r .access_token)

curl -s -X PUT localhost:3001/hsk/v1/hotels/DEMO1/rooms/status \
  -H "Authorization: Bearer $TOKEN" -H 'x-app-key: demo' -H 'x-hotelid: DEMO1' \
  -H 'content-type: application/json' \
  -d '{"roomList":[{"roomId":"305"}],"housekeepingRoomStatus":"Clean"}'

curl -s 'localhost:3001/api/events?sinceSeq=0' | jq '.events[] | {seq, eventName, summary}'
```

---

## 4. 部署（GitHub Pages）

`.github/workflows/pages.yml` 在每次推送时：安装依赖 → 类型检查 → 测试 → `npm run build:pages` → 发布到 `gh-pages` 分支。

**首次需要仓库管理员开启一次 Pages**：GitHub 仓库 → Settings → Pages → *Build and deployment* → Source 选 **Deploy from a branch** → Branch 选 **gh-pages / (root)** → Save。约 1 分钟后即可通过 <https://liny90626.github.io/Opera-Demo/> 访问。

---

## 5. 文档

| 文档 | 内容 |
|---|---|
| [docs/01-research-opera-room-management.md](docs/01-research-opera-room-management.md) | 调研：OPERA Cloud 房态模型、屏幕、OHIP 端点与业务事件（含证据等级） |
| [docs/02-functional-design.md](docs/02-functional-design.md) | 功能设计：领域模型、状态机、21 个命令的业务规则与错误码、事件目录、同步设计、夜审、验收场景 S1–S12 |
| [docs/03-ui-interaction-design.md](docs/03-ui-interaction-design.md) | 界面与交互设计：设计令牌、共享组件、14 个页面线框与交互、两标签同步演示流程 |
| [docs/04-design-review.md](docs/04-design-review.md) | 对抗式评审记录：发现、处置、决议与验收 |

---

## 6. 目录结构

```
packages/core      领域引擎（types / seed / engine / selectors / sync / ohip / apply）+ 单元测试
apps/server        Express：命令 API、SSE、OHIP façade、状态落盘 + 集成测试
apps/web           React 前端（store、backend 适配器、UI Kit、pages/）
docs               调研 / 设计 / 评审文档
```

## 7. 已知简化

- 认证为演示级（固定令牌）；Streaming API 用 SSE / BroadcastChannel 模拟，Polling API 用 `GET /api/events`。
- 未证实的 OHIP 事件名（如 `CHECK IN`、`ROOM MOVE`）为演示自定义，详见文档证据等级。
- 任务单无独立实体与任务生命周期；OOO 不支持编辑（删除后重建）。
- 详见 [docs/02 §12 设计偏差与待确认](docs/02-functional-design.md)。
