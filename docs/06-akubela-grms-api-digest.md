# Akubela GRMS 云 API 摘要（WBS-A1）

> 目的：OPERA PMS Demo（本仓库）与 Akubela GRMS（客房管理：房间 / 订单入住 / 设备 / 门禁 / 场景）集成的**可落地 API 摘要**。
> 来源：官网 Hotel Function API V4.1 共 11 个模块（文档站“Hotel Function API”目录下）（Room / Order / User / Device / Scene / Access Card / Alarm / Booking / Notice / Project / Authorization，另含 Appendix 失败返回、Version、Manager/User/General 授权页）+ **2026-10-13 对 UAT 的只读实测**（matrix.log + 本次 get_* 探测）。
> 环境：UAT，项目 `TMG-环境`，Base URL `https://api.cbcloud.uat.akubela.com`，`GET /api/v1.0/invoke/open-ability/method/versions` → `{"version":"4.1"}`。
> 本文**不含任何凭据**；凭据只放环境变量/密钥库，不进仓库。
> 标记约定：**[文档]** 官方文档原文；**[实测]** UAT 实际响应；**[推断]** 由旁证推出，必须在 UAT 受控写测试后才能当事实使用。

---

## 1. 结论速览（设计相关）

1. **统一入口**：全部业务命令 = `POST /api/v1.0/invoke/open-ability/method/hotel-commands`，body `{command, id, param}`；共 **123 个命令**（读 49 / 写 74，见 §3）。
2. **令牌是“单活”的**：同一 client 再次签发令牌，**之前的令牌立即失效**（`50107041 middleware invalid token`，HTTP 401）。适配层必须是单例令牌管理器（带互斥 + 到期前续签 + 401 时重取一次再重试），多实例/多进程要共享令牌。`expires_in` 实测 7200 s，JWT。
3. **房间 101（`rf9f07a99092443c8bf09c2ddc2a51da0`）设备**：根设备 HyPanel Elite 10（在线）+ 5 个子设备：继电器 Relay1、IR Controller（其下挂美的空调 `climate`）、Smart Valve、1 Gang Switch、Gas Sensor。**可控 ability**：`climate`×1、`switch`×3（Relay1、厨房智能阀、卧室1单键开关，见 §4.1）；**只读**：`binary_sensor`（motion、gas）、`sensor`（温度 27.0 / 湿度 55.7）。**没有门锁设备、没有 light 类型 ability**。
4. **UAT 上大量设备是 offline**（AC、IR、阀、开关均 `online:false`，仅 HyPanel/Relay1/Gas 在线）：欢迎/节能控制要先判断 `online`，并容忍失败。
5. **控制命令的 `control` 取值与 attribute 结构在“Standard Device Model”附录里，但该附录官网不可访问**（本人用无头浏览器也取不到，“页面暂时无法访问”）。§4.2 的控制值表 = 文档示例（`turn_on` + `brightness`）+ GRMS 门户前端 bundle 里的服务名（HomeAssistant 风格）**推断**，未经写测试验证。
6. **PMS 状态映射很窄**：GRMS 只有 `dirty / occupied / dnd`（布尔）；`update_room_state` 只能写 `dirty`。**没有** Inspected/Pickup、MUR、OOO/OOS、Turndown、房间条件。OOO 只能借“房间标签 + 场景/设备控制 + 回收授权”模拟（§6）。
7. **订单不可换房**：`update_order_info` 无 `residence_id`；换房 = 旧单 checked_out + 新房新建订单（住客 `guest_id` 会变，门禁授权要重发）。延住/提前离店 = 改 `finish_time`（更新是整体覆盖，需先 get 再带全字段）。
8. **授权记录（门禁）只有 create / delete，没有 update**：延住/早退要“删旧建新”。且 101 当前无锁/门禁设备，**门禁链路在 UAT 无法端到端验证**。
9. **入站同步只能轮询**：`get_order_list` 无任何过滤（只有分页），告警/场景历史/锁事件同样只有分页；Notice 的 `listen_config` 在 Hotel 级只有 `booking`（设施预约），文档未给回调地址协议。
10. **UAT 平台侧故障**（非我方参数问题）：`get_room_info(真实id)`、`update_room_state`、`create_order_info`、`get_staff_list`、`get_public_access_group_list`、`get_alarm_config`、`get_alarm_record_list`、`get_project_info` 全部报 `*bind body/header` 类错误（§7）。**读回 dirty/occupied/dnd 目前做不到**，设计必须有降级路径（§6.3）。
11. **网关校验会拒绝 Required 字段的零值**：空串、`page_index=0`、`page_size=0` 都是 `50104080`（HTTP 400）；`page_size` 上限 500（501 即拒）。`false` 是否被拒（`dirty:false`、`enable_booking:false`）**未知**，是首个写测试要验证的点。

---

## 2. 通用约定与网关行为

### 2.1 鉴权
| 项 | 值 |
|---|---|
| 取令牌 | `POST /api/v1.0/invoke/open-ability/method/oauth2/token`，`Content-Type: application/x-www-form-urlencoded`，`Accept: application/json`，body `grant_type=client_credentials&client_id=…&client_secret=…&scope=hotel`（可选 `expires_in` 秒） |
| 返回 | `{"success":true,"timestamp":…,"result":{"access_token":"<JWT>","refresh_token":"<JWT>","token_type":"Bearer","expires_in":7200}}`（文档示例 `token_type:"bearer"`、`expires_in:3600`，**实测 `Bearer`/7200**） |
| 续签 | `grant_type=refresh_token&client_id&client_secret&refresh_token`（文档；同样会轮换令牌，本次未测以免破坏当前令牌） |
| 用法 | 业务调用 `Authorization: Bearer <access_token>` |
| 无令牌 / 坏令牌 | `50107040 middleware access token null` / `50107041 middleware invalid token`，均 HTTP 401 |
| 单活 | **实测**：连续签发 t1、t2 → t1 调用 `50107041`，t2 正常。 |
| 其它授权页 | General/Manager/User 授权（`scope=user` 的授权码/密码模式）与 Manager 通知（带 `project_id`）属其他角色，本项目不用 |

### 2.2 请求/响应信封
```http
POST /api/v1.0/invoke/open-ability/method/hotel-commands
Content-Type: application/json
Accept: application/json
Authorization: Bearer <access_token>

{"command":"get_room_list","id":"<32位hex，每次新生成>","param":{}}
```
- `param` 必须存在（缺失 → `50104080`）；无参命令传 `{}`。`command` 为空/未知：`50104080` / `50104082 api hotel command not found`。
- 成功：`{"success":true,"timestamp":<ms>,"result":<对象|数组|null|{}>}`。写命令成功多为 `result:{}`（建命令返回新 id）。
- 失败：`{"success":false,"timestamp":…,"result":{"code":<int>,"message":"…","detail":{"span_id":"…","trace_id":"…"}}}`。HTTP 状态：参数绑定类 **400**，业务/下游类 **500**，鉴权 **401**。**务必记录 `trace_id`** 供厂商排查。个别错误的 `detail` 是字符串（如 `"device not supported"`）。
- `id`（命令 ID）：文档要求必填，示例是 32 位 hex；**是否用于幂等未说明，不要依赖**，自行做幂等（先查后写）。

### 2.3 分页
- 所有 `*_list` 的 `page_size`、`page_index` 均 Required：`page_index` 从 **1** 开始；`page_size` 1..**500**（实测 500 通过，501/1000 → `50104080`）。
- 无“总数”字段，翻页直到返回条数 < page_size。
- 例外：`get_room_list`、`get_access_device_list`、`get_groupable_control_light_list`、`get_currency_list`、`get_creating_amenity_list` 不分页。
- `get_device_list` 分页作用于**根设备**，`parallel_sub_device:true` 时小 page_size 会重复返回（见 §4.1）；请用 `page_size≥100` 一次取完一个房间。

### 2.4 Required 字段的零值（高风险）
- 实测：`page_index:0`、`page_size:0`、`device_id:""` 都是 `50104080 api hotel command bind body`（HTTP 400）。符合 Go `binding:"required"` 对零值（`""`/`0`）的拒绝。
- 推论（**待实测**）：`dirty:false`、`enable_booking:false`、`passport:""`、`remark:""`、`email:""` 等 Required 布尔/字符串可能同样被拒，尽管文档示例里就是这样写的。
- 对策：适配层对 Required 字符串提供占位（如 `passport:"N/A"`、`remark:"OPERA:<confirmationNo>"`）；对 `false` 做首次写测试（`update_room_state` / `create_order_info`）确认，若被拒则只能用占位或改 API 用法。

### 2.5 时间与 ID
- 所有时间字符串 = **UTC**，格式 `YYYY-MM-DD HH:mm:ss`（设施 `start_time/finish_time` 为 `HH:mm`，周期型临时密钥示例为 `HH:mm:ss`）。PMS 本地时区→UTC 的转换在适配层做；`get_project_info` 能给时区但 UAT 故障，需在配置里写死酒店时区。
- `create_order_info.start_time` 必须 ≥ 当前时间（`50105580`）：入住时用 `now()`，不要用“当日 15:00 之前的到店时间”。
- ID 全是不透明字符串（首字母似按类型：`r`房间/空间、`d`设备、`e`能力、`o`订单、`g`住客、`t`房型 …，**不可依赖**）。按名称/房号解析：房号 `residence_name`（`get_room_list`）↔ OPERA `room.number`。

### 2.6 响应形态与文档不一致（实测）
| 命令 | 文档 | 实测 |
|---|---|---|
| `get_device_info` | 示例 result 为**数组** | 返回**对象**；多出 `wifi_ssid/wifi_ip/wifi_gateway/wifi_rssi/last_online_time`；子设备嵌套 |
| `get_device_list` | `abilities` 恒有 | 未传 `residence_id+show_ability:true` 时 `abilities` **键整体缺失**；无 `residence_id` 时 `show_ability` 被忽略 |
| `get_scene_info` | 字段 `scene_name/triggers/actions`（result 标为数组） | 对象，另有 `scene_id`、`enable`；**不存在的 id 也返回 success 的空壳** |
| `get_amenity_info / get_booking_info / get_member_info` | — | 不存在的 id 返回 success + 全空字段（别用 success 判存在） |
| `get_member_list / get_amenity_list / get_booking_list` | 数组 | 空集合时 `result:null` |
| `get_listen_config` | `["booking"]` | `{"listen_list":[""]}`（含一个空串元素） |
| `get_room_list` | `floor_id` 有值 | `floor_id:""`（空串），只有 `floor_name` |
| 设备 `ability_attribute` | `[]String` | 开关类为 `null`，传感器为 `["type"]`，climate 为 6 项名单 |
| 设备 `state` | String | 恒为字符串：`"on"/"off"`；传感器是数字字符串 `"27.0"` |

---

## 3. 命令速查表（123 个）

“UAT”列：✅ 只读实测成功；❌ 实测平台报错；🔒 写命令未测（遵守只读约束）；—未测。详细字段见 §8。

| command | 模块 | 读/写 | UAT |
|---|---|---|---|
| `get_room_list` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | ✅ |
| `get_room_info` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | ❌ |
| `update_room_state` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | ❌ |
| `get_room_type_list` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | ✅ |
| `get_room_type_info` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | ✅ |
| `create_room_type_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `update_room_type_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `delete_room_type_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `get_room_tag_list` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | ✅ |
| `get_room_tag_info` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | — |
| `create_room_tag_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `update_room_tag_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `delete_room_tag_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `get_authorization_record_list` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | ✅ |
| `get_authorization_record_info` | 房间 / 房型 / 房间标签 / 授权记录 | 读 | — |
| `create_authorization_record_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `delete_authorization_record_info` | 房间 / 房型 / 房间标签 / 授权记录 | 写 | 🔒 |
| `get_order_list` | 订单（入住单） | 读 | ✅ |
| `get_order_info` | 订单（入住单） | 读 | — |
| `create_order_info` | 订单（入住单） | 写 | ❌ |
| `update_order_info` | 订单（入住单） | 写 | 🔒 |
| `delete_order_info` | 订单（入住单） | 写 | 🔒 |
| `get_guest_list` | 住客 / 会员 / 员工 | 读 | ✅ |
| `get_guest_info` | 住客 / 会员 / 员工 | 读 | — |
| `create_guest_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `update_guest_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `delete_guest_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `get_member_list` | 住客 / 会员 / 员工 | 读 | ✅ |
| `get_member_info` | 住客 / 会员 / 员工 | 读 | — |
| `create_member_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `update_member_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `delete_member_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `get_staff_list` | 住客 / 会员 / 员工 | 读 | ❌ |
| `get_staff_info` | 住客 / 会员 / 员工 | 读 | — |
| `create_staff_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `update_staff_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `delete_staff_info` | 住客 / 会员 / 员工 | 写 | 🔒 |
| `get_device_list` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `get_device_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `control_device` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_control_device` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_control_device_group` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `update_device_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_update_device_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `update_device_ability_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_update_device_ability_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_light_control_group_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `get_groupable_control_light_list` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `create_light_control_group_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `update_light_control_group_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_lock_basic_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ❌ |
| `update_lock_basic_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_lock_temp_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ❌ |
| `create_lock_temp_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `delete_lock_temp_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_delete_lock_temp_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_lock_open_door_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `create_lock_open_door_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `update_lock_open_door_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `delete_lock_open_door_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_delete_lock_open_door_key_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_lock_fingerprint_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `update_lock_fingerprint_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `delete_lock_fingerprint_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_delete_lock_fingerprint_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `turn_on_lock_fingerprint_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `turn_off_lock_fingerprint_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_lock_card_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `update_lock_card_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `delete_lock_card_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `batch_delete_lock_card_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `turn_on_lock_card_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `turn_off_lock_card_config` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_lock_history` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `lock_wakeup` | 设备 / 灯控组 / 门锁 / 门禁设备 | 写 | 🔒 |
| `get_access_device_list` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | ✅ |
| `get_access_device_info` | 设备 / 灯控组 / 门锁 / 门禁设备 | 读 | — |
| `get_scene_list` | 场景（自动化） | 读 | ✅ |
| `get_scene_info` | 场景（自动化） | 读 | — |
| `create_scene_info` | 场景（自动化） | 写 | 🔒 |
| `update_scene_info` | 场景（自动化） | 写 | 🔒 |
| `delete_scene_info` | 场景（自动化） | 写 | 🔒 |
| `manual_trigger_scene` | 场景（自动化） | 写 | 🔒 |
| `enable_auto_scene` | 场景（自动化） | 写 | 🔒 |
| `get_scene_history` | 场景（自动化） | 读 | ✅ |
| `get_access_card_list` | 门禁卡 / 门禁组 | 读 | ✅ |
| `get_access_card_info` | 门禁卡 / 门禁组 | 读 | — |
| `create_access_card_info` | 门禁卡 / 门禁组 | 写 | 🔒 |
| `update_access_card_info` | 门禁卡 / 门禁组 | 写 | 🔒 |
| `delete_access_card_info` | 门禁卡 / 门禁组 | 写 | 🔒 |
| `get_access_group_list` | 门禁卡 / 门禁组 | 读 | ✅ |
| `get_access_group_info` | 门禁卡 / 门禁组 | 读 | — |
| `create_access_group_info` | 门禁卡 / 门禁组 | 写 | 🔒 |
| `update_access_group_info` | 门禁卡 / 门禁组 | 写 | 🔒 |
| `delete_access_group_info` | 门禁卡 / 门禁组 | 写 | 🔒 |
| `get_public_access_group_list` | 门禁卡 / 门禁组 | 读 | ❌ |
| `get_alarm_config` | 告警 | 读 | ❌ |
| `update_alarm_config` | 告警 | 写 | 🔒 |
| `get_alarm_record_list` | 告警 | 读 | ❌ |
| `get_amenity_type_list` | 设施（Amenity）与预约（Booking） | 读 | ✅ |
| `get_amenity_type_info` | 设施（Amenity）与预约（Booking） | 读 | — |
| `create_amenity_type_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `update_amenity_type_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `delete_amenity_type_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `get_amenity_list` | 设施（Amenity）与预约（Booking） | 读 | ✅ |
| `get_amenity_info` | 设施（Amenity）与预约（Booking） | 读 | — |
| `get_creating_amenity_list` | 设施（Amenity）与预约（Booking） | 读 | ✅ |
| `create_amenity_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `update_amenity_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `delete_amenity_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `enable_amenity` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `get_booking_list` | 设施（Amenity）与预约（Booking） | 读 | ✅ |
| `get_booking_info` | 设施（Amenity）与预约（Booking） | 读 | — |
| `create_booking_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `update_booking_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `delete_booking_info` | 设施（Amenity）与预约（Booking） | 写 | 🔒 |
| `get_member_booking_list` | 设施（Amenity）与预约（Booking） | 读 | — |
| `get_listen_config` | 通知订阅（Listen Config） | 读 | ✅ |
| `turn_on_listen_config` | 通知订阅（Listen Config） | 写 | 🔒 |
| `turn_off_listen_config` | 通知订阅（Listen Config） | 写 | 🔒 |
| `get_project_info` | 项目信息 / 币种 | 读 | ❌ |
| `update_project_info` | 项目信息 / 币种 | 写 | 🔒 |
| `get_currency_list` | 项目信息 / 币种 | 读 | ✅ |

---

## 4. 设备与控制模型

### 4.1 房间 101 的设备清单与能力（实测，2026-10-13）

查询方法：`get_device_list {page_size:100, page_index:1, residence_id:"rf9f…", show_ability:true, parallel_sub_device:false}` → 1 个根设备，其余在 `sub_devices`；`parallel_sub_device:true` → 7 条平铺（用 `parent_device_id` 还原层级）。

| 层级 | 设备 (device_id) | product / device_type | 在线 | 空间 (space_id) | ability_id | ability_name | **ability_type** | ability_attribute | state | attribute |
|---|---|---|---|---|---|---|---|---|---|---|
| 根 | HyPanel Elite 10 `d3253442002fe4a14a505a3300b420ef9` | HyPanel Elite 10 / `PH59` | **在线** | 无（空） | `eb6915b41f39b4e53ba017b6b6e24ba21` | `motion` | `binary_sensor` | `["type"]` | `off` | `{"type":"motion"}` |
| 子 | 继电器 `de72c138bbb004b8b9ec8e08ce6bd2a84` | Relay1 / `Siren` | **在线** | 无 | `e15f1f56aebf64943b25fb7f2f0344e97` | `relay1` | `switch` | `null` | `off` | `{}` |
| 子 | IR Controller `d8a830cef89854e1895f09014d0039c82` | IR Controller / IR Controller | 离线 | 客厅 `r2e4c0cebdb3e4786a4aac4fcae16bbfb` | `e42a147b18bb041d280e91d82b4e7d847` | `temperature` | `sensor` | `["type"]` | `"27.0"` | `{"type":"temperature"}` |
| 子 | （同上） | | | | `e5e693102360c475fa167dae70dc80462` | `humidity` | `sensor` | `["type"]` | `"55.7"` | `{"type":"humidity"}` |
| 孙 | 美的空调 `d1faca75ade494c15912605988aa3fcce`（IR Controller 的子设备） | AC Remote / AC Remote | 离线 | 客厅 | `e05730998bece452889460792ea2488cf` | `climate` | **`climate`** | `["preset_temperature","hvac_mode","support_hvac_mode","fan_mode","support_fan_mode","swing_mode"]` | `off` | 见下 |
| 子 | 智能阀 `d7130866232ee486dbee366d9deeddd74` | Smart Valve | 离线 | 厨房 `r04d872a217d14b18b8c8d3df3e91c114` | `ebe3901ce6e594210a402fc771ddf1aed` | `ON/OFF` | `switch` | `null` | `on` | `{}` |
| 子 | 1 Gang Switch `d557fa7c0e570477e82b77f8001273a52` | 1 Gang Switch | 离线 | 卧室1 `ra76736394e284f16a8c521d648723c03` | `ef39b3284effd4feca3ce7c7a2a0978d0` | `ON/OFF`（`get_groupable_control_light_list` 里叫 `Switch1`） | `switch` | `null` | `off` | `{}` |
| 子 | Gas Sensor `daf988211cd704e7b93bfd9e7463a90f4` | Gas Sensor | **在线** | 厨房 | `e4329f2506f524e3eb8274bd3792d7311` | `Gas` | `binary_sensor` | `["type"]` | `off` | `{"type":"gas"}` |

空调 `climate` 的 `attribute`（实测）：
```json
{"hvac_mode":"cool","preset_temperature":24,"fan_mode":"auto","swing_mode":"auto",
 "support_hvac_mode":["cool","heat","auto","fan_only","dry"],
 "support_fan_mode":["auto","low","medium","high"],
 "support_swing_mode":["auto","fix_1"]}
```
注意 `support_swing_mode` 在 attribute 里有，但 `ability_attribute` 清单里只列了 `swing_mode`；`state` 只表示开关（off/on），模式/设定温度在 attribute。

其它事实：
- 层级：HyPanel →（Relay1 / IR Controller →（美的空调）/ Smart Valve / 1 Gang Switch / Gas Sensor）。`get_device_list` 嵌套模式只给 1 个根；`sub_device_type:["Smart Valve"]` 匹配的是子设备的 **device_type 字符串**（`["climate"]` 返回空）。
- 设备 `space` = 房内分区（厨房/客厅/卧室1），是 `batch_control_device_group.spaces[].space_id` 的来源；HyPanel 与继电器 space 为空。
- 灯：**没有 `ability_type:"light"` 的 ability**；卧室1的 1 Gang Switch 是 `switch`，但被 `get_groupable_control_light_list` 当作可编组灯。`light_control_group`（低/中/高亮度编组）为空。
- 设备 ID / ability ID 是环境专属，**不要硬编码**。运行时：用 `ability_type + attribute.type`（如 `climate`、`switch`、`binary_sensor/motion`）发现，并按房缓存（设备变更时刷新）。
- 其它房间/楼层：只有 b1 / 1 / 101 一间；`room_tag`、`access device`、`scene`、`authorization record`、`access card/group`、`guest`、`order`、`amenity`、`booking`、`member` 全为空。

### 4.2 Control Device 模型

**命令**（[文档]）：
```json
{"command":"control_device","id":"…","param":{"device_id":"d…","ability_id":"e…","control":"turn_on","attribute":{"brightness":70}}}
```
- `device_id`、`ability_id`、`control`：Required；`attribute`：可选对象（随 control 变化）。成功 `result:{}`（**异步下发，不返回设备最终状态**；之后用 `get_device_info` 读回 state/attribute 验证）。
- `batch_control_device`：`{"devices":[{device_id,ability_id,control,attribute?},…]}`。
- `batch_control_device_group`：`{"residence_id","spaces":[{"space_id"}],"devices":[{"ability_type","control"}]}`——按“房间+空间+能力类型”整组控制（无 attribute）。
- 同一 ability 的**可用 control** 官方在 Appendix “Standard Device Model” 中，**该页不可访问**。下表依据：文档示例（`turn_on`、`brightness`、`light`）、GRMS 门户前端 JS 的服务名（`turn_on/turn_off/open_cover/close_cover/lock/unlock/set_hvac_mode/set_fan_mode/set_preset_mode/set_swing_mode/set_temperature/update_auto_adjust_type`，字段 `hvac_mode/fan_mode/preset_mode/swing_mode/temperature`）与实测 attribute。**全部 [推断]**。

| ability_type | 读（实测）state / attribute | control 取值 | control 的 attribute 参数 | 备注 |
|---|---|---|---|---|
| `switch`（继电器/阀/开关） | `on`/`off`；attribute `{}` | `turn_on` / `turn_off` | 无 | 实测可读；101 共 3 个 |
| `light` | `on`/`off`；`ability_attribute:["brightness"]`，attribute `{"brightness":70}`（[文档]示例） | `turn_on`（可带亮度）/ `turn_off` | `{"brightness":0..100}`（[文档]示例 70；范围未知） | 101 **无** light ability；若换房有灯则按此 |
| `climate` | state `off`/`on`；attribute 如上 | `turn_on` / `turn_off` / `set_hvac_mode` / `set_fan_mode` / `set_temperature` / `set_preset_mode` / `set_swing_mode`（[推断]，门户同名） | `{"hvac_mode":"cool"}`、`{"fan_mode":"auto"}`、`{"temperature":24}`、`{"preset_mode":…}`、`{"swing_mode":"auto"}` | **读回键是 `preset_temperature`，写入键疑为 `temperature`**；门户 UI 设定范围 5–35 °C；取值必须落在该设备 `support_*_mode` 内（本机 hvac: cool/heat/auto/fan_only/dry；fan: auto/low/medium/high；swing: auto/fix_1） |
| `cover` | — | `open_cover` / `close_cover` | 无 | 101 无 |
| `lock` | — | `lock` / `unlock`（门户场景动作） | 无 | 101 无；开门应走 PIN/授权，不建议远程 unlock |
| `fan`、`music` | — | `turn_on` / `turn_off` | 无 | 101 无 |
| `sensor` | `"27.0"`、`"55.7"`（数字字符串）；attribute `{"type":"temperature"|"humidity"}` | 只读 | — | 来源 IR Controller（离线时值为最后上报） |
| `binary_sensor` | `on`/`off`；attribute `{"type":"motion"|"gas"}`（其它 type 如 smoke/co/moisture/door 未见） | 只读 | — | HyPanel `motion` 可用作有人/无人信号 |

门户里 climate 的 hvac_mode 全集（枚举，真实可用值取决于 `support_hvac_mode`）：`off heat cool auto floor_heat fan_only dry manual program auxiliary_heat heat_and_auxiliary_heat holiday temp_manual humidity fresh_air exhaust`；fan_mode 全集：`off auto very_low low medium high top auto_medium lower higher 1..10`。

控制的前置检查与失败处理：
1. 先 `get_device_info`（或列表）看 `online`，离线设备跳过并记告警（UAT 里 AC/IR/阀/开关都是离线，实际写入多半失败，错误码未知）。
2. 控制后 2–5 s 读回 `state/attribute` 核对；失败按设备重试 ≤2 次，仍失败记入“待补偿”队列，不阻塞 PMS 流程。
3. 一次入住/退房涉及多设备时用 `batch_control_device`（一次请求），单个 ability 失败是否部分成功未知，读回核对。

### 4.3 灯控组 / 设备改名 / 锁配置 命令（简述）
- 灯控组：`get_groupable_control_light_list(residence_id)` → 可编组 ability；`create/update_light_control_group_info` 创建**虚拟灯设备**（低/中/高亮度三档，每档 `[{device_id,ability_id}]`），返回新 `device_id`。
- 改名/换空间：`update_device_info`（device_id、space_id、device_name 全必填），`update_device_ability_info`（改 ability_name）及批量版。
- 门锁（`device_type` 含锁的设备才有效；对 HyPanel 返回 `50100303 device not supported`）：基础配置、临时密钥、开门密码、指纹、卡片、历史、唤醒。见 §5.4。

---

## 5. 授权 / 住客 / 场景 / 告警 / 门锁钥匙 模型

### 5.1 Authorization Record（房客开门授权）
命令都在 Room Management 模块。
| 字段 | 说明 |
|---|---|
| `access_type` | `password`（PIN）/ `rf_card`（RF 卡）/ `qr_code`（二维码，平台生成 `qr_code_url`） |
| `pin_code` | access_type=password 时的 PIN，文档 Required=No（但按类型必填）；创建响应**不回传 PIN**，只回 `record_id/authorization_number/qr_code_url`；如需平台生成的 PIN，创建后用 `get_authorization_record_info` 读 `pin_code` |
| `rf_card_number` | access_type=rf_card 时的卡号 |
| `guest_id` | 必须是已存在住客（先有订单/住客） |
| `residence_id` | 授权的房间 |
| `start_time` / `finish_time` | 有效窗口，UTC `YYYY-MM-DD HH:mm:ss`，均 Required |
| 读回（list/info） | `record_id, authorization_number, access_type, guest_id/name, email, phone, residence_id/no, start_time, finish_time, authorization_status, updated_time`（info 另有 `pin_code, rf_card_number, qr_code_url`） |
| `authorization_status` | 文档示例只见 `expired`；其它取值（预期 active/pending 等）**未公开** |
| 能力缺口 | 只有 get/create/delete，**无 update**；列表**无按房/住客/订单过滤**，只能翻页后客户端过滤 |
| 实测 | `get_authorization_record_list` → `[]`；不存在 id 的 info → `50105582 open ability data null` |

最小创建：
```json
{"command":"create_authorization_record_info","param":{"access_type":"password","pin_code":"123456","rf_card_number":"","guest_id":"g…","residence_id":"rf9f…","start_time":"2026-10-13 07:00:00","finish_time":"2026-10-14 04:00:00"}}
```
（`rf_card_number:""` 是文档示例写法；因 §2.4 风险，password 类型下是否要省略该键待测。）

### 5.2 Guest 模型
- 字段：`guest_id, guest_name, email, phone, id_card, passport`。
- 两种创建：①`create_order_info` 内嵌 `guest{guest_name,email,phone,id_card,passport}`（5 个全 Required），响应回 `guest_id`；②`create_guest_info{…同 5 字段, order_id}` 给**已有订单追加同住人**，响应 `guest_id`。
- 订单读回 `guests[]` 带同样 6 字段。`update_guest_info` 需 `guest_id` + 5 字段；`delete_guest_info{guest_id}`。
- 住客属于订单，换房新建订单会产生新的 `guest_id`；无“把已有住客挂到新订单”的命令。
- Member（会员，用于设施预约）与 Staff（员工）是另外的实体，字段 `member_name/email/phone`、`staff_name/email/phone`；`get_staff_list` 在 UAT 故障。

### 5.3 Order 模型
| 字段 | 说明 |
|---|---|
| `order_id / order_number` | 平台 ID / 20 位数字订单号（`yyyyMMddHHmmss`+6 位） |
| `residence_id / residence_no` | 房间 |
| `room_type_id / room_type_name` | 房型（只读） |
| `start_time / finish_time` | 入住/离店，UTC；create 时 `start_time ≥ now` |
| `order_state` | `check_in` / `checked_in` / `checked_out`（文档只列名字。**[推断]**：`check_in`=待入住（已建单未入住），`checked_in`=在住，`checked_out`=已退房；文档列表示例就是 `check_in`。create 后实际初始状态需读回确认） |
| `source` | 自由文本来源（示例 `SaaS`）→ PMS 集成固定 `OPERA` |
| `remark` | 自由文本 → 存 `OPERA:<confirmationNo>`/reservationId 作外部关联键（订单**无外部 ID 字段**） |
| `enable_booking` | 是否允许该订单的住客预约设施 |
| 读写差异 | `get_order_list` 不含 source/remark/enable_booking；`update_order_info` 为整体覆盖（6 字段全 Required，不含 residence/guest） |

### 5.4 Scene（场景）与触发模型
```json
{"command":"create_scene_info","param":{"scene_name":"OPERA_WELCOME",
  "triggers":[{"trigger_config":"hotel","trigger_type":"check_in","room_tag_id":""}],
  "actions":[{"action_config":"device","ability_type":"light","action_type":"turn_on","attribute":{}}]}}
```
- **[文档]**：triggers[] `{trigger_config, trigger_type, room_tag_id(可选)}`；actions[] `{action_config, ability_type, action_type, attribute(可选)}`。仅有的示例取值：`trigger_config:"hotel"`+`trigger_type:"check_in"`，`action_config:"device"`+`ability_type:"light"`+`action_type:"turn_on"`。取值表在附录 “Scene Trigger Config / Scene Action Config”，**不可访问**。
- **[推断]**（GRMS 门户 UI 的“自动化”）：触发=房态变化 `checked_in` / `checked_out`；或房间标签 `tag_add` / `tag_remove`（此时用 `room_tag_id`）。动作按设备类型：开关类 `turn_on/turn_off`、`open_cover/close_cover`、`lock/unlock`、climate 的 `set_hvac_mode / set_fan_mode / set_temperature(5–35°C)`、`update_auto_adjust_type`（门户的“空调自动调节”）。`attribute` 对应设备 attribute（见 §4.2）。
- `manual_trigger_scene{scene_id, residences:[{residence_id}]}`：对指定房间执行场景（不依赖触发器）。`enable_auto_scene{scene_id, enable_auto}`：开关自动触发。
- `get_scene_history` 每条：`scene_record_id, scene_id, scene_name, trigger_scene(是否成功), residence_id, detail{trigger_config, trigger_type, room_tag_id, manual, manual_by}`；可用来核验场景是否真的触发/成功。
- `get_scene_list` 每条 `{scene_id, scene_name, enable_auto}`；`get_scene_info` 以 `scene_id` 取详情（不存在返回空壳 success）。

### 5.5 Alarm 模型
- `get_alarm_config / update_alarm_config`：7 类告警各有 `{record, web_popup}`：`low_power, sos_alarm, smoke_alarm, co_alarm, gas_alarm, moist_alarm, door_open_alarm`；`door_open_alarm` 另有 `only_check_out`（仅退房后触发）与 `duration`（`now|30min|1h|2h|6h|12h|24h|48h`）。
- `get_alarm_record_list` 每条：`alarm_time(UTC), alarm_type(上述 7 值), residence_id`——**无记录 ID、无 since 过滤、无已读/关闭状态**；入站需自行以 `(alarm_time, alarm_type, residence_id)` 作去重键，并持久化水位。
- 101 上 Gas Sensor 对应 `gas_alarm`。UAT 两个命令均故障（§7）。
- Manager 级通知可订阅 `alarm`/`maintenance`/`booking`（需 `project_id`，属 Manager 授权，不是本项目的 hotel scope）。

### 5.6 Lock 钥匙模型（需绑定了门锁的房间；101 暂无）
| 命令组 | 记录字段 | 要点 |
|---|---|---|
| 临时密钥 `*_lock_temp_key_config` | `key_id, key_name, temp_key(PIN明文), repeat_mode(never|weekly), available_days[](Monday..Sunday), start_time, finish_time` | `never`：完整 UTC 日期时间窗口；`weekly`：示例是 `HH:mm:ss` 时间段 + 星期集合。可 create / delete / batch_delete，**无 update** |
| 开门密码 `*_lock_open_door_key_config` | `key_id, key_name, open_door_key` | 常驻 PIN，无有效期；create / update(仅改名) / delete / batch_delete |
| 指纹 `*_lock_fingerprint_config` | `key_id, key_name` | 指纹由门锁现场录入；API 只能改名/删除/整体开关（`turn_on/off_lock_fingerprint_config`） |
| 卡片 `*_lock_card_config` | `key_id, key_name` | 同上，门锁本地录卡；整体开关 `turn_on/off_lock_card_config` |
| 基础配置 `get/update_lock_basic_config` | `language, volume(high|medium|low|mute), dwell_alarm, dwell_time(15|20|25), monitoring_scope(large|small), double_verification, wifi_*, lock_version, rtsp_url, support_audio_intercom, ciphertext` | 只读字段 wifi_*/rtsp_url/ciphertext |
| 事件 `get_lock_history` | `lock_record_id, lock_record_type(unlock|alarm|doorbell|capture), capture_picture_url, lock_time, note` | 可按类型过滤；入站“开门事件”来源 |
| `lock_wakeup` | `wakeup_mode: sip(默认)|bluetooth` | 动作类，唤醒门锁 |

对比：Authorization Record 是**平台级**住客授权（挂 guest + residence，有生命周期状态）；Lock Temp Key 是**设备级**密钥（挂 device_id）。PMS 发房客 PIN **首选 Authorization Record**（和订单/住客一致、能列出状态），无法使用时退到 Lock Temp Key。

### 5.7 Access Card / Group（门禁卡、门禁组）
- `access_card`：`access_card_name, phone, rf_card_number, access_group_id, start_time, finish_time`（员工/长期卡，非房客卡）；`access_group`：`access_group_name + residences[] + public_access_groups[]`（可进入的房间 + 公共区域组）；`public_access_group` 只读（`system|customized`，`repeat_mode never|daily|weekly`）。
- 房客进公共区域（电梯/大堂门）= 给房客卡所在的门禁组加公共组，需 UAT 有门禁硬件后再设计；当前 `get_access_device_list`/card/group 全空。

### 5.8 设施预约（Amenity/Booking）、Notice、Project（简述）
- Amenity：`amenity_type`（is_public）→`amenity`（健身房等，绑定设备 `mac`，营业时间 `HH:mm`、可用星期、时长/提前量/并发/最多密码数、是否需审批、是否允许住客预约、`fee_type time|people|time and people`、`fee`）。Booking：`state pending|rejected|canceled|success`，成功后产出 `pin_code/qr_code_url`；`update_booking_info` 只能把 state 置 `rejected|success`。**与 OPERA 房态无关**，PMS 集成可忽略（设施预约属 `enable_booking` 订单开关的下游）。
- Notice：`get/turn_on/turn_off_listen_config`，Hotel 级仅 `booking`。
- Project：`get_project_info`（项目信息 + 今日房态/设备统计：`to_stay, checked_out, dirty, vacant_dirty, occupied_dirty, vacant_clean, occupied_clean, dnd, vacant_today, checked_in_today, number_of_staying_today, occupancy_rate_today`；`device{total,online,offline,low_power}`）——是**一次调用拿全酒店 HK/占用汇总**的好命令，但 UAT 故障；`update_project_info{currency}`；`get_currency_list`（格式 `USD:US Dollar`；UAT 返回的是纯名称 `{"currency":"Rand"}`，**与文档格式不一致**）。

---

## 6. PMS 集成映射建议

### 6.0 实体与约定
| OPERA Demo | GRMS | 说明 |
|---|---|---|
| `room.number`（305/101） | `residence_id`（按 `get_room_list.residence_name` 匹配，启动时建缓存） | 房号不一致需配置映射表 |
| Reservation `id`/`confirmationNo` | `order_id` | 订单无外部 ID：`source:"OPERA"`，`remark:"OPERA:<reservationId>"`；适配层另存 reservationId↔order_id 映射表 |
| 住客 | `guest_id`（随单创建） | 换房/新单会换 guest_id |
| BMS 订阅者投影 Comfort/Eco/Off | 设备控制（§4.2）或场景 | 见 6.2 |
| 门锁订阅者 `Key #…`/`No Active Key` | Authorization Record | 见 6.1 |

通用原则：适配层是**异步出站 + 轮询入站**；所有 GRMS 调用幂等（先查后写）、记 trace_id、失败进重试队列，不阻塞 PMS 命令（与 Demo 现有 Delivery/Retry/Resync 模型一致，镜像键=房号，值=期望的 GRMS 状态）。

### 6.1 OPERA 事件 → GRMS 命令

| OPERA 事件 | GRMS 命令序列 | 备注 |
|---|---|---|
| **CHECK IN** | ①`create_order_info{residence_id, start_time=now(UTC), finish_time=离店日+退房时刻(UTC), source:"OPERA", remark:"OPERA:<id>", enable_booking:false, guest{…}}` → 取 `order_id,guest_id` ②`get_order_info` 读 `order_state`；若不是 `checked_in` 则 `update_order_info{…全字段, order_state:"checked_in"}` ③门禁：`create_authorization_record_info{access_type:"password"|"rf_card", guest_id, residence_id, start_time=now, finish_time=离店时刻+宽限}` ④欢迎：`manual_trigger_scene{scene_id(OPERA_WELCOME), residences:[{residence_id}]}`，或直接 `batch_control_device` | 订单建好后房态 `occupied` 应变 true（读回验证）。②的状态语义待实测。PMS 仍负责 ROOM_NOT_READY 等前置校验 |
| **CHECK OUT** | ①`update_order_info{order_id, start_time(原值), finish_time=now, order_state:"checked_out", source, remark, enable_booking}` ②`update_room_state{residence_id, dirty:true}`（PMS 退房强制置 Dirty；GRMS 是否自动置脏未知，显式写最稳）③回收门禁：`delete_authorization_record_info`（列表翻页→按 `guest_id`/`residence_id` 过滤；`finish_time` 早于当前的已 expired 可不删）④节能：`manual_trigger_scene(OPERA_ECO)` 或 `batch_control_device_group` | |
| **ROOM MOVE** | 旧房：等同 CHECK OUT 流程（订单 checked_out、旧房 dirty、回收授权、节能）；新房：等同 CHECK IN（新建订单、新 guest_id、重发授权、欢迎） | `update_order_info` 无 residence_id，只能“退+入”。两步之间有短暂无订单窗口，建议先建新单再退旧单 |
| **ASSIGN ROOM / UNASSIGN**（可选） | 只在需要“到店前发码”时：`create_order_info{start_time=将来时刻}`，Unassign=`delete_order_info` | `start_time≥now` 允许未来；默认不预建单，减少漂移 |
| **早退 / 延住**（`departure` 变化） | `get_order_info` → `update_order_info{finish_time=新离店(UTC), 其余原值}`；授权记录无 update：`delete_authorization_record_info`+`create_authorization_record_info`（新 `finish_time`）。早退当日离店等同 CHECK OUT | 延住前先确认房未被后续订单占用（GRMS 不做冲突校验的保证未知，PMS 保证） |
| **UPDATE ROOM STATUS**（HK Clean/Dirty/Pickup/Inspected） | `update_room_state{residence_id, dirty}`；映射 Dirty、Pickup→`true`；Clean、Inspected→`false` | 二值，丢失 Pickup/Inspected 区分（以 PMS 为主，GRMS 仅镜像）；首次需实测 `dirty:false` 是否被网关拒（§2.4）；UAT 现为 `20950001` |
| **GUEST SERVICE STATUS（DND/MUR）** | **出站无命令**。DND 只能入站：`get_room_info.dnd`/`get_project_info.room.dnd`→ PMS `setServiceStatus DoNotDisturb`（PMS 规则：仅在住房可置 DND） | MUR GRMS 无对应；Turndown/Condition 同样无 |
| **NEW/UPDATE OUT OF ORDER/SERVICE（维修停用）** | GRMS 无 OOO。建议：①预建房间标签 `OOO`（`create_room_tag_info{room_tag_name, residences}`；加/减房 = `update_room_tag_info` 整体覆盖 residences，需读改写并串行化）②GRMS 场景以“标签加入/移除”为触发（[推断]），动作=关灯/关空调；或适配层直接 `batch_control_device_group` 关闭③回收该房全部授权记录 | OOS（不扣库存）可只做标签不关设备。`get_room_info` 一次只显示一个 `room_tag_*`，标签叠加行为未知 |
| **门锁 PIN / 卡** | `create_authorization_record_info`（password：PMS 生成 PIN；rf_card：写卡号）；读回 `get_authorization_record_info.pin_code`；退房 `delete_…`；备选 `create_lock_temp_key_config{device_id=锁, key_name, temp_key, repeat_mode:"never", start_time, finish_time}` | 101 无锁，UAT 暂无法验证；PIN 位数/规则由锁决定（示例 6–8 位） |
| **欢迎场景（Welcome）** | GRMS 管理员预建场景 `OPERA_WELCOME`（动作：卧室灯开、空调 `turn_on`+`set_hvac_mode cool/heat`+`set_temperature 24`，按 §4.2）；PMS 在入住后 `manual_trigger_scene`，用 `get_scene_history` 核验 `trigger_scene:true` | 场景 ID 运行时按名称查 `get_scene_list`；不要把 ID 写进代码。也可只设 `trigger_type:check_in` 让平台自动触发（避免重复触发则不要两者并用，或接受幂等重复） |
| **节能（Energy Saving）** | 映射 Demo 的 SUB-BMS 投影：`Comfort`（有客）= 空调 `turn_on`+`set_temperature` 舒适值；`Eco`（空房）= `set_temperature` 节能值或 `turn_off`、关灯；`Off`（OOO/OOS）= 全 `turn_off`。实现：`OPERA_ECO` 场景 或 `batch_control_device`（按发现到的 ability_id）或 `batch_control_device_group`（仅开关类，按 `ability_type`+`space_id`） | 101 可控对象：美的空调(climate)、卧室1开关、继电器、厨房阀（燃气阀建议**仅在人工确认的安全策略下**才动，不纳入默认节能）。空房的“无人”可用 HyPanel `motion` 辅助（需轮询） |

### 6.2 欢迎/节能控制建议（101 实例）
- **欢迎（入住）**：`climate`：`turn_on` → `set_hvac_mode{hvac_mode:"cool"}`（按季节/`support_hvac_mode`）→ `set_temperature{temperature:24}`（读回 `preset_temperature:24` 是默认）→ `set_fan_mode{auto}`；卧室1 `switch`：`turn_on`；不动 Relay1/Smart Valve。
- **节能（退房/空房/OOO）**：`climate turn_off`；卧室1 `switch turn_off`；其余保持。Eco 可选 `set_temperature` 26–28。
- 全部 [推断]，首个受控写测试建议：对在线的 Relay1（`de72…`/`e15f…`）做 `turn_on → get_device_info → turn_off`，确认 control 名、异步时延、读回；再对离线空调试 `turn_off` 记录错误码。
- 适配层建一个“房间能力缓存”：`residence_id → [{device_id, ability_id, ability_type, attribute.type, online}]`，每天+设备变更时重建；控制时按 `ability_type` 选目标，缺失则跳过而不是报错。

### 6.3 入站同步（GRMS → PMS）：只能轮询
| 数据 | 命令 | 频率/去重 | 用途 |
|---|---|---|---|
| 订单状态/离店时间变化 | `get_order_list{page_size:500,page_index:n}` 翻页全量 | 30–60 s；按 `order_id+order_state+finish_time` 指纹 diff | 发现 GRMS 侧自助入住/退房、延住；映射为 PMS `CHECK IN/OUT` 建议或差异告警（以 PMS 为准，不自动改 PMS） |
| 房间 脏/占用/DND | `get_room_info`（逐房）；全店汇总 `get_project_info.room`（脏/空脏/住脏/dnd/今日入住） | 60 s；汇总命令作预检，数字变化再逐房 | HK 回写、DND→PMS `GUEST SERVICE STATUS REQUEST`、占用 vs PMS FO 状态差异（Skip/Sleep） |
| 告警 | `get_alarm_record_list` | 15–30 s；水位=最大 `alarm_time`，键=(time,type,residence) | 生成工单/PMS 告警（烟、CO、燃气、SOS、门未关、低电量） |
| 开门事件 | `get_lock_history{device_id, lock_record_type:"unlock"}` | 30 s | 审计/PMS 房间活动（需要有锁） |
| 场景执行结果 | `get_scene_history` | 按需 | 核验欢迎/节能是否成功 |
| 传感器/在线 | `get_device_list{residence_id, show_ability:true, page_size:100}` | 60 s | `motion`、温湿度、`online`、AC state；离线告警 |
| 设施预约 | Notice `booking` | — | 与房态无关，忽略 |

降级（UAT 现状：`get_room_info`/`get_project_info`/告警均故障）：入站只用 `get_order_list` + `get_device_list`；脏/占用以 PMS 为准、出站单向，等平台修复后再开 HK 回写。文档里**没有 webhook 注册接口**，如需推送须向厂商确认。

### 6.4 失败与对账
1. 出站队列：每个 (房间, 目标状态) 一条，最新覆盖旧值（状态型同步，天然幂等，沿用 Demo `projection`）。
2. 错误分类：`401/50107041`→重取令牌重试一次；`50104080`（HTTP 400）→ 我方参数 bug，不重试，报警；5xx/超时/设备类错误→指数退避重试，≤5 次后进入人工 Retry。
3. Resync：全量=`get_order_list` + 逐房 `get_device_list` + 授权列表，与 PMS 当前入住房逐一比对，修订差异（对应 Demo 的 Full Resync）。
4. 营业日切换（BUSINESS DATE CHANGE）：GRMS 无对应；PMS 夜审置脏的房间循环 `update_room_state`（限速）。

---

## 7. 错误码表（本次全部观测 + 文档）

HTTP：参数绑定 400；鉴权 401；业务/下游 500。`detail.trace_id` 每次都有。

| code | message | 触发（命令） | HTTP | 含义 / 处理 |
|---|---|---|---|---|
| 50104080 | api hotel command bind body | 任意命令：缺 `param`、Required 字段为 ""/0、page_index=0/page_size=0/>500、command 为空 | 400 | 网关请求绑定失败。我方 bug，修参数，不重试 |
| 50104082 | api hotel command not found | 未知 command | — | 命令名写错 |
| 50107040 | middleware access token null | 无 Authorization | 401 | 缺令牌 |
| 50107041 | middleware invalid token | 坏令牌 / **令牌被新签发的令牌顶掉** | 401 | 重取令牌；注意单活 |
| 50105580 | （parent 观测） | `create_order_info` start_time < now | — | 用当前时间 |
| 50105582 | open ability data null | `get_authorization_record_info` 不存在 id | 500 | 视为不存在 |
| 50104362 | service hotel get room failed | `get_room_type_info`/`get_room_tag_info` 不存在 id | 500 | 视为不存在 |
| 50100320 | service check param illegal | `get_device_info`/`get_lock_history`/`get_device_list(residence_id)` 的 id 不存在 | 500 | 视为不存在 |
| 50100303 | service lock basic config failed（detail:`"device not supported"`） | `get_lock_basic_config` 对非锁设备 | — | 设备类型不匹配 |
| 50100300 | service lock temp key failed | `get_lock_temp_key_config` 对非锁设备 | — | 同上 |
| 20017608 | service get partner rms room info check residence id exists | `get_room_info` 不存在的 residence_id | 500 | 不存在 |
| 20017008 | …order info check order id exists | `get_order_info` 假 id | 500 | 不存在 |
| 20016635 | …guest check guest id exists | `get_guest_info` 假 id | 500 | 不存在 |
| 20017135 | …permission group check permission group id exists | `get_access_group_info` 假 id | 500 | 不存在 |
| 20018208 | …staff access detail check staff access id exists | `get_access_card_info` 假 id | 500 | 不存在 |
| 20950100 | service rms error | `get_staff_info` 假 id | 500 | 不存在/下游错误 |
| 70400202 | invalid auth | `get_access_device_info` 假 id | 500 | 不存在或无权限（含义不清） |
| 20950001 | api room bind body | `get_room_info`（真实 id）、`update_room_state` | 500 | **UAT 平台故障**（下游响应绑定失败）；换环境/向厂商报 trace_id |
| 20950000 | api rms bind body | `get_staff_list` | 500 | UAT 平台故障 |
| 20950004 | api notification bind body | `get_alarm_record_list` | 500 | UAT 平台故障 |
| 20950005 | api order bind body | `create_order_info`（文档示例参数） | 500 | UAT 平台故障；或与 §2.4 零值有关，待排除 |
| 20950008 | api device bind body | `get_alarm_config` | 500 | UAT 平台故障 |
| 20950019 | api permission group bind header | `get_public_access_group_list` | 500 | UAT 平台故障（header 绑定） |
| 24400347 | api get project timezone bind header | `get_project_info` | 500 | 疑似项目时区未配置；加 Timezone 头无效 |
| 20000000 | Internal Error | 文档失败示例 | 4xx/5xx | 通用内部错误 |

---

## 9. 待厂商确认 / 受控写测试清单

厂商/文档问题：
1. Appendix “Standard Device Model / Scene Trigger Config / Scene Action Config” 全文（control 值、attribute 结构、触发/动作枚举）——官网页面不可访问。
2. 上表 UAT 平台故障（尤其 `get_room_info`、`update_room_state`、`create_order_info`）的根因与修复时间；项目时区是否未配置。
3. `order_state` 三值语义与 create 后初始状态；退房是否自动置脏、入住是否自动置占用。
4. `authorization_status` 枚举；PIN 位数/生成规则；是否有 webhook/推送（listen_config 仅 booking）。
5. `id`（命令 ID）是否幂等键；限流阈值；设备离线时 control 的返回。
6. OOO 的官方做法（标签？）；room_tag 是否单标签。

建议的首批受控写测试（需用户授权，均可逆）：
1. `control_device` 对在线 Relay1 `turn_on`→读回→`turn_off`（验证 control 名、延迟）。
2. `control_device` 对离线空调 `turn_off`（记录离线错误码）；在线后再试 `set_hvac_mode/set_temperature` 的 attribute 键。
3. `update_room_state{dirty:true}` 后 `{dirty:false}`（验证 false 是否被网关拒、`get_room_info` 回读）——前提平台修复。
4. 平台修复后：`create_order_info`（不同 guest 占位策略）→`get_order_info`→`update_order_info`（checked_out）→`delete_order_info`。
5. 建 `OPERA_WELCOME`/`OPERA_ECO` 场景后 `manual_trigger_scene` + `get_scene_history`。
6. 绑定门锁后验证 `create_authorization_record_info` password/rf_card 全流程。

---

## 8. 命令详述（按模块；字段表自动由官方文档生成，UAT 栏为实测）

“必填”列 Yes/No 来自官方文档；§2.4 的零值风险适用于所有 Yes 字段。


##  房间 / 房型 / 房间标签 / 授权记录（Room Management）


### `get_room_list` — Get Room List　[读]

列出全部楼栋/楼层/房间（residence_id 即其余命令用的房间主键）。无分页。

**UAT 实测**：OK。当前：楼栋 b1 / 楼层 `1`(floor_id 为空串) / 房间 101 = `rf9f07a99092443c8bf09c2ddc2a51da0`。

**param**

_无_

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `building_id` | String | 楼栋ID |
| `building_name` | String | 楼栋名 |
| `floors` | []Object<floor> | Floor information |
| `floors[].floor_id` | String | 楼层ID |
| `floors[].floor_name` | String | 楼层名 |
| `floors[].residences` | []Object<residence> | 房间列表 |
| `floors[].residences[].residence_id` | String | 房间(residence)ID |
| `floors[].residences[].residence_name` | String | 房号 |

最小示例 `param`：`{}`


### `get_room_info` — Get Room Information　[读]

读取单房状态：脏房 dirty / 在住 occupied / 免打扰 dnd / 当前订单 order_id / 房型 / 标签。**入站轮询 HK/DND/占用的唯一来源**。

**UAT 实测**：真实 residence_id 失败 `20950001 api room bind body`（HTTP 500；网关绑定下游响应失败，疑似平台侧数据/项目配置问题）；不存在的 id 返回 `20017608 ...check residence id exists`（说明命令本身可达）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `residence_id` | String | Yes | 房间(residence)ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `building_id` | String | 楼栋ID |
| `building_name` | String | 楼栋名 |
| `floor_id` | String | 楼层ID |
| `floor_name` | String | 楼层名 |
| `residence_no` | String | 房号 |
| `room_type_id` | String | 房型ID |
| `room_type_name` | String | 房型名 |
| `room_tag_id` | String | 房间标签ID |
| `room_tag_name` | String | 房间标签名 |
| `order_id` | String | 订单ID |
| `dirty` | Boolean | Whether the room is dirty or not? true: yes false: no |
| `occupied` | Boolean | Whether the room is occupied or not? true: yes false: no |
| `dnd` | Boolean | Whether the room is DND or not? true: yes false: no |

最小示例 `param`：`{"residence_id": "rx9a621c1ae77040d697bd2134700f57v"}`

> 注意：UAT 目前无法读回 dirty/occupied/dnd；设计上必须有降级（见 §6）。


### `update_room_state` — Update Room State　[写]

设置房间脏/净（仅 `dirty` 布尔）。PMS HK 状态只能二值化映射：Dirty/Pickup→true；Clean/Inspected→false。

**UAT 实测**：真实 residence_id 失败 `20950001`（同 get_room_info）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `residence_id` | String | Yes | 房间(residence)ID |
| `dirty` | Boolean | Yes | Whether the room is dirty or not? true: yes false: no |

**result**

_无_

最小示例 `param`：`{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52", "dirty": true}`

> 注意：无 MUR/DND/OOO/Inspected 写入能力。`dirty:false` 是 Go `required` 零值，需实测网关是否拒绝（见 §2.4）。


### `get_room_type_list` — Get Room Type List　[读]

房型列表。

**UAT 实测**：OK：单人房 `tc8f7ff97613945eda81572945b7d9796`（bed 1 / occupancy 1）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `room_type_id` | String | 房型ID |
| `room_type_name` | String | 房型名 |
| `bed` | Integer | 床数 |
| `occupancy` | Integer | 可住人数 |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_room_type_info` — Get Room Type Information　[读]

房型详情 + 房间集合。

**UAT 实测**：OK：residences=[101]。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_type_id` | String | Yes | 房型ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_type_name` | String | 房型名 |
| `bed` | Integer | 床数 |
| `occupancy` | Integer | 可住人数 |
| `residences` | []Object<residence> | 房间列表 |
| `residences[].residence_id` | String | 房间(residence)ID |

最小示例 `param`：`{"room_type_id": "rx9a621c1ae77040d697bd2134700f57e"}`


### `create_room_type_info` — Create Room Type Information　[写]

新建房型。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_type_name` | String | Yes | 房型名 |
| `bed` | Integer | Yes | 床数 |
| `occupancy` | Integer | Yes | 可住人数 |
| `residences` | []Object<residence> | Yes | 房间列表 |
| `residences[].residence_id` | String | Yes | 房间(residence)ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_type_id` | String | 房型ID |

最小示例 `param`：`{"room_type_name": "test", "bed": 2, "occupancy": 2, "residences": [{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}]}`


### `update_room_type_info` — Update Room Type Information　[写]

更新房型（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_type_id` | String | Yes | 房型ID |
| `room_type_name` | String | Yes | 房型名 |
| `bed` | Integer | Yes | 床数 |
| `occupancy` | Integer | Yes | 可住人数 |
| `residences` | []Object<residence> | Yes | 房间列表 |
| `residences[].residence_id` | String | Yes | 房间(residence)ID |

**result**

_无_

最小示例 `param`：`{"room_type_id": "r2a621c1ae77040d697bd2134700f57ea", "room_type_name": "test", "bed": 2, "occupancy": 2, "residences": [{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}]}`


### `delete_room_type_info` — Delete Room Type Information　[写]

删除房型。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_type_id` | String | Yes | 房型ID |

**result**

_无_

最小示例 `param`：`{"room_type_id": "rrbr2c4b070cc928496198944858b344f"}`


### `get_room_tag_list` — Get Room Tag List　[读]

房间标签列表（标签可作为场景触发条件 room_tag，可借来表达 OOO/维修等 PMS 状态）。

**UAT 实测**：OK：[]。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `room_tag_id` | String | 房间标签ID |
| `room_tag_name` | String | 房间标签名 |
| `residences` | []Object<residence> | 房间列表 |
| `residences[].residence_id` | String | 房间(residence)ID |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_room_tag_info` — Get Room Tag Information　[读]

查询单个房间标签。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_tag_id` | String | Yes | 房间标签ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_tag_name` | String | 房间标签名 |
| `residences` | []Object<residence> | 房间列表 |
| `residences[].residence_id` | String | 房间(residence)ID |

最小示例 `param`：`{"room_tag_id": "rx9a621c1ae77040d697bd2134700f572"}`


### `create_room_tag_info` — Create Room Tag Information　[写]

新建房间标签。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_tag_name` | String | Yes | 房间标签名 |
| `residences` | []Object<residence> | Yes | 房间列表 |
| `residences[].residence_id` | String | Yes | 房间(residence)ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_tag_id` | String | 房间标签ID |

最小示例 `param`：`{"room_tag_name": "test", "residences": [{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}]}`


### `update_room_tag_info` — Update Room Tag Information　[写]

更新房间标签（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_tag_id` | String | Yes | 房间标签ID |
| `room_tag_name` | String | Yes | 房间标签名 |
| `residences` | []Object<residence> | Yes | 房间列表 |
| `residences[].residence_id` | String | Yes | 房间(residence)ID |

**result**

_无_

最小示例 `param`：`{"room_tag_id": "r2a621c1ae77040d697bd2134700f57e1", "room_tag_name": "test", "residences": [{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}]}`


### `delete_room_tag_info` — Delete Room Tag Information　[写]

删除房间标签。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `room_tag_id` | String | Yes | 房间标签ID |

**result**

_无_

最小示例 `param`：`{"room_tag_id": "rrbr2c4b070cc928496198944858b343f"}`


### `get_authorization_record_list` — Get Authorization Record List　[读]

授权记录（房客的 PIN/RF卡/二维码开门授权）分页列表。

**UAT 实测**：OK：[]（当前房间没有门锁，无记录）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `record_id` | String | 记录ID |
| `authorization_number` | String | 授权号 |
| `access_type` | String | Access type, password or rf_card or qr_code |
| `guest_id` | String | 住客ID |
| `guest_name` | String | 住客姓名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `residence_id` | String | 房间(residence)ID |
| `residence_no` | String | 房号 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `authorization_status` | String | 授权状态 |
| `updated_time` | String | 更新时间 UTC |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_authorization_record_info` — Get Authorization Record Information　[读]

授权记录详情（含 pin_code / rf_card_number / qr_code_url）。

**UAT 实测**：不存在 id → `50105582 open ability data null`。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `record_id` | String | Yes | 记录ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `authorization_number` | String | 授权号 |
| `access_type` | String | Access type, password or rf_card or qr_code |
| `pin_code` | String | PIN码 |
| `rf_card_number` | String | RF卡号 |
| `qr_code_url` | String | 二维码URL |
| `guest_id` | String | 住客ID |
| `guest_name` | String | 住客姓名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `residence_id` | String | 房间(residence)ID |
| `residence_no` | String | 房号 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `authorization_status` | String | 授权状态 |
| `updated_time` | String | 更新时间 UTC |

最小示例 `param`：`{"record_id": "rr31adc223cc4b3bedb6bd4742dedcfa5"}`


### `create_authorization_record_info` — Create Authorization Record Information　[写]

为某住客在某房创建开门授权（密码/RF卡/二维码），带有效期。**PMS 发门禁 PIN/卡的主命令**。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_type` | String | Yes | Access type, password or rf_card or qr_code |
| `pin_code` | String | No | PIN码 |
| `rf_card_number` | String | No | RF卡号 |
| `guest_id` | String | Yes | 住客ID |
| `residence_id` | String | Yes | 房间(residence)ID |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `record_id` | String | 记录ID |
| `authorization_number` | String | 授权号 |
| `qr_code_url` | String | 二维码URL |

最小示例 `param`：`{"access_type": "password", "pin_code": "123456", "rf_card_number": "", "guest_id": "grr31adc223cc4b3bedb6bd4742dedcfa", "residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52", "start_time": "2025-08-06 03:00:03", "finish_time": "2025-08-06 03:30:03"}`

> 注意：需 guest_id（先有订单/住客）。password 类型传 pin_code，rf_card 传 rf_card_number，qr_code 由平台生成返回 qr_code_url。房间必须绑定了门锁/门禁设备才有意义（101 目前无锁）。pin_code/rf_card_number 虽标 No，按 access_type 实际必填；无关字段留空会不会触发 required 绑定失败待测。


### `delete_authorization_record_info` — Delete Authorization Record Information　[写]

撤销/删除授权记录（退房时回收门禁权限）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `record_id` | String | Yes | 记录ID |

**result**

_无_

最小示例 `param`：`{"record_id": "rr31adc223cc4b3bedb6bd4742dedcfa5"}`


##  订单（入住单）（Order Management）


### `get_order_list` — Get Order List　[读]

订单列表（只有分页，**无状态/房间/日期过滤**），含住客。入站同步靠全量/翻页轮询。

**UAT 实测**：OK：[]。分页 page_size 1..500，page_index≥1（0 或 >500 → `50104080` HTTP 400）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `order_id` | String | 订单ID |
| `order_number` | String | 订单号 |
| `residence_id` | String | 房间(residence)ID |
| `residence_no` | String | 房号 |
| `room_type_id` | String | 房型ID |
| `room_type_name` | String | 房型名 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `order_state` | String | Order state, check_in or checked_in or checked_out |
| `guests` | []Object<guest> | Guest information |
| `guests[].guest_id` | String | 住客ID |
| `guests[].guest_name` | String | 住客姓名 |
| `guests[].email` | String | 邮箱 |
| `guests[].phone` | String | 电话 |
| `guests[].id_card` | String | 身份证号 |
| `guests[].passport` | String | 护照号 |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_order_info` — Get Order Information　[读]

订单详情。

**UAT 实测**：假 id → `20017008 ...check order id exists`。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `order_id` | String | Yes | 订单ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `order_number` | String | 订单号 |
| `residence_id` | String | 房间(residence)ID |
| `residence_no` | String | 房号 |
| `room_type_id` | String | 房型ID |
| `room_type_name` | String | 房型名 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `order_state` | String | Order state, check_in or checked_in or checked_out |
| `guests` | []Object<guest> | Guest information |
| `source` | String | 来源 |
| `remark` | String | 备注 |
| `enable_booking` | Boolean | Whether the booking is enable or not? true: enable false: disable |
| `guests[].guest_id` | String | 住客ID |
| `guests[].guest_name` | String | 住客姓名 |
| `guests[].email` | String | 邮箱 |
| `guests[].phone` | String | 电话 |
| `guests[].id_card` | String | 身份证号 |
| `guests[].passport` | String | 护照号 |

最小示例 `param`：`{"order_id": "orx9a621c1ae77040d697bd2134700f57"}`

> 注意：文档示例 start/finish 是 UTC `YYYY-MM-DD HH:mm:ss`。


### `create_order_info` — Create Order Information　[写]

创建订单（= PMS Check-in / 预留）：一次建单并随单创建首位住客，返回 order_id/order_number/guest_id。

**UAT 实测**：失败 `20950005 api order bind body`（UAT 平台侧，参数按文档示例）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `residence_id` | String | Yes | 房间(residence)ID |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |
| `guest` | Object<guest> | Yes | Guest information |
| `source` | String | Yes | 来源 |
| `remark` | String | Yes | 备注 |
| `enable_booking` | Boolean | Yes | Whether the booking is enable or not? true: enable false: disable |
| `guest.guest_name` | String | Yes | 住客姓名 |
| `guest.email` | String | Yes | 邮箱 |
| `guest.phone` | String | Yes | 电话 |
| `guest.id_card` | String | Yes | 身份证号 |
| `guest.passport` | String | Yes | 护照号 |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `order_id` | String | 订单ID |
| `order_number` | String | 订单号 |
| `guest_id` | String | 住客ID |

最小示例 `param`：`{"residence_id": "rorx9a621c1ae77040d697bd2134700f5", "start_time": "2025-08-06 03:00:03", "finish_time": "2025-08-06 03:30:03", "source": "SaaS", "remark": "", "enable_booking": false, "guest": {"guest_name": "dom", "email": "test@akubela.com", "phone": "1234567", "id_card": "1234567890", "passport": ""}}`

> 注意：`start_time` 必须 ≥ 当前时间（`50105580`），UTC。五个 guest 字段文档均标 Required，空串会被网关绑定拒绝（`50104080`）→ 无证件号时需填占位值（待实测）。`enable_booking:false` 同属零值风险。


### `update_order_info` — Update Order Information　[写]

更新订单（**整体覆盖**：start/finish/order_state/source/remark/enable_booking 全部必填，先 get_order_info 再改）。用于延住/提前离店（改 finish_time）、置 order_state（check_in/checked_in/checked_out）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `order_id` | String | Yes | 订单ID |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |
| `order_state` | String | Yes | Order state, check_in or checked_in or checked_out |
| `source` | String | Yes | 来源 |
| `remark` | String | Yes | 备注 |
| `enable_booking` | Boolean | Yes | Whether the booking is enable or not? true: enable false: disable |

**result**

_无_

最小示例 `param`：`{"order_id": "o2a621c1ae77040d697bd2134700f57e1", "start_time": "2025-08-06 03:00:03", "finish_time": "2025-08-06 03:30:03", "order_state": "check_in", "source": "SaaS", "remark": "", "enable_booking": false}`

> 注意：不含 residence_id → **无法在同一订单内换房**；换房 = 旧单 checked_out + 新房新建订单。


### `delete_order_info` — Delete Order Information　[写]

删除订单（取消/误建；与 checked_out 语义不同）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `order_id` | String | Yes | 订单ID |

**result**

_无_

最小示例 `param`：`{"order_id": "orbr2c4b070cc928496198944858b343f"}`


##  住客 / 会员 / 员工（User Management）


### `get_guest_list` — Get Guest List　[读]

住客列表（全局）。

**UAT 实测**：OK：[]。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `guest_id` | String | 住客ID |
| `guest_name` | String | 住客姓名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `id_card` | String | 身份证号 |
| `passport` | String | 护照号 |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_guest_info` — Get Guest Information　[读]

查询单个住客。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `guest_id` | String | Yes | 住客ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `guest_name` | String | 住客姓名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `id_card` | String | 身份证号 |
| `passport` | String | 护照号 |

最小示例 `param`：`{"guest_id": "gx9a621c1ae77040d697bd2134700f57e"}`


### `create_guest_info` — Create Guest Information　[写]

给已有订单追加同住人（需 order_id）。主住客由 create_order_info 随单创建。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `guest_name` | String | Yes | 住客姓名 |
| `email` | String | Yes | 邮箱 |
| `phone` | String | Yes | 电话 |
| `id_card` | String | Yes | 身份证号 |
| `passport` | String | Yes | 护照号 |
| `order_id` | String | Yes | 订单ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `guest_id` | String | 住客ID |

最小示例 `param`：`{"guest_name": "test", "email": "test@akubela.com", "phone": "1234567", "id_card": "1234567890", "passport": "", "order_id": "oc45e846ca23ab42c9ae469d988ae32a9"}`

> 注意：全部 6 字段 Required。


### `update_guest_info` — Update Guest Information　[写]

更新住客（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `guest_id` | String | Yes | 住客ID |
| `guest_name` | String | Yes | 住客姓名 |
| `email` | String | Yes | 邮箱 |
| `phone` | String | Yes | 电话 |
| `id_card` | String | Yes | 身份证号 |
| `passport` | String | Yes | 护照号 |

**result**

_无_

最小示例 `param`：`{"guest_id": "g2a621c1ae77040d697bd2134700f57ea", "guest_name": "test", "email": "test@akubela.com", "phone": "1234567", "id_card": "1234567890", "passport": ""}`


### `delete_guest_info` — Delete Guest Information　[写]

删除住客。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `guest_id` | String | Yes | 住客ID |

**result**

_无_

最小示例 `param`：`{"guest_id": "grbr2c4b070cc928496198944858b344f"}`


### `get_member_list` — Get Member List　[读]

会员列表（预约设施用的宿主/App 会员）。

**UAT 实测**：OK：result 为 `null`（空集合时返回 null 而非 []）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `member_id` | String | 会员ID |
| `member_name` | String | 会员名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_member_info` — Get Member Information　[读]

查询单个会员。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `member_id` | String | Yes | 会员ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `member_name` | String | 会员名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"member_id": "mx9a621c1ae77040d697bd2134700f57e"}`


### `create_member_info` — Create Member Information　[写]

新建会员。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `member_name` | String | Yes | 会员名 |
| `email` | String | Yes | 邮箱 |
| `phone` | String | Yes | 电话 |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `member_id` | String | 会员ID |

最小示例 `param`：`{"member_name": "test", "email": "test@akubela.com", "phone": "1234567"}`


### `update_member_info` — Update Member Information　[写]

更新会员（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `member_id` | String | Yes | 会员ID |
| `member_name` | String | Yes | 会员名 |
| `email` | String | Yes | 邮箱 |
| `phone` | String | Yes | 电话 |

**result**

_无_

最小示例 `param`：`{"member_id": "m2a621c1ae77040d697bd2134700f57ea", "member_name": "test", "email": "test@akubela.com", "phone": "1234567"}`


### `delete_member_info` — Delete Member Information　[写]

删除会员。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `member_id` | String | Yes | 会员ID |

**result**

_无_

最小示例 `param`：`{"member_id": "mrbr2c4b070cc928496198944858b344f"}`


### `get_staff_list` — Get Staff List　[读]

员工列表。

**UAT 实测**：失败 `20950000 api rms bind body`（平台侧）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `staff_id` | String | 员工ID |
| `staff_name` | String | 员工名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_staff_info` — Get Staff Information　[读]

查询单个员工。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `staff_id` | String | Yes | 员工ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `staff_name` | String | 员工名 |
| `email` | String | 邮箱 |
| `phone` | String | 电话 |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"staff_id": "sx9a621c1ae77040d697bd2134700f57e"}`


### `create_staff_info` — Create Staff Information　[写]

新建员工。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `staff_name` | String | Yes | 员工名 |
| `email` | String | Yes | 邮箱 |
| `phone` | String | Yes | 电话 |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `staff_id` | String | 员工ID |

最小示例 `param`：`{"staff_name": "test", "email": "test@akubela.com", "phone": "1234567"}`


### `update_staff_info` — Update Staff Information　[写]

更新员工（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `staff_id` | String | Yes | 员工ID |
| `staff_name` | String | Yes | 员工名 |
| `phone` | String | Yes | 电话 |

**result**

_无_

最小示例 `param`：`{"staff_id": "s2a621c1ae77040d697bd2134700f57ea", "staff_name": "test", "phone": "1234567"}`


### `delete_staff_info` — Delete Staff Information　[写]

删除员工。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `staff_id` | String | Yes | 员工ID |

**result**

_无_

最小示例 `param`：`{"staff_id": "srbr2c4b070cc928496198944858b344f"}`


##  设备 / 灯控组 / 门锁 / 门禁设备（Device Management）


### `get_device_list` — Get Device List　[读]

设备列表。传 residence_id 才能 show_ability=true 返回 abilities；parallel_sub_device=true 把子设备平铺。

**UAT 实测**：OK。无 residence_id 时只返回根设备 HyPanel（子设备嵌套、无 abilities）；`sub_device_type` 匹配的是 **device_type 字符串**（如 `Smart Valve`），不是 ability_type。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |
| `residence_id` | String | No | 房间(residence)ID |
| `sub_device_type` | []String | No | Sub-device type |
| `show_ability` | Boolean | No | Whether show device ability or not? true: show false: hide Only valid with residence_id |
| `parallel_sub_device` | Boolean | No | Whether the sub-device is parallel or not? true: parallel false: nesting |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `device_id` | String | 设备ID |
| `device_name` | String | 设备名 |
| `product_name` | String | 产品名 |
| `device_type` | String | 设备类型 |
| `device_picture_url` | String | 设备图片URL |
| `online` | Boolean | Whether the device is online or not? true: online false: offline |
| `abilities` | []Object<ability> | 能力列表 |
| `space` | Object<space> | 空间信息 |
| `sub_devices` | []Object<result> | 子设备列表 |
| `parent_device_id` | String | 父设备ID |
| `abilities[].ability_id` | String | 能力ID |
| `abilities[].ability_name` | String | 能力名 |
| `abilities[].ability_type` | String | Ability type, see Standard Device Model (附录页, 未公开) |
| `abilities[].ability_attribute` | []String | Ability attribute, see Standard Device Model (附录页, 未公开) |
| `abilities[].state` | String | State, see Standard Device Model (附录页, 未公开) |
| `abilities[].attribute` | Object | Attribute, see Standard Device Model (附录页, 未公开) |
| `space.space_id` | String | 空间ID |
| `space.space_name` | String | 空间名 |
| `space.parent_space_id` | String | 父空间ID |

最小示例 `param`：`{"page_size": 1, "page_index": 1, "residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52", "show_ability": true, "parallel_sub_device": false}`

> 注意：分页作用于根设备；平铺模式下 page_size 小时会重复返回（page_size=3 时第2/3页重复）——请用 page_size≥100 一次取完。未带 show_ability 时 `abilities` 键整体缺失。


### `get_device_info` — Get Device Information　[读]

单设备详情，实测为 **对象**（文档示例为数组）；比文档多 `wifi_ssid/wifi_ip/wifi_gateway/wifi_rssi/last_online_time`，并含嵌套 sub_devices。

**UAT 实测**：OK。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `device_id` | String | 设备ID |
| `device_name` | String | 设备名 |
| `product_name` | String | 产品名 |
| `device_type` | String | 设备类型 |
| `device_picture_url` | String | 设备图片URL |
| `online` | Boolean | Whether the device is online or not? true: online false: offline |
| `abilities` | []Object<ability> | 能力列表 |
| `space` | Object<space> | 空间信息 |
| `sub_devices` | []Object<result> | 子设备列表 |
| `abilities[].ability_id` | String | 能力ID |
| `abilities[].ability_name` | String | 能力名 |
| `abilities[].ability_type` | String | Ability type, see Standard Device Model (附录页, 未公开) |
| `abilities[].ability_attribute` | []String | Ability attribute, see Standard Device Model (附录页, 未公开) |
| `abilities[].state` | String | State, see Standard Device Model (附录页, 未公开) |
| `abilities[].attribute` | Object | Attribute, see Standard Device Model (附录页, 未公开) |
| `space.space_id` | String | 空间ID |
| `space.space_name` | String | 空间名 |
| `space.parent_space_id` | String | 父空间ID |

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0cx"}`


### `control_device` — Control Device　[写]

对设备的某个 ability 下发控制，`control` 为动作，`attribute` 为参数。**欢迎/节能场景的执行手段**。

**UAT 实测**：未测（写）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `ability_id` | String | Yes | 能力ID |
| `control` | String | Yes | Control, see Standard Device Model (附录页, 未公开) |
| `attribute` | Object | No | Attribute, see Standard Device Model (附录页, 未公开) |

**result**

_无_

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0cx", "ability_id": "e8b5a73f8dd84abaa94dcs288be49b4ce", "control": "turn_on", "attribute": {"brightness": 70}}`

> 注意：control 取值与 attribute 结构属“Standard Device Model”附录，官网未公开；本文 §4 由文档示例 + GRMS 门户前端 bundle 推断，**需在 UAT 对 101 做一次受控写测试确认**。设备 offline 时是否报错未知。


### `batch_control_device` — Batch Control Device　[写]

批量 control_device（devices[] 每项含 device_id/ability_id/control/attribute）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `devices` | []Object<device> | Yes | 设备信息 |
| `devices[].device_id` | String | Yes | 设备ID |
| `devices[].ability_id` | String | Yes | 能力ID |
| `devices[].control` | String | Yes | Control, see Standard Device Model (附录页, 未公开) |
| `devices[].attribute` | Object | No | Attribute, see Standard Device Model (附录页, 未公开) |

**result**

_无_

最小示例 `param`：`{"devices": [{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0cx", "ability_id": "e8b5a73f8dd84abaa94dcs288be49b4ce", "control": "turn_on", "attribute": {"brightness": 70}}]}`


### `batch_control_device_group` — Batch Control Device Group　[写]

按“房间 + 空间 + 能力类型”批量控制：对 residence 的某些 space 下全部某 ability_type（如 light）发 control，无需知道 device_id/ability_id。**节能一键关灯/关空调的最简方式**。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `residence_id` | String | Yes | 房间(residence)ID |
| `spaces` | []Object<space> | Yes | 空间信息 |
| `devices` | []Object<device> | Yes | 设备信息 |
| `spaces[].space_id` | String | Yes | 空间ID |
| `devices[].ability_type` | String | Yes | Ability type, see Standard Device Model (附录页, 未公开) |
| `devices[].control` | String | Yes | Control, see Standard Device Model (附录页, 未公开) |

**result**

_无_

最小示例 `param`：`{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52", "spaces": [{"space_id": "r8b5a73f8dd84abaa94dcs248be49b0d2"}], "devices": [{"ability_type": "light", "control": "turn_on"}]}`

> 注意：devices[] 里只有 ability_type + control，没有 attribute，故只能做 turn_on/turn_off 类开关，不能设温度。


### `update_device_info` — Update Device Information　[写]

更新设备（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `space_id` | String | Yes | 空间ID |
| `device_name` | String | Yes | 设备名 |

**result**

_无_

最小示例 `param`：`{"device_name": "test_device_name", "device_id": "d3cbca664f4a10a0ce95452be1b67ca58", "space_id": "rc3c6e408413be7fdc3e60f34f0950d6b"}`


### `batch_update_device_info` — Batch Update Device Information　[写]

批量更新设备。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `devices` | []Object<device> | Yes | 设备信息 |
| `residence_id` | String | Yes | 房间(residence)ID |
| `devices[].device_id` | String | Yes | 设备ID |
| `devices[].space_id` | String | Yes | 空间ID |
| `devices[].device_name` | String | Yes | 设备名 |

**result**

_无_

最小示例 `param`：`{"devices": [{"device_id": "d2ab24943ba75edc0a77211e5084f95e0", "space_id": "rcf986cb4c00d4a031a56a51a81e430d5", "device_name": "test_device_name"}], "residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}`


### `update_device_ability_info` — Update Device Ability Information　[写]

更新设备能力名称（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `ability_id` | String | Yes | 能力ID |
| `ability_name` | String | Yes | 能力名 |

**result**

_无_

最小示例 `param`：`{"ability_name": "test_name", "device_id": "d3cbca664f4a10a0ce95452be1b67ca58", "ability_id": "ac3c6e408413be7fdc3e60f34f0950d6b"}`


### `batch_update_device_ability_info` — Batch Update Device Ability Information　[写]

批量更新设备能力名称。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `devices` | []Object<device> | Yes | 设备信息 |
| `residence_id` | String | Yes | 房间(residence)ID |
| `devices[].device_id` | String | Yes | 设备ID |
| `devices[].ability_id` | String | Yes | 能力ID |
| `devices[].ability_name` | String | Yes | 能力名 |

**result**

_无_

最小示例 `param`：`{"devices": [{"device_id": "d2ab24943ba75edc0a77211e5084f95e0", "ability_id": "acf986cb4c00d4a031a56a51a81e430d5", "ability_name": "test_name"}], "residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}`


### `get_light_control_group_info` — Get Light Control Group Information　[读]

灯控组（低/中/高亮度编组）。

**UAT 实测**：OK：HyPanel 无编组（三个数组空）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `device_name` | String | 设备名 |
| `space_id` | String | 空间ID |
| `control_group` | Object<control_group> | Control group |
| `control_group.low_brightness_level_groups` | []Object<brightness_level_group> | Low brightness level group information |
| `control_group.medium_brightness_level_groups` | []Object<brightness_level_group> | Medium brightness level group information |
| `control_group.high_brightness_level_groups` | []Object<brightness_level_group> | High brightness level group information |
| `{control_group.low_brightness_level_groups[]|control_group.medium_brightness_level_groups[]|control_group.high_brightness_level_groups[]}.device_id` | String | 设备ID |
| `{control_group.low_brightness_level_groups[]|control_group.medium_brightness_level_groups[]|control_group.high_brightness_level_groups[]}.ability_id` | String | 能力ID |

最小示例 `param`：`{"device_id": "d11adc223cc4b3bedb6bd4742dedcfa52"}`


### `get_groupable_control_light_list` — Get Groupable Control Light List　[读]

列出房间内可编组的灯能力。

**UAT 实测**：OK：返回 1 Gang Switch（卧室1）的 Switch1，说明该开关被当作“灯”。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `residence_id` | String | Yes | 房间(residence)ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `device_id` | String | 设备ID |
| `device_name` | String | 设备名 |
| `space_id` | String | 空间ID |
| `space_name` | String | 空间名 |
| `abilities` | []Object<ability> | 能力列表 |
| `abilities[].ability_id` | String | 能力ID |
| `abilities[].ability_name` | String | 能力名 |

最小示例 `param`：`{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}`


### `create_light_control_group_info` — Create Light Control Group Information　[写]

新建灯控组。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `residence_id` | String | Yes | 房间(residence)ID |
| `device_name` | String | Yes | 设备名 |
| `space_id` | String | Yes | 空间ID |
| `control_group` | Object<control_group> | Yes | Control group |
| `control_group.low_brightness_level_groups` | []Object<brightness_level_group> | Yes | Low brightness level group information |
| `control_group.medium_brightness_level_groups` | []Object<brightness_level_group> | Yes | Medium brightness level group information |
| `control_group.high_brightness_level_groups` | []Object<brightness_level_group> | Yes | High brightness level group information |
| `{control_group.low_brightness_level_groups[]|control_group.medium_brightness_level_groups[]|control_group.high_brightness_level_groups[]}.device_id` | String | Yes | 设备ID |
| `{control_group.low_brightness_level_groups[]|control_group.medium_brightness_level_groups[]|control_group.high_brightness_level_groups[]}.ability_id` | String | Yes | 能力ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `device_id` | String | 设备ID |

最小示例 `param`：`{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52", "device_name": "test", "space_id": "rafa332e258aae1badbb27d31128f442d", "control_group": {"low_brightness_level_groups": [{"device_id": "dafa332e258aae1badbb27d31128f4421", "ability_id": "e8b5a73f8dd84abaa94b1c288be49b0c1"}], "medium_brightness_level_groups": [], "high_brightness_level_groups": []}}`


### `update_light_control_group_info` — Update Light Control Group Information　[写]

更新灯控组（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `device_name` | String | Yes | 设备名 |
| `space_id` | String | Yes | 空间ID |
| `control_group` | Object<control_group> | Yes | Control group |
| `control_group.low_brightness_level_groups` | []Object<brightness_level_group> | Yes | Low brightness level group information |
| `control_group.medium_brightness_level_groups` | []Object<brightness_level_group> | Yes | Medium brightness level group information |
| `control_group.high_brightness_level_groups` | []Object<brightness_level_group> | Yes | High brightness level group information |
| `{control_group.low_brightness_level_groups[]|control_group.medium_brightness_level_groups[]|control_group.high_brightness_level_groups[]}.device_id` | String | Yes | 设备ID |
| `{control_group.low_brightness_level_groups[]|control_group.medium_brightness_level_groups[]|control_group.high_brightness_level_groups[]}.ability_id` | String | Yes | 能力ID |

**result**

_无_

最小示例 `param`：`{"device_id": "dafa332e258aae1badbb27d31128f5521", "device_name": "test", "space_id": "rafa332e258aae1badbb27d31128f442d", "control_group": {"low_brightness_level_groups": [{"device_id": "dafa332e258aae1badbb27d31128f4421", "ability_id": "e8b5a73f8dd84abaa94b1c288be49b0c1"}], "medium_brightness_level_groups": [], "high_brightness_level_groups": []}}`


### `get_lock_basic_config` — Get Lock Basic Config　[读]

门锁基础配置（语言/音量/RTSP…）。

**UAT 实测**：对 HyPanel 返回 `50100303 device not supported`（非门锁设备）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `language` | String | Language |
| `supported_language` | []String | Supported language |
| `volume` | String | Volume, high or medium or low or mute |
| `dwell_alarm` | Boolean | Whether the dwell alarm is enable or not? true: enable false: disable |
| `dwell_time` | Integer | Dwell time (s), 15 or 20 or 25 |
| `monitoring_scope` | String | Monitoring scope, large or small |
| `double_verification` | Boolean | Whether the double verification is enable or not? true: enable false: disable |
| `wifi_ssid` | String | WiFi SSID |
| `wifi_ip` | String | WiFi IP |
| `wifi_gateway` | String | WiFi gateway |
| `wifi_rssi` | Integer | WiFi RSSI |
| `lock_version` | String | Lock version |
| `rtsp_url` | String | RTSP URL |
| `support_audio_intercom` | Boolean | Support audio intercom true: supported false: not supported |
| `ciphertext` | String | Ciphertext, dependent on SDK |

最小示例 `param`：`{"device_id": "d3b5a73f8dd84abaa94dcs288be49b0pf"}`


### `update_lock_basic_config` — Update Lock Basic Config　[写]

更新门锁基础配置（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `language` | String | No | Language |
| `volume` | String | No | Volume, high or medium or low or mute |
| `dwell_alarm` | Boolean | No | Whether the dwell alarm is enable or not? true: enable false: disable |
| `dwell_time` | Integer | No | Dwell time (s), 15 or 20 or 25 |
| `monitoring_scope` | String | No | Monitoring scope, large or small |
| `double_verification` | Boolean | No | Whether the double verification is enable or not? true: enable false: disable |

**result**

_无_

最小示例 `param`：`{"device_id": "d3b5a73f8dd84abaa94dcs288be49b0pf", "language": "en", "volume": "high", "dwell_alarm": true, "dwell_time": 20, "monitoring_scope": "large", "double_verification": true}`


### `get_lock_temp_key_config` — Get Lock Temp Key Config　[读]

门锁临时密钥（带有效期/周重复）列表。

**UAT 实测**：对 HyPanel 返回 `50100300 service lock temp key failed`。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `key_id` | String | 钥匙ID |
| `key_name` | String | 钥匙名 |
| `temp_key` | String | Temp key |
| `repeat_mode` | String | Repeat mode, never or weekly |
| `available_days` | []String | Available days |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |

最小示例 `param`：`{"device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`

> 注意：示例里 weekly 模式的 start/finish 是纯时间 `HH:mm:ss`，never 模式是完整日期时间。


### `create_lock_temp_key_config` — Create Lock Temp Key Config　[写]

在门锁上创建临时密码（PIN）：repeat_mode never/weekly + 有效期。**不依赖 authorization record 的“设备级”发 PIN 方式**。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `key_name` | String | Yes | 钥匙名 |
| `temp_key` | String | Yes | Temp key |
| `repeat_mode` | String | Yes | Repeat mode, never or weekly |
| `available_days` | []String | No | Available days |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `key_id` | String | 钥匙ID |

最小示例 `param`：`{"key_name": "test", "temp_key": "01234567", "repeat_mode": "weekly", "available_days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], "start_time": "12:32:43", "finish_time": "17:32:43", "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`

> 注意：temp_key 为 PIN 明文（示例 8 位）。


### `delete_lock_temp_key_config` — Delete Lock Temp Key Config　[写]

删除门锁临时密钥。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key_id` | String | Yes | 钥匙ID |
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5", "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `batch_delete_lock_temp_key_config` — Batch Delete Lock Temp Key Config　[写]

批量删除门锁临时密钥（keys[]）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keys` | []Object<key> | Yes | Key information |
| `device_id` | String | Yes | 设备ID |
| `keys[].key_id` | String | Yes | 钥匙ID |

**result**

_无_

最小示例 `param`：`{"keys": [{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5"}], "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `get_lock_open_door_key_config` — Get Lock Open Door Key Config　[读]

门锁“开门密码”（常驻 PIN，无有效期）列表。

**UAT 实测**：OK：[]（HyPanel）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `key_id` | String | 钥匙ID |
| `key_name` | String | 钥匙名 |
| `open_door_key` | String | Open door key |

最小示例 `param`：`{"device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `create_lock_open_door_key_config` — Create Lock Open Door Key Config　[写]

新建门锁开门密码。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `key_name` | String | No | 钥匙名 |
| `open_door_key` | String | Yes | Open door key |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `key_id` | String | 钥匙ID |

最小示例 `param`：`{"open_door_key": "123456", "key_name": "test", "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `update_lock_open_door_key_config` — Update Lock Open Door Key Config　[写]

更新门锁开门密码（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `key_id` | String | Yes | 钥匙ID |
| `key_name` | String | Yes | 钥匙名 |

**result**

_无_

最小示例 `param`：`{"device_id": "d3b5a73f8dd84abaa94dcs288be49b0pf", "key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5", "key_name": "test2"}`


### `delete_lock_open_door_key_config` — Delete Lock Open Door Key Config　[写]

删除门锁开门密码。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key_id` | String | Yes | 钥匙ID |
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5", "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `batch_delete_lock_open_door_key_config` — Batch Delete Lock Open Door Key Config　[写]

批量删除门锁开门密码（keys[]）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keys` | []Object<key> | Yes | Key information |
| `device_id` | String | Yes | 设备ID |
| `keys[].key_id` | String | Yes | 钥匙ID |

**result**

_无_

最小示例 `param`：`{"keys": [{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5"}], "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `get_lock_fingerprint_config` — Get Lock Fingerprint Config　[读]

查询单个门锁指纹。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `key_id` | String | 钥匙ID |
| `key_name` | String | 钥匙名 |

最小示例 `param`：`{"device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `update_lock_fingerprint_config` — Update Lock Fingerprint Config　[写]

更新门锁指纹（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `key_id` | String | Yes | 钥匙ID |
| `key_name` | String | Yes | 钥匙名 |

**result**

_无_

最小示例 `param`：`{"device_id": "d3b5a73f8dd84abaa94dcs288be49b0pf", "key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5", "key_name": "test2"}`


### `delete_lock_fingerprint_config` — Delete Lock Fingerprint Config　[写]

删除门锁指纹。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key_id` | String | Yes | 钥匙ID |
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5", "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `batch_delete_lock_fingerprint_config` — Batch Delete Lock Fingerprint Config　[写]

批量删除门锁指纹（keys[]）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keys` | []Object<key> | Yes | Key information |
| `device_id` | String | Yes | 设备ID |
| `keys[].key_id` | String | Yes | 钥匙ID |

**result**

_无_

最小示例 `param`：`{"keys": [{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5"}], "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `turn_on_lock_fingerprint_config` — Turn on Lock Fingerprint Config　[写]

开启门锁指纹功能。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0lv"}`


### `turn_off_lock_fingerprint_config` — Turn off Lock Fingerprint Config　[写]

关闭门锁指纹功能。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0lv"}`


### `get_lock_card_config` — Get Lock Card Config　[读]

查询单个门锁卡片。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `key_id` | String | 钥匙ID |
| `key_name` | String | 钥匙名 |

最小示例 `param`：`{"device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `update_lock_card_config` — Update Lock Card Config　[写]

更新门锁卡片（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `key_id` | String | Yes | 钥匙ID |
| `key_name` | String | Yes | 钥匙名 |

**result**

_无_

最小示例 `param`：`{"device_id": "d3b5a73f8dd84abaa94dcs288be49b0pf", "key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5", "key_name": "test2"}`


### `delete_lock_card_config` — Delete Lock Card Config　[写]

删除门锁卡片。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key_id` | String | Yes | 钥匙ID |
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5", "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `batch_delete_lock_card_config` — Batch Delete Lock Card Config　[写]

批量删除门锁卡片（keys[]）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keys` | []Object<key> | Yes | Key information |
| `device_id` | String | Yes | 设备ID |
| `keys[].key_id` | String | Yes | 钥匙ID |

**result**

_无_

最小示例 `param`：`{"keys": [{"key_id": "kr31adc223cc4b3bedb6bd4742dedcfa5"}], "device_id": "dr31adc223cc4b3bedb6bd4742dedcfa2"}`


### `turn_on_lock_card_config` — Turn on Lock Card Config　[写]

开启门锁卡片功能。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0lv"}`


### `turn_off_lock_card_config` — Turn off Lock Card Config　[写]

关闭门锁卡片功能。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

_无_

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0lv"}`


### `get_lock_history` — Get Lock History　[读]

门锁事件流水（unlock/alarm/doorbell/capture），可作开门事件入站来源。

**UAT 实测**：OK：[]。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |
| `lock_record_type` | String | No | Lock record type, unlock or alarm or doorbell or capture |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `lock_record_id` | String | Lock record ID |
| `lock_record_type` | String | Lock record type, unlock or alarm or doorbell or capture |
| `capture_picture_url` | String | Capture picture URL |
| `lock_time` | String | Lock time, UTC |
| `note` | String | Note |

最小示例 `param`：`{"page_size": 1, "page_index": 1, "device_id": "d1b5a73f8dd84abaa94dcs248be49b0db"}`


### `lock_wakeup` — Lock Wakeup　[写]

唤醒门锁（SIP/蓝牙），用于远程查看/开锁前置。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |
| `wakeup_mode` | String | No | Wakeup mode, sip (default) or bluetooth |

**result**

_无_

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0lv"}`

> 注意：属动作类写命令；本次未测。


### `get_access_device_list` — Get Access Device List　[读]

门禁/门口机设备列表（Multi-tenants Doorphone / Single-tenant Doorphone / Access Control）。

**UAT 实测**：OK：[]。

**param**

_无_

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `device_id` | String | 设备ID |
| `device_name` | String | 设备名 |
| `building_name` | String | 楼栋名 |
| `floor` | String | Floor |
| `residence_no` | String | 房号 |
| `mac` | String | MAC |
| `online` | Boolean | Whether the device is online or not? true: online false: offline |
| `device_type` | String | Device type, Multi-tenants Doorphone or Single-tenant Doorphone or Access Control |

最小示例 `param`：`{}`


### `get_access_device_info` — Get Access Device Information　[读]

查询单个Access Device。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_id` | String | Yes | 设备ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `device_name` | String | 设备名 |
| `building_name` | String | 楼栋名 |
| `floor` | String | Floor |
| `residence_no` | String | 房号 |
| `mac` | String | MAC |
| `online` | Boolean | Whether the device is online or not? true: online false: offline |
| `device_type` | String | Device type, Multi-tenants Doorphone or Single-tenant Doorphone or Access Control |

最小示例 `param`：`{"device_id": "d8b5a73f8dd84abaa94dcs288be49b0cx"}`


##  场景（自动化）（Scene Management）


### `get_scene_list` — Get Scene List　[读]

场景列表（含 enable_auto 自动触发开关）。

**UAT 实测**：OK：[]（当前无场景）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `scene_id` | String | 场景ID |
| `scene_name` | String | 场景名 |
| `enable_auto` | Boolean | Whether the scene automation is enable or not? true: enable false: disable |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_scene_info` — Get Scene Information　[读]

场景详情：triggers + actions。

**UAT 实测**：不存在 id 也返回成功的空壳 `{scene_id:"",scene_name:"",enable:false,triggers:[],actions:[]}`——不要以 success 判定存在。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene_id` | String | Yes | 场景ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `scene_name` | String | 场景名 |
| `triggers` | []Object<trigger> | 触发器列表 |
| `actions` | []Object<action> | 动作列表 |
| `triggers[].trigger_config` | String | Trigger config, see Scene Trigger Config (附录页, 未公开) |
| `triggers[].trigger_type` | String | Trigger type, see Scene Trigger Config (附录页, 未公开) |
| `triggers[].room_tag_id` | String | 房间标签ID |
| `actions[].action_config` | String | Action config, see Scene Action Config (附录页, 未公开) |
| `actions[].ability_type` | String | Ability type |
| `actions[].action_type` | String | Action type, see Scene Action Config (附录页, 未公开) |
| `actions[].attribute` | Object | Attribute, see Standard Device Model (附录页, 未公开) |

最小示例 `param`：`{"scene_id": "s8b5a73f8dd84abaa94dcs248be49b0db"}`

> 注意：实测结果为对象且含 `scene_id`、`enable`（文档未列）。


### `create_scene_info` — Create Scene Information　[写]

创建场景：triggers[]（何时触发）+ actions[]（做什么）。**可把“入住欢迎/退房节能”配置成 GRMS 内自动场景**，PMS 只需推进订单状态。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene_name` | String | Yes | 场景名 |
| `triggers` | []Object<trigger> | Yes | 触发器列表 |
| `actions` | []Object<action> | Yes | 动作列表 |
| `triggers[].trigger_config` | String | Yes | Trigger config, see Scene Trigger Config (附录页, 未公开) |
| `triggers[].trigger_type` | String | Yes | Trigger type, see Scene Trigger Config (附录页, 未公开) |
| `triggers[].room_tag_id` | String | No | 房间标签ID |
| `actions[].action_config` | String | Yes | Action config, see Scene Action Config (附录页, 未公开) |
| `actions[].ability_type` | String | Yes | Ability type |
| `actions[].action_type` | String | Yes | Action type, see Scene Action Config (附录页, 未公开) |
| `actions[].attribute` | Object | No | Attribute, see Standard Device Model (附录页, 未公开) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `scene_id` | String | 场景ID |

最小示例 `param`：`{"scene_name": "test", "triggers": [{"trigger_config": "hotel", "trigger_type": "check_in"}], "actions": [{"action_config": "device", "ability_type": "light", "action_type": "turn_on"}]}`

> 注意：文档唯一示例：trigger `{trigger_config:"hotel",trigger_type:"check_in"}`、action `{action_config:"device",ability_type:"light",action_type:"turn_on"}`。附录未公开，其它取值见 §5。


### `update_scene_info` — Update Scene Information　[写]

更新场景（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene_id` | String | Yes | 场景ID |
| `scene_name` | String | Yes | 场景名 |
| `triggers` | []Object<trigger> | Yes | 触发器列表 |
| `actions` | []Object<action> | Yes | 动作列表 |
| `triggers[].trigger_config` | String | Yes | Trigger config, see Scene Trigger Config (附录页, 未公开) |
| `triggers[].trigger_type` | String | Yes | Trigger type, see Scene Trigger Config (附录页, 未公开) |
| `triggers[].room_tag_id` | String | No | 房间标签ID |
| `actions[].action_config` | String | Yes | Action config, see Scene Action Config (附录页, 未公开) |
| `actions[].ability_type` | String | Yes | Ability type |
| `actions[].action_type` | String | Yes | Action type, see Scene Action Config (附录页, 未公开) |
| `actions[].attribute` | Object | No | Attribute, see Standard Device Model (附录页, 未公开) |

**result**

_无_

最小示例 `param`：`{"scene_id": "sr31adc223cc4b3bedb6bd4742dedcfa5", "scene_name": "test", "triggers": [{"trigger_config": "hotel", "trigger_type": "check_in"}], "actions": [{"action_config": "device", "ability_type": "light", "action_type": "turn_on"}]}`


### `delete_scene_info` — Delete Scene Information　[写]

删除场景。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene_id` | String | Yes | 场景ID |

**result**

_无_

最小示例 `param`：`{"scene_id": "s8b5a73f8dd84abaa94dcs248be49b0db"}`


### `manual_trigger_scene` — Manual Trigger Scene　[写]

对指定房间手动触发场景。**PMS 驱动欢迎/节能的显式方式**（不依赖订单状态触发器）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene_id` | String | Yes | 场景ID |
| `residences` | []Object<residence> | Yes | 房间列表 |
| `residences[].residence_id` | String | Yes | 房间(residence)ID |

**result**

_无_

最小示例 `param`：`{"scene_id": "s3b5a73f8dd84abaa94dcs248be49b0db", "residences": [{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}]}`


### `enable_auto_scene` — Enable Auto Scene　[写]

开关场景的自动触发。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `scene_id` | String | Yes | 场景ID |
| `enable_auto` | Boolean | Yes | Whether the scene automation is enable or not? true: enable false: disable |

**result**

_无_

最小示例 `param`：`{"scene_id": "s3b5a73f8dd84abaa94dcs248be49b0db", "enable_auto": true}`


### `get_scene_history` — Get Scene History　[读]

场景执行历史：是否成功、房间、触发条件、是否手动及操作者。

**UAT 实测**：OK：[]。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `scene_record_id` | String | Scene record ID |
| `scene_id` | String | 场景ID |
| `scene_name` | String | 场景名 |
| `trigger_scene` | Boolean | Whether the scene triggering is successful or not? true: success false: failure |
| `residence_id` | String | 房间(residence)ID |
| `detail` | Object<detail> | Detail information |
| `detail.trigger_config` | String | Trigger config, see Scene Trigger Config (附录页, 未公开) |
| `detail.trigger_type` | String | Trigger type, see Scene Trigger Config (附录页, 未公开) |
| `detail.room_tag_id` | String | 房间标签ID |
| `detail.manual` | Boolean | Whether the scene is manual or not? true: yes false: no |
| `detail.manual_by` | String | Manual by |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


##  门禁卡 / 门禁组（Access Card Management）


### `get_access_card_list` — Get Access Card List　[读]

门禁卡（员工/长期卡，按门禁组授权）列表。

**UAT 实测**：OK：[]。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `access_card_id` | String | 门禁卡ID |
| `access_card_name` | String | 门禁卡名 |
| `phone` | String | 电话 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_access_card_info` — Get Access Card Information　[读]

查询单个门禁卡。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_card_id` | String | Yes | 门禁卡ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `access_card_name` | String | 门禁卡名 |
| `phone` | String | 电话 |
| `rf_card_number` | String | RF卡号 |
| `access_group_id` | String | 门禁组ID |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"access_card_id": "arbr2c4b070cc928496198944858b344f"}`


### `create_access_card_info` — Create Access Card Information　[写]

新建门禁卡。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_card_name` | String | Yes | 门禁卡名 |
| `phone` | String | Yes | 电话 |
| `rf_card_number` | String | Yes | RF卡号 |
| `access_group_id` | String | Yes | 门禁组ID |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `access_card_id` | String | 门禁卡ID |

最小示例 `param`：`{"access_card_name": "test", "phone": "1234567", "rf_card_number": "123456", "access_group_id": "a2a621c1ae77040d697bd2134700f57ea", "start_time": "2025-04-16 13:32:45", "finish_time": "2025-04-17 13:32:45"}`


### `update_access_card_info` — Update Access Card Information　[写]

更新门禁卡（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_card_id` | String | Yes | 门禁卡ID |
| `access_card_name` | String | Yes | 门禁卡名 |
| `phone` | String | Yes | 电话 |
| `rf_card_number` | String | Yes | RF卡号 |
| `access_group_id` | String | Yes | 门禁组ID |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |

**result**

_无_

最小示例 `param`：`{"access_card_id": "a2a621c1ae77040d697bd2134700f57ea", "access_card_name": "test", "phone": "1234567", "rf_card_number": "123456", "access_group_id": "a2a621c1ae77040d697bd2134700f57ea", "start_time": "2025-04-16 13:32:45", "finish_time": "2025-04-17 13:32:45"}`


### `delete_access_card_info` — Delete Access Card Information　[写]

删除门禁卡。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_card_id` | String | Yes | 门禁卡ID |

**result**

_无_

最小示例 `param`：`{"access_card_id": "arbr2c4b070cc928496198944858b344f"}`


### `get_access_group_list` — Get Access Group List　[读]

门禁组列表。

**UAT 实测**：OK：[]。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `access_group_id` | String | 门禁组ID |
| `access_group_name` | String | 门禁组名 |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_access_group_info` — Get Access Group Information　[读]

查询单个门禁组。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_group_id` | String | Yes | 门禁组ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `access_group_name` | String | 门禁组名 |
| `created_time` | String | 创建时间 UTC |
| `residences` | []Object<residence> | 房间列表 |
| `public_access_groups` | []Object<public_access_group> | Public access group information |
| `residences[].residence_id` | String | 房间(residence)ID |
| `public_access_groups[].public_access_group_id` | String | Public access group ID |

最小示例 `param`：`{"access_group_id": "arbr2c4b070cc928496198944858b344f"}`


### `create_access_group_info` — Create Access Group Information　[写]

新建门禁组。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_group_name` | String | Yes | 门禁组名 |
| `residences` | []Object<residence> | Yes | 房间列表 |
| `public_access_groups` | []Object<public_access_group> | Yes | Public access group information |
| `residences[].residence_id` | String | Yes | 房间(residence)ID |
| `public_access_groups[].public_access_group_id` | String | Yes | Public access group ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `access_group_id` | String | 门禁组ID |

最小示例 `param`：`{"access_group_name": "test", "residences": [{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}], "public_access_groups": [{"public_access_group_id": "a31adc223cc4b3bedb6bd4742dedcfa52"}]}`


### `update_access_group_info` — Update Access Group Information　[写]

更新门禁组（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_group_id` | String | Yes | 门禁组ID |
| `access_group_name` | String | Yes | 门禁组名 |
| `residences` | []Object<residence> | Yes | 房间列表 |
| `public_access_groups` | []Object<public_access_group> | Yes | Public access group information |
| `residences[].residence_id` | String | Yes | 房间(residence)ID |
| `public_access_groups[].public_access_group_id` | String | Yes | Public access group ID |

**result**

_无_

最小示例 `param`：`{"access_group_id": "a2a621c1ae77040d697bd2134700f57ea", "access_group_name": "test", "residences": [{"residence_id": "r31adc223cc4b3bedb6bd4742dedcfa52"}], "public_access_groups": [{"public_access_group_id": "a31adc223cc4b3bedb6bd4742dedcfa52"}]}`


### `delete_access_group_info` — Delete Access Group Information　[写]

删除门禁组。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `access_group_id` | String | Yes | 门禁组ID |

**result**

_无_

最小示例 `param`：`{"access_group_id": "arbr2c4b070cc928496198944858b344f"}`


### `get_public_access_group_list` — Get Public Access Group List　[读]

公共区域门禁组列表（系统/自定义，周期规则）。

**UAT 实测**：失败 `20950019 api permission group bind header`（平台侧）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `public_access_group_id` | String | Public access group ID |
| `public_access_group_name` | String | Public access group name |
| `public_access_group_type` | String | Public access group type, system or customized |
| `repeat_mode` | String | Repeat mode, never or daily or weekly |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `available_days` | []String | Available days |
| `user_count` | Integer | User count |
| `created_time` | String | 创建时间 UTC |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


##  告警（Alarm Management）


### `get_alarm_config` — Get Alarm Config　[读]

告警配置（低电量/SOS/烟/CO/燃气/水浸/门未关）。

**UAT 实测**：失败 `20950008 api device bind body`（平台侧）。

**param**

_无_

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `low_power` | Object<low_power> | Low power |
| `sos_alarm` | Object<sos_alarm> | SOS alarm |
| `smoke_alarm` | Object<smoke_alarm> | Smoke alarm |
| `co_alarm` | Object<co_alarm> | CO alarm |
| `gas_alarm` | Object<gas_alarm> | Gas alarm |
| `moist_alarm` | Object<moist_alarm> | Moist alarm |
| `door_open_alarm` | Object<door_open_alarm> | Door open alarm |
| `low_power.record` | Boolean | Whether the record is enable or not? true: enable false: disable |
| `low_power.web_popup` | Boolean | Whether the web popup is enable or not? true: enable false: disable |
| `sos_alarm.record` | Boolean | Whether the record is enable or not? true: enable false: disable |
| `sos_alarm.web_popup` | Boolean | Whether the web popup is enable or not? true: enable false: disable |
| `smoke_alarm.record` | Boolean | Whether the record is enable or not? true: enable false: disable |
| `smoke_alarm.web_popup` | Boolean | Whether the web popup is enable or not? true: enable false: disable |
| `co_alarm.record` | Boolean | Whether the record is enable or not? true: enable false: disable |
| `co_alarm.web_popup` | Boolean | Whether the web popup is enable or not? true: enable false: disable |
| `gas_alarm.record` | Boolean | Whether the record is enable or not? true: enable false: disable |
| `gas_alarm.web_popup` | Boolean | Whether the web popup is enable or not? true: enable false: disable |
| `moist_alarm.record` | Boolean | Whether the record is enable or not? true: enable false: disable |
| `moist_alarm.web_popup` | Boolean | Whether the web popup is enable or not? true: enable false: disable |
| `door_open_alarm.record` | Boolean | Whether the record is enable or not? true: enable false: disable |
| `door_open_alarm.web_popup` | Boolean | Whether the web popup is enable or not? true: enable false: disable |
| `door_open_alarm.only_check_out` | Boolean | Whether the trigger only when check out or not? true: yes false: no |
| `door_open_alarm.duration` | String | Duration, now or 30min or 1h or 2h or 6h or 12h or 24h or 48h |

最小示例 `param`：`{}`


### `update_alarm_config` — Update Alarm Config　[写]

更新告警配置（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `low_power` | Object<low_power> | Yes | Low power |
| `sos_alarm` | Object<sos_alarm> | Yes | SOS alarm |
| `smoke_alarm` | Object<smoke_alarm> | Yes | Smoke alarm |
| `co_alarm` | Object<co_alarm> | Yes | CO alarm |
| `gas_alarm` | Object<gas_alarm> | Yes | Gas alarm |
| `moist_alarm` | Object<moist_alarm> | Yes | Moist alarm |
| `door_open_alarm` | Object<door_open_alarm> | Yes | Door open alarm |
| `low_power.record` | Boolean | Yes | Whether the record is enable or not? true: enable false: disable |
| `low_power.web_popup` | Boolean | Yes | Whether the web popup is enable or not? true: enable false: disable |
| `sos_alarm.record` | Boolean | Yes | Whether the record is enable or not? true: enable false: disable |
| `sos_alarm.web_popup` | Boolean | Yes | Whether the web popup is enable or not? true: enable false: disable |
| `smoke_alarm.record` | Boolean | Yes | Whether the record is enable or not? true: enable false: disable |
| `smoke_alarm.web_popup` | Boolean | Yes | Whether the web popup is enable or not? true: enable false: disable |
| `co_alarm.record` | Boolean | Yes | Whether the record is enable or not? true: enable false: disable |
| `co_alarm.web_popup` | Boolean | Yes | Whether the web popup is enable or not? true: enable false: disable |
| `gas_alarm.record` | Boolean | Yes | Whether the record is enable or not? true: enable false: disable |
| `gas_alarm.web_popup` | Boolean | Yes | Whether the web popup is enable or not? true: enable false: disable |
| `moist_alarm.record` | Boolean | Yes | Whether the record is enable or not? true: enable false: disable |
| `moist_alarm.web_popup` | Boolean | Yes | Whether the web popup is enable or not? true: enable false: disable |
| `door_open_alarm.record` | Boolean | Yes | Whether the record is enable or not? true: enable false: disable |
| `door_open_alarm.web_popup` | Boolean | Yes | Whether the web popup is enable or not? true: enable false: disable |
| `door_open_alarm.only_check_out` | Boolean | Yes | Whether the trigger only when check out or not? true: yes false: no |
| `door_open_alarm.duration` | String | Yes | Duration, now or 30min or 1h or 2h or 6h or 12h or 24h or 48h |

**result**

_无_

最小示例 `param`：`{"low_power": {"record": true, "web_popup": false}, "sos_alarm": {"record": true, "web_popup": false}, "smoke_alarm": {"record": true, "web_popup": false}, "co_alarm": {"record": true, "web_popup": false}, "gas_alarm": {"record": true, "web_popup": false}, "moist_alarm": {"record": true, "web_popup": false}, "door_open_alarm": {"record": true, "web_popup": false, "only_check_out": true, "duration": "now"}}`


### `get_alarm_record_list` — Get Alarm Record List　[读]

告警记录（时间/类型/房间）。**入站轮询告警给 PMS 工单**。

**UAT 实测**：失败 `20950004 api notification bind body`（平台侧）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `alarm_time` | String | 告警时间 UTC |
| `alarm_type` | String | Alarm type, low_power or sos_alarm or smoke_alarm or co_alarm or gas_alarm or moist_alarm or door_open_alarm |
| `residence_id` | String | 房间(residence)ID |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


##  设施（Amenity）与预约（Booking）（Booking Management）


### `get_amenity_type_list` — Get Amenity Type List　[读]

分页列出设施类型。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `amenity_type_id` | String | 设施类型ID |
| `amenity_type_name` | String | 设施类型名 |
| `is_public` | Boolean | Whether the device is public or not? true: yes false: no |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_amenity_type_info` — Get Amenity Type Information　[读]

查询单个设施类型。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_type_id` | String | Yes | 设施类型ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `amenity_type_name` | String | 设施类型名 |
| `is_public` | Boolean | Whether the device is public or not? true: yes false: no |

最小示例 `param`：`{"amenity_type_id": "ax9a621c1ae77040d697bd2134700f57e"}`


### `create_amenity_type_info` — Create Amenity Type Information　[写]

新建设施类型。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_type_name` | String | Yes | 设施类型名 |
| `is_public` | Boolean | Yes | Whether the device is public or not? true: yes false: no |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `amenity_type_id` | String | 设施类型ID |

最小示例 `param`：`{"amenity_type_name": "test", "is_public": true}`


### `update_amenity_type_info` — Update Amenity Type Information　[写]

更新设施类型（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_type_id` | String | Yes | 设施类型ID |
| `amenity_type_name` | String | Yes | 设施类型名 |
| `is_public` | Boolean | Yes | Whether the device is public or not? true: yes false: no |

**result**

_无_

最小示例 `param`：`{"amenity_type_id": "a2a621c1ae77040d697bd2134700f57ea", "amenity_type_name": "test", "is_public": true}`


### `delete_amenity_type_info` — Delete Amenity Type Information　[写]

删除设施类型。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_type_id` | String | Yes | 设施类型ID |

**result**

_无_

最小示例 `param`：`{"amenity_type_id": "a2a621c1ae77040d697bd2134700f57ea"}`


### `get_amenity_list` — Get Amenity List　[读]

分页列出设施。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `amenity_id` | String | 设施ID |
| `amenity_name` | String | 设施名 |
| `amenity_type_id` | String | 设施类型ID |
| `amenity_type_name` | String | 设施类型名 |
| `amenity_description` | String | Amenity description |
| `amenity_picture_url` | String | Amenity picture URL |
| `devices` | []Object<device> | 设备信息 |
| `enable` | Boolean | Whether the amenity is enable or not? true: enable false: disable |
| `contact` | String | Contact |
| `contact_information` | String | Contact information |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `available_days` | []String | Available days |
| `maximum_duration` | Integer | Maximum duration (min) |
| `maximum_advance` | Integer | Maximum advance (d) |
| `maximum_reservation` | Integer | Maximum reservation |
| `maximum_password_count` | Integer | Maximum password count |
| `require_approval` | Boolean | Whether the amenity requires approval or not? true: require false: not require |
| `allow_guest_booking` | Boolean | Whether the guest allowed booking or not? true: allowed false: not allowed |
| `fee_type` | String | Fee type, time or people or time and people |
| `fee` | String | Fee |
| `devices[].mac` | String | MAC |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_amenity_info` — Get Amenity Information　[读]

查询单个设施。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_id` | String | Yes | 设施ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `amenity_name` | String | 设施名 |
| `amenity_type_id` | String | 设施类型ID |
| `amenity_type_name` | String | 设施类型名 |
| `amenity_description` | String | Amenity description |
| `amenity_picture_url` | String | Amenity picture URL |
| `devices` | []Object<device> | 设备信息 |
| `enable` | Boolean | Whether the amenity is enable or not? true: enable false: disable |
| `contact` | String | Contact |
| `contact_information` | String | Contact information |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `available_days` | []String | Available days |
| `maximum_duration` | Integer | Maximum duration (min) |
| `maximum_advance` | Integer | Maximum advance (d) |
| `maximum_reservation` | Integer | Maximum reservation |
| `maximum_password_count` | Integer | Maximum password count |
| `require_approval` | Boolean | Whether the amenity requires approval or not? true: require false: not require |
| `allow_guest_booking` | Boolean | Whether the guest allowed booking or not? true: allowed false: not allowed |
| `fee_type` | String | Fee type, time or people or time and people |
| `fee` | String | Fee |
| `devices[].mac` | String | MAC |

最小示例 `param`：`{"amenity_id": "afa332e258aae1badbb27d31128f442dc"}`


### `get_creating_amenity_list` — Get Creating Amenity List　[读]

分页列出Creating Amenity。

**param**

_无_

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `devices` | []Object<device> | 设备信息 |
| `devices[].mac` | String | MAC |
| `devices[].device_name` | String | 设备名 |

最小示例 `param`：`{}`


### `create_amenity_info` — Create Amenity Information　[写]

新建设施。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_name` | String | Yes | 设施名 |
| `amenity_type_id` | String | Yes | 设施类型ID |
| `amenity_description` | String | Yes | Amenity description |
| `amenity_picture_url` | String | Yes | Amenity picture URL |
| `devices` | []Object<device> | Yes | 设备信息 |
| `enable` | Boolean | Yes | Whether the amenity is enable or not? true: enable false: disable |
| `contact` | String | Yes | Contact |
| `contact_information` | String | Yes | Contact information |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |
| `available_days` | []String | Yes | Available days |
| `maximum_duration` | Integer | Yes | Maximum duration (min) |
| `maximum_advance` | Integer | Yes | Maximum advance (d) |
| `maximum_reservation` | Integer | Yes | Maximum reservation |
| `maximum_password_count` | Integer | Yes | Maximum password count |
| `require_approval` | Boolean | Yes | Whether the amenity requires approval or not? true: require false: not require |
| `allow_guest_booking` | Boolean | Yes | Whether the guest allowed booking or not? true: allowed false: not allowed |
| `fee_type` | String | Yes | Fee type, time or people or time and people |
| `fee` | String | Yes | Fee |
| `devices[].mac` | String | Yes | MAC |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `amenity_id` | String | 设施ID |

最小示例 `param`：`{"amenity_name": "Gym", "amenity_type_id": "a2a621c1ae77040d697bd2134700f57ea", "amenity_description": "test", "amenity_picture_url": "https://test.akubela.com/g", "devices": [{"mac": "C10519082089"}], "enable": true, "contact": "test", "contact_information": "1234567", "start_time": "13:14", "finish_time": "15:14", "available_days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], "maximum_duration": 30, "maximum_advance": 1, "maximum_reservation": 1, "maximum_password_count": 20, "require_approval": true, "allow_guest_booking": true, "fee_type": "time", "fee": "100"}`


### `update_amenity_info` — Update Amenity Information　[写]

更新设施（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_id` | String | Yes | 设施ID |
| `amenity_type_id` | String | Yes | 设施类型ID |
| `amenity_name` | String | Yes | 设施名 |
| `amenity_description` | String | Yes | Amenity description |
| `amenity_picture_url` | String | Yes | Amenity picture URL |
| `devices` | []Object<device> | Yes | 设备信息 |
| `enable` | Boolean | Yes | Whether the amenity is enable or not? true: enable false: disable |
| `contact` | String | Yes | Contact |
| `contact_information` | String | Yes | Contact information |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |
| `available_days` | []String | Yes | Available days |
| `maximum_duration` | Integer | Yes | Maximum duration (min) |
| `maximum_advance` | Integer | Yes | Maximum advance (d) |
| `maximum_reservation` | Integer | Yes | Maximum reservation |
| `maximum_password_count` | Integer | Yes | Maximum password count |
| `require_approval` | Boolean | Yes | Whether the amenity requires approval or not? true: require false: not require |
| `allow_guest_booking` | Boolean | Yes | Whether the guest allowed booking or not? true: allowed false: not allowed |
| `fee_type` | String | Yes | Fee type, time or people or time and people |
| `fee` | String | Yes | Fee |
| `devices[].mac` | String | Yes | MAC |

**result**

_无_

最小示例 `param`：`{"amenity_id": "abafa332e258aae1badbb27d31128f442", "amenity_type_id": "a2a621c1ae77040d697bd2134700f57ea", "amenity_name": "Gym", "amenity_description": "test", "amenity_picture_url": "https://test.akubela.com/g", "devices": [{"mac": "C10519082089"}], "enable": true, "contact": "test", "contact_information": "1234567", "start_time": "13:14", "finish_time": "15:14", "available_days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], "maximum_duration": 30, "maximum_advance": 1, "maximum_reservation": 1, "maximum_password_count": 20, "require_approval": true, "allow_guest_booking": true, "fee_type": "time", "fee": "100"}`


### `delete_amenity_info` — Delete Amenity Information　[写]

删除设施。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_id` | String | Yes | 设施ID |

**result**

_无_

最小示例 `param`：`{"amenity_id": "a8b5a73f8dd84abaa94dcs248be49b0d1"}`


### `enable_amenity` — Enable Amenity　[写]

启用/停用设施。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_id` | String | Yes | 设施ID |
| `enable` | Boolean | Yes | Whether the amenity is enable or not? true: enable false: disable |

**result**

_无_

最小示例 `param`：`{"amenity_id": "afa332e258aae1badbb27d31128f442dc", "enable": true}`


### `get_booking_list` — Get Booking List　[读]

分页列出设施预约。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `booking_id` | String | 预约ID |
| `amenity_id` | String | 设施ID |
| `amenity_name` | String | 设施名 |
| `amenity_type_id` | String | 设施类型ID |
| `amenity_type_name` | String | 设施类型名 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `state` | String | State, pending or rejected or canceled or success |
| `is_expired` | Boolean | Whether the booking is expired or not? true: yes false: no |
| `pin_code` | String | PIN码 |
| `qr_code_url` | String | 二维码URL |
| `created_time` | String | 创建时间 UTC |
| `guest_name` | String | 住客姓名 |
| `member_id` | String | 会员ID |
| `number` | Integer | 人数 |

最小示例 `param`：`{"page_size": 1, "page_index": 1}`


### `get_booking_info` — Get Booking Information　[读]

查询单个设施预约。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `booking_id` | String | Yes | 预约ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `amenity_id` | String | 设施ID |
| `amenity_name` | String | 设施名 |
| `amenity_type_id` | String | 设施类型ID |
| `amenity_type_name` | String | 设施类型名 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `state` | String | State, pending or rejected or canceled or success |
| `is_expired` | Boolean | Whether the booking is expired or not? true: yes false: no |
| `pin_code` | String | PIN码 |
| `qr_code_url` | String | 二维码URL |
| `created_time` | String | 创建时间 UTC |
| `guest_name` | String | 住客姓名 |
| `member_id` | String | 会员ID |
| `number` | Integer | 人数 |

最小示例 `param`：`{"booking_id": "b31adc223cc4b3bedb6bd4742dedcfa52"}`


### `create_booking_info` — Create Booking Information　[写]

新建设施预约。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `amenity_id` | String | Yes | 设施ID |
| `start_time` | String | Yes | 开始时间 UTC |
| `finish_time` | String | Yes | 结束时间 UTC |
| `person_count` | Integer | Yes | 人数 |
| `guest_name` | String | Yes | 住客姓名 |
| `email` | String | Yes | 邮箱 |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `booking_id` | String | 预约ID |

最小示例 `param`：`{"amenity_id": "afa332e258aae1badbb27d31128f442dc", "start_time": "2025-01-02 13:14:15", "finish_time": "2025-01-02 15:14:15", "person_count": 3, "guest_name": "test", "email": "test@akubela.com"}`


### `update_booking_info` — Update Booking Information　[写]

更新设施预约（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `booking_id` | String | Yes | 预约ID |
| `state` | String | Yes | State, rejected or success |

**result**

_无_

最小示例 `param`：`{"booking_id": "bfa332e258aae1badbb27d31128f442dc", "state": "rejected"}`


### `delete_booking_info` — Delete Booking Information　[写]

删除设施预约。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `booking_id` | String | Yes | 预约ID |

**result**

_无_

最小示例 `param`：`{"booking_id": "b8b5a73f8dd84abaa94dcs248be49b0d1"}`


### `get_member_booking_list` — Get Member Booking List　[读]

分页列出会员的预约。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page_size` | Integer | Yes | 每页条数(1..500) |
| `page_index` | Integer | Yes | 页码(从1开始) |
| `member_id` | String | Yes | 会员ID |

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `booking_id` | String | 预约ID |
| `amenity_id` | String | 设施ID |
| `amenity_name` | String | 设施名 |
| `amenity_type_id` | String | 设施类型ID |
| `amenity_type_name` | String | 设施类型名 |
| `start_time` | String | 开始时间 UTC |
| `finish_time` | String | 结束时间 UTC |
| `state` | String | State, pending or rejected or canceled or success |
| `is_expired` | Boolean | Whether the booking is expired or not? true: yes false: no |
| `pin_code` | String | PIN码 |
| `qr_code_url` | String | 二维码URL |
| `created_time` | String | 创建时间 UTC |
| `number` | Integer | 人数 |

最小示例 `param`：`{"page_size": 1, "page_index": 1, "member_id": "mgrm31adc223cc4b3bedb6bd4742dedcf"}`


##  通知订阅（Listen Config）（Notice Management）


### `get_listen_config` — Get Listen Config　[读]

查询已开启的通知订阅类别（Hotel 级只有 `booking`）。

**UAT 实测**：OK：`{"listen_list":[""]}`（空串元素）。

**param**

_无_

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `listen_list` | []String | Listen list booking: listen notice of changes in booking |

最小示例 `param`：`{}`

> 注意：文档未说明回调地址/推送协议（Manager 级另有 maintenance、alarm）；视为需向厂商确认，设计上以轮询为主。


### `turn_on_listen_config` — Turn on Listen Config　[写]

开启通知订阅功能。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `listen_list` | []String | Yes | Turn on listen list booking: listen notice of changes in booking |

**result**

_无_

最小示例 `param`：`{"listen_list": ["booking"]}`


### `turn_off_listen_config` — Turn off Listen Config　[写]

关闭通知订阅功能。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `listen_list` | []String | Yes | Turn off listen list booking: listen notice of changes in booking |

**result**

_无_

最小示例 `param`：`{"listen_list": ["booking"]}`


##  项目信息 / 币种（Project Management）


### `get_project_info` — Get Project Information　[读]

项目信息 + 房态/设备统计（to_stay/checked_out/dirty/vacant_dirty/occupied_dirty/dnd/…）。

**UAT 实测**：失败 `24400347 api get project timezone bind header`（疑似项目未配置时区；加 Timezone 类请求头无效）。

**param**

_无_

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `project_id` | String | 项目ID |
| `project_name` | String | 项目名 |
| `currency` | String | 币种 |
| `visit_url` | String | Visit URL |
| `address` | Object<address> | Address |
| `room` | Object<room> | Room information |
| `device` | Object<device> | 设备信息 |
| `address.country` | String | Country |
| `address.state_province` | String | State or province |
| `address.city` | String | City |
| `address.street` | String | Street |
| `address.postcode` | String | Postcode |
| `room.to_stay` | Integer | To stay |
| `room.checked_out` | Integer | Checked out |
| `room.dirty` | Integer | 脏房 |
| `room.vacant_dirty` | Integer | Vacant dirty |
| `room.occupied_dirty` | Integer | Occupied dirty |
| `room.vacant_clean` | Integer | Vacant clean |
| `room.occupied_clean` | Integer | Occupied clean |
| `room.dnd` | Integer | DND |
| `room.vacant_today` | Integer | Vacant today |
| `room.checked_in_today` | Integer | Checked in today |
| `room.number_of_staying_today` | Integer | Number of staying today |
| `room.occupancy_rate_today` | Integer | Occupancy rate today |
| `device.total` | Integer | Total |
| `device.online` | Integer | Online |
| `device.offline` | Integer | Offline |
| `device.low_power` | Integer | Low power |

最小示例 `param`：`{}`


### `update_project_info` — Update Project Information　[写]

更新项目（整体覆盖：文档标 Yes 的字段都要带全，先 get 再改）。

**param**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `currency` | String | Yes | 币种 |

**result**

_无_

最小示例 `param`：`{"currency": "USD:US Dollar"}`


### `get_currency_list` — Get Currency List　[读]

币种列表。

**UAT 实测**：OK（全球币种名）。

**param**

_无_

**result**

| 字段 | 类型 | 说明 |
|---|---|---|
| `(array)` | []Object | 返回数组，元素字段见下 |
| `currency` | String | 币种 |

最小示例 `param`：`{}`

