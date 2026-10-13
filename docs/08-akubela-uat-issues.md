# 08 · Akubela GRMS OpenAPI — UAT 问题报告（可直接转交 Akubela）

**环境**：UAT，`https://api.cbcloud.uat.akubela.com`（`grms.cbcloud.uat.akubela.com` 现象相同）
**项目**：TMG-环境（project_id `pca6afbefb34248ab8e6286f30c65845e`，时区 Asia/Shanghai，控制台配置正常）
**客户端**：Hotel Function API，`client_credentials`，`scope=hotel`（client_id `cd43…2c5f5`）
**文档版本**：V4.1（与 V4.0 文档内容一致）
**时间**：2026-10-13（UTC 14:00 前后），时间戳见下表

## 1. 结论

鉴权与大部分只读接口正常；**涉及房间详情、房态写入、订单创建/详情、项目信息、告警等接口在网关转发到后端服务时失败**，错误为 `api … bind body` / `bind header`。证据表明请求体格式正确：

1. `get_room_info` 传**不存在**的 residence_id 时返回业务错误 `20017608 check residence id exists`（说明请求被正确解析）；传**真实** residence_id 时反而返回 `20950001 api room bind body`。
2. `create_order_info` 通过网关校验（时间早于当前会正确返回 `50105580`），但订单服务返回 `20950005 api order bind body`——**即使 residence_id 不存在也同样报错**，说明在业务处理之前就失败了。
3. `get_project_info` 明确报 `24400347 api get project timezone bind header`。

推测：开放网关（open-ability）转发至房间/订单/告警等服务时，缺少后端所需的 Header（如项目时区 timezone / project 上下文），导致下游 binding 失败。请 Akubela 后端排查网关→服务的 Header 透传，或告知需额外携带的 Header。

## 2. 失败接口明细

| 命令 | 参数（摘要） | 返回码 | message | trace_id | timestamp |
|---|---|---|---|---|---|
| get_room_info | residence_id=`rf9f07a99092443c8bf09c2ddc2a51da0`（101） | 20950001 | api room bind body | de38bd19c72cc46c8d65fe01882590e0 | 1791901661647 |
| update_room_state | 同上, dirty=false | 20950001 | api room bind body | 7370b5ebb2ae64d5bd72fbabfa30f29c | 1791901583261 |
| create_order_info | residence 101，start=now+5min，全部字段非空 | 20950005 | api order bind body | f3b0ec97cf7b585e42c49749d1af5fcf | — |
| create_order_info | residence_id 不存在 | 20950005 | api order bind body | 0dea2e10236491e586219798841c5b61 | — |
| get_project_info | {} | 24400347 | api get project timezone bind header | ce17c8ecb15ca6adebda78538ca07336 | 1791901699088 |
| get_staff_list | page_size=5,page_index=1 | 20950000 | api rms bind body | a0e890bbb1e1b5334dc5589ba1c79087 | 1791901678277 |
| get_alarm_config | {} | 20950008 | api device bind body | 66154dc945fd508b2280ecbb291f4d8c | 1791901689387 |
| get_alarm_record_list | page_size=5,page_index=1 | 20950004 | api notification bind body | 2da7fcb1523e4e34286f43bc39cc6e56 | 1791901690667 |
| get_public_access_group_list | page_size=5,page_index=1 | 20950019 | api permission group bind header | 629a8e4aa9edde483593b4069e5b9a4c | 1791901686349 |

正常接口（同一令牌）：get_room_list、get_room_type_list/info、get_room_tag_list、get_authorization_record_list、get_order_list、get_guest_list、get_member_list、get_device_list/info、get_access_device_list、get_access_card_list、get_access_group_list、get_scene_list、get_listen_config、get_amenity_type_list、get_amenity_list、get_booking_list、get_currency_list。

## 3. 复现方式

```bash
BASE=https://api.cbcloud.uat.akubela.com
TOKEN=$(curl -s -X POST $BASE/api/v1.0/invoke/open-ability/method/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' -H 'Accept: application/json' \
  --data "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&scope=hotel" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["access_token"])')

curl -s -X POST $BASE/api/v1.0/invoke/open-ability/method/hotel-commands \
  -H 'Content-Type: application/json' -H 'Accept: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"command":"get_room_info","id":"c45e846ca23ab42c9ae469d988ae32a96","param":{"residence_id":"rf9f07a99092443c8bf09c2ddc2a51da0"}}'
# => {"success":false,"result":{"code":20950001,"message":"api room bind body",...}}

curl -s -X POST $BASE/api/v1.0/invoke/open-ability/method/hotel-commands \
  -H 'Content-Type: application/json' -H 'Accept: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"command":"create_order_info","id":"c45e846ca23ab42c9ae469d988ae32a96","param":{"residence_id":"rf9f07a99092443c8bf09c2ddc2a51da0","start_time":"<UTC now+5min>","finish_time":"<UTC now+1day>","source":"SaaS","remark":"x","enable_booking":false,"guest":{"guest_name":"Probe Guest","email":"probe@example.com","phone":"13800000000","id_card":"350200199001010000","passport":"E12345678"}}}'
# => {"success":false,"result":{"code":20950005,"message":"api order bind body",...}}
```

本仓库也提供一键回归脚本：`npm run akubela:verify`（只读）/ `npm run akubela:verify -- --write`（含订单写入全流程）。

## 4. 文档层面的问题（建议 Akubela 补充）

1. 文档未给出各环境的 **Base URL**（实测 `api.cbcloud.uat.akubela.com`）。
2. `create_order_info` 示例中 `remark`、`passport` 为空字符串，但网关将空字符串视为缺失（`50104080`）；应说明哪些字段允许为空，或接受空串。
3. 未说明 `start_time` 不得早于当前时间（`50105580`），以及时区约定（字段说明为 UTC）。
4. 未提供 Webhook/推送：`Notice Management` 仅支持 `booking`，房态/订单/告警变化需轮询——建议提供房态与订单变更的推送。
5. 无 OOO/维护（`maintenance_status`）与 MUR 的写接口；`update_order_info` 不支持换房（修改 residence_id）。
6. 文档链接重定向到 `http://`（301），HTTPS 代理环境下需手动加尾部 `/`。
