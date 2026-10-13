# 09 · Akubela GRMS 对接使用手册

> 设计见 [07](07-akubela-integration-design.md)，API 摘要见 [06](06-akubela-grms-api-digest.md)，UAT 平台问题见 [08](08-akubela-uat-issues.md)。

## 1. 三种模式

| 模式 | 说明 | 适用 |
|---|---|---|
| **真实 UAT（real）** | 服务端持有 client_id/secret，调用 `https://api.cbcloud.uat.akubela.com`；按映射只同步对应房间 | 与 Akubela 云平台联调 |
| **模拟器（sim）** | 内置 GRMS 模拟器，接口/字段/校验规则与官方文档一致；96 间房全部映射，启动时自动对账 | 演示、离线开发、自动化测试；GitHub Pages 版只支持此模式 |
| **关闭（off）** | 不同步 | — |

模式可在页面 **集成 › Akubela 客控云** 右上角切换（"真实 UAT"仅 Node 后端且配置了凭据时可用）。

## 2. 启用真实对接（Node 后端）

```bash
cp .env.example .env        # .env 已被 git 忽略
# 编辑 .env：
AKUBELA_CLIENT_ID=<client_id>
AKUBELA_CLIENT_SECRET=<client_secret>
AKUBELA_BASE_URL=https://api.cbcloud.uat.akubela.com
AKUBELA_ROOM_MAP=201:101    # OPERA 房号:GRMS 房号；不配置则按相同房号自动匹配
npm run dev                 # 或 npm start / Docker（环境变量同名）
```

- 凭据只存在于服务端环境变量；前端、日志、持久化文件均不含密钥（日志对 PIN、证件号、电话、邮箱脱敏）。
- GRMS 同一 client 只允许一个有效令牌：新令牌会使旧令牌失效（`50107041`）。连接器会自动重新获取并重试；**不要让多个服务实例共用同一套凭据**。
- 一键验收：`npm run akubela:verify`（只读）；`npm run akubela:verify -- --write`（含订单写入全流程，平台修复后用于回归）。

## 3. 同步了什么

| 在 OPERA 中… | GRMS 侧 |
|---|---|
| 给今日/未来到店预订排房 | 创建「待入住」订单（`check_in`），GRMS 显示预计到达（开关：预登记） |
| 入住 | 订单 → `checked_in`（无预登记则先创建）；可选：门锁 PIN、欢迎场景 |
| 退房 / 提前离店 | 订单 → `checked_out`，房间置脏；可选：撤销 PIN、节能场景 |
| 换房 | 旧订单退房 + 旧房置脏，新房新建订单并入住 |
| 取消排房 / No-Show | 删除待入住订单 |
| 房态 Dirty/Pickup ↔ Clean/Inspected | `update_room_state dirty=true/false` |
| OOO/OOS、MUR、开夜床 | GRMS OpenAPI 无对应接口 → 作业标记"SKIPPED（不支持）" |

| 在 GRMS 中…（轮询，默认 20s） | OPERA 侧 |
|---|---|
| 客房被清洁（dirty=false） | 房态 → Clean（30 秒内我方刚写入的脏房不回写，防抖） |
| 房间置脏 | 房态 → Dirty |
| 勿扰（DND） | 在住房的服务状态 DND 置位/清除 |
| 客人自助退房（订单 `checked_out`） | 自动办理退房（开关：接受 GRMS 退房） |
| 告警（SOS/烟感/漏水/低电量） | 页面告警横幅 + 通知 |

所有由 GRMS 回流的变更在 OPERA 事件中 `source = AKUBELA`，不会再次出站（防回声）。

## 4. 页面功能（集成 › Akubela 客控云）

- **连接卡片**：接口地址、Client ID（掩码）、令牌剩余时间、最近轮询、最近错误（错误码 + trace_id，可直接转给 Akubela 排查）；按钮：测试连接 / 立即轮询 / 对账。
- **房间**：OPERA 房间 ↔ GRMS 房间映射（可下拉手工改），PMS 房态/在住/DND 与 GRMS dirty/occupied/dnd 对照，不一致标红。
- **订单**：OPERA 预订 ↔ GRMS 订单关联与状态；GRMS 侧外部订单。
- **作业**：每个出站动作（入住、退房、房态…）的状态、重试次数、错误与 trace_id，可手工重试。失败策略：网络/5xx/令牌问题指数退避重试（2→32s，最多 5 次）；确定性错误（如 `bind body`）立即失败。
- **API 日志**：每次调用的命令、脱敏参数、耗时、结果码。
- **设备与场景**：按房间列出 GRMS 设备与能力（在线状态、传感器读数），可开关、调温、切换模式（离线设备禁用）；场景列表可对房间触发。
- **设置**：各同步开关、酒店时区、入住/退房默认时刻、轮询周期、订单来源、欢迎/节能场景 ID。
- **模拟器**（仅 sim）：模拟 GRMS 侧事件——置净/置脏、DND、客人自助退房、告警、注入 UAT 故障。

房间详情抽屉（任意房态页面点房号）也新增 GRMS 区块：映射、GRMS 状态、订单、设备。

## 5. 演示脚本（模拟器模式，约 3 分钟）

1. 前台 › 预抵：选一位房间已就绪的客人 → 入住 → 集成页「订单」出现 `checked_in`。
2. 集成页「模拟器」：对该订单点"客人自助退房" → OPERA 预订自动退房、房间变脏（事件来源 AKUBELA）。
3. 「模拟器」：将该房置净 → 约 30 秒后 OPERA 房态变 Clean。
4. 房务看板把该房置 Dirty → 「作业」出现 ROOM_STATE 成功，「房间」中 GRMS dirty = 是。
5. 「设备与场景」：开空调、调到 22℃；触发 "Welcome" 场景。
6. 「模拟器」：注入 UAT 故障 → 再入住一位客人 → 「作业」显示 `20950005 api order bind body` 与 trace_id，体会真实环境的问题呈现。

## 6. UAT 实测结论（2026-10-13）

- ✅ 令牌、房间清单、房型、订单列表、设备清单（101 房：HyPanel Elite 10、继电器、红外控制器+美的空调、温湿度、燃气、阀门、开关）在 OPERA 页面实时展示。
- ✅ OPERA 入住触发 `create_order_info` 已真实发往 UAT，平台返回 `20950005`（见 08 文档）——连接器侧行为正确。
- ⛔ 房态读写、订单创建、告警等受平台缺陷阻塞，待 Akubela 修复后执行 `npm run akubela:verify -- --write` 回归，无需改代码。
- ⚠️ 设备控制指令采用文档模型（`control` + `ability_attribute` 中的属性，如空调 `turn_on` + `preset_temperature`），附录《标准设备模型》页面无法访问，真实设备上的控制写入尚未实测（UAT 101 房在线的继电器类型为 Siren，未贸然触发）。
