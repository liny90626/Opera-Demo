# 05 · 部署方案教程

本项目的 PMS 引擎（`packages/core`）是纯 TypeScript，可以运行在两种形态下：

| 形态 | 后端在哪里 | 适用场景 | 多人/多设备共享数据 |
|---|---|---|---|
| **A. 纯静态（浏览器内引擎）** | 用户浏览器内 | 演示、学习、零服务器成本 | ❌ 每个浏览器各自一份数据（同浏览器多标签页实时同步） |
| **B. Node 后端（前后端分离运行在一台服务器）** | Express 服务 | 多人同时演示、对接外部系统调用 OHIP 风格接口 | ✅ 所有客户端经 SSE 实时同步同一份数据 |

下面给出 5 种部署方式，按上手难度排序。

---

## 0. 环境要求

- Node.js **20 或以上**（推荐 22 LTS），npm 10+。
- 仅方案 4 需要 Docker。
- 获取代码：`git clone https://github.com/liny90626/Opera-Demo.git`，或解压交付的 `Opera-Demo-v1.0.zip`。

本地快速验证：

```bash
npm ci            # 安装依赖（首次）
npm test          # 引擎 / OHIP façade / 服务端 SSE 测试，应全部通过
npm run dev       # 后端 :3001 + 前端 :5173，浏览器打开 http://localhost:5173
```

---

## 方案 1：GitHub Pages（形态 A，自动部署已停用）

> 自动部署已停用，仓库里已没有 GitHub Actions 工作流。要恢复，从 git 历史找回原 `.github/workflows/pages.yml`（含 `npm run build:pages` 和 `peaceiris/actions-gh-pages` 发布到 `gh-pages` 的步骤），再按下面的步骤开启。

**一次性开启：**
1. 打开 GitHub 仓库 → **Settings → Pages**。
2. *Build and deployment* → Source 选 **Deploy from a branch**。
3. Branch 选 **`gh-pages`**，目录 **`/ (root)`**，点 **Save**。
4. 约 1 分钟后访问 `https://<你的用户名>.github.io/Opera-Demo/`。

> 之后无需任何操作，推送即发布。Actions 页面可查看每次构建；最后一步 “Check live URL” 会打印线上地址的 HTTP 状态码（200 即成功）。
> 若仓库改名或 fork 到别的账号，无需修改配置（构建使用相对路径 `--base=./`）。

---

## 方案 2：任意静态托管（形态 A：Nginx / 对象存储 / CDN / Vercel / Netlify）

```bash
npm ci
npm run build:pages          # 产物在 apps/web/dist/，纯静态文件
```

把 `apps/web/dist/` 整个目录上传即可。说明：
- 使用 Hash 路由（`#/...`），**无需**配置 SPA 回退规则。
- 资源为相对路径，可部署在任意子目录。
- Nginx 示例：

```nginx
server {
  listen 80;
  server_name demo.example.com;
  root /var/www/opera-demo;      # = apps/web/dist 的内容
  index index.html;
  location /assets/ { expires 30d; add_header Cache-Control "public, immutable"; }
}
```

- 阿里云 OSS / 腾讯云 COS：开启“静态网站托管”，默认首页 `index.html`，上传 `dist` 内容即可。

---

## 方案 3：Linux 服务器直接运行 Node 后端（形态 B，推荐用于多人演示）

### 3.1 安装与启动

```bash
# 以 Ubuntu 为例，安装 Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone https://github.com/liny90626/Opera-Demo.git /opt/opera-demo
cd /opt/opera-demo
npm ci
npm run build                 # 构建前端（连接后端模式），输出 apps/web/dist
PORT=3001 npm run start:server
# 浏览器访问 http://<服务器IP>:3001/
```

同一端口同时提供：UI 页面、`/api/*`（命令 + SSE 实时流）、OHIP 风格接口（`/oauth/v1`、`/hsk/v1`、`/fof/v1`、`/csh/v1`）。

### 3.2 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3001` | 监听端口 |
| `DATA_FILE` | `apps/server/data/state.json` | 数据落盘文件（变更后 0.5s 防抖写入；重启后恢复）。删除该文件 = 恢复初始演示数据 |
| `AKUBELA_MODE` | 有凭据则 `real`，否则 `sim` | Akubela GRMS 对接模式：`real` / `sim` / `off`（详见 [09](09-akubela-integration-guide.md)） |
| `AKUBELA_BASE_URL` | `https://api.cbcloud.uat.akubela.com` | GRMS OpenAPI 网关 |
| `AKUBELA_CLIENT_ID` / `AKUBELA_CLIENT_SECRET` | — | GRMS 客户端凭据（仅服务端，切勿提交到仓库；可写入被 git 忽略的 `.env`） |
| `AKUBELA_ROOM_MAP` | 空 | 房间映射 `OPERA房号:GRMS房号,...`，如 `201:101` |
| `AKUBELA_HOTEL_TZ` / `AKUBELA_POLL_SECONDS` | `Asia/Shanghai` / `20` | 酒店时区、GRMS 轮询周期（秒） |

> 服务启动时会读取仓库根目录的 `.env`（已有的环境变量优先）。参考 `.env.example`。
> 若服务器出网需经 HTTP 代理，Node 22 需设置 `NODE_USE_ENV_PROXY=1`（并按需 `NODE_EXTRA_CA_CERTS`）才能让内置 fetch 走 `HTTPS_PROXY`。

### 3.3 用 systemd 守护进程

`/etc/systemd/system/opera-demo.service`：

```ini
[Unit]
Description=OPERA room-status demo
After=network.target

[Service]
WorkingDirectory=/opt/opera-demo
Environment=PORT=3001
Environment=DATA_FILE=/var/lib/opera-demo/state.json
ExecStart=/usr/bin/npm run start:server
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/opera-demo && sudo chown www-data /var/lib/opera-demo
sudo systemctl daemon-reload && sudo systemctl enable --now opera-demo
journalctl -u opera-demo -f      # 查看日志
```

（也可用 pm2：`pm2 start "npm run start:server" --name opera-demo && pm2 save`）

### 3.4 Nginx 反向代理 + HTTPS（注意 SSE 配置）

实时同步依赖 **SSE 长连接**（`/api/stream`），反向代理必须关闭缓冲、拉长超时：

```nginx
server {
  listen 443 ssl http2;
  server_name pms-demo.example.com;
  ssl_certificate     /etc/letsencrypt/live/pms-demo.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/pms-demo.example.com/privkey.pem;

  location /api/stream {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;              # 关键：否则实时推送会被缓存
    proxy_cache off;
    proxy_read_timeout 1h;
  }
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

HTTPS 证书可用 `certbot --nginx -d pms-demo.example.com` 自动申请。

### 3.5 升级

```bash
cd /opt/opera-demo && git pull && npm ci && npm run build && sudo systemctl restart opera-demo
```

---

## 方案 4：Docker（形态 B）

仓库根目录已提供 `Dockerfile`。

```bash
docker build -t opera-demo .
docker run -d --name opera-demo -p 3001:3001 -v opera-demo-data:/data --restart unless-stopped opera-demo
# 访问 http://<主机>:3001/
```

- 数据保存在卷 `opera-demo-data`（容器内 `/data/state.json`）。重置数据：`docker exec opera-demo rm /data/state.json && docker restart opera-demo`，或在 UI 的 *End of Day → Reset Demo* 操作。
- 反向代理配置同 3.4。
- docker-compose 示例：

```yaml
services:
  opera-demo:
    build: .
    ports: ["3001:3001"]
    volumes: ["opera-demo-data:/data"]
    restart: unless-stopped
volumes:
  opera-demo-data:
```

---

## 方案 5：GitHub Codespaces（形态 B，零服务器的临时远程环境）

仓库已带 `.devcontainer/devcontainer.json`：
1. GitHub 仓库页 → **Code → Codespaces → Create codespace on main**（或直接打开 <https://codespaces.new/liny90626/Opera-Demo>）。
2. 首次创建自动 `npm ci && npm run build`；每次 Codespace 启动（`postStartCommand`）都会在后台自动启动后端（3001 端口，日志 `/tmp/opera-demo/server.log`），并转发 3001。
3. 在 **Ports** 面板把 3001 的 Visibility 改为 **Public**，即可把链接发给他人访问（见下节，这也是在线演示接入所必需的一步）。

> Codespaces 有免费额度且闲置会自动休眠（再次打开会自动重启后端），适合临时演示。

---

## 5b. 在线演示连接真实 UAT

GitHub Pages 上的在线演示是纯静态页面（引擎跑在浏览器里）。它**不能直接调用 Akubela 网关**（网关不返回 CORS 头，浏览器会拦截），也**不能存放密钥**。解决办法：让页面附着到一个持有凭据的 Node 后端（本仓库的 `apps/server`），由后端去连 UAT。

**一次性准备**：GitHub → Settings → Codespaces → **Secrets** → New secret，添加 `AKUBELA_CLIENT_ID`、`AKUBELA_CLIENT_SECRET`，并在 *Repository access* 中勾选本仓库（Codespaces 会把它们自动注入为环境变量；服务端检测到两者即默认进入"真实 UAT"模式，无需 `.env`）。

**每次演示**：
1. 打开 <https://codespaces.new/liny90626/Opera-Demo>，创建/恢复 Codespace，等待 `postStartCommand` 启动后端（终端或 Ports 面板出现 3001）。
2. 在 **Ports** 面板里把 3001 的 Visibility 设为 **Public**（`devcontainer.json` 的 `portsAttributes` 目前不支持设置 visibility，这是唯一需要手动的一步）。
3. 复制 3001 的转发地址，形如 `https://<codespace>-3001.app.github.dev`（可 `curl <地址>/api/health` 自测）。
4. 打开 `https://liny90626.github.io/Opera-Demo/?backend=<该地址>`；或在页面 **集成 › Akubela 客控云** 点 **Connect backend** 粘贴地址（会保存到浏览器 localStorage `opera-demo/backend-url`，下次自动使用；清除即恢复浏览器内引擎）。
5. 页面右上角显示"后端：Node 服务"即成功；若地址不可达（3 秒超时），会自动回退到浏览器内引擎并提示原因。

说明：服务端对跨域 UI 已开放 CORS（含 `/api/stream` SSE 与 PUT/POST JSON 预检）；后端是共享状态，凭据始终只在服务端。同一套 Akubela 凭据只允许一个服务实例持有有效令牌，请勿同时在多处运行。

---

## 6. 前端连接哪个后端？

| 方式 | 说明 |
|---|---|
| 构建时 `VITE_BACKEND=local`（`npm run build:pages`） | 固定使用浏览器内引擎 |
| 默认构建（`npm run build`） | 先探测同源 `/api/health`，可达则连 Node 后端，不可达自动回退浏览器内引擎 |
| URL 参数 `?backend=local` / `?backend=http` | 临时强制切换（如 `https://host/?backend=local#/`） |
| URL 参数 `?backend=https://host` 或 localStorage `opera-demo/backend-url` | 附着到远程 Node 后端（先探测 `/api/health`，3 秒超时，失败回退浏览器内引擎），见 5b |

页面右上角会显示当前形态：「后端：Node 服务」或「后端：浏览器内引擎」。

---

## 7. OHIP 风格接口快速验证（形态 B）

```bash
H=http://localhost:3001
TOKEN=$(curl -s -X POST $H/oauth/v1/tokens -H 'x-app-key: demo' -H 'content-type: application/json' \
        -d '{"grant_type":"client_credentials"}' | sed -E 's/.*"access_token":"([^"]+)".*/\1/')

# 房态概览（类 Housekeeping Board）
curl -s "$H/hsk/v1/hotels/DEMO1/housekeepingOverview?housekeepingRoomStatus=Dirty&limit=3" \
  -H "Authorization: Bearer $TOKEN" -H 'x-app-key: demo' -H 'x-hotelid: DEMO1'

# 外部系统回写房态 → UI 实时变化 + 产生业务事件
curl -s -X PUT $H/hsk/v1/hotels/DEMO1/rooms/status \
  -H "Authorization: Bearer $TOKEN" -H 'x-app-key: demo' -H 'x-hotelid: DEMO1' -H 'content-type: application/json' \
  -d '{"roomList":[{"roomId":"305"}],"housekeepingRoomStatus":"Clean"}'

# 轮询业务事件（模拟 OHIP Polling API）
curl -s "$H/api/events?sinceSeq=0"
```

完整端点表见 [02-functional-design.md §8.7](02-functional-design.md)，运行时也可 `GET /api/ohip-routes` 查看。

---

## 8. 后续对接真实协议的扩展点（供下一阶段迭代）

当贵方的接口协议确定后，建议按以下位置改造，前端无需大改：

| 需求 | 改动位置 |
|---|---|
| 调整/新增 OHIP 风格接口（路径、字段、鉴权） | `packages/core/src/ohip.ts`（路由表 + 请求/响应映射）；测试 `packages/core/test/ohip.test.ts` |
| 新的业务动作或规则 | `packages/core/src/types.ts` 的 `Command` 联合类型 + `engine.ts` 的 `apply()` |
| 业务事件命名/载荷对齐真实 Business Events | `packages/core/src/events.ts`、`engine.ts` 中 `emit()` |
| 推送到真实外部系统（Webhook/MQ） | `packages/core/src/sync.ts` 的 `attemptDelivery()`（当前为模拟投递），或在 `apps/server/src/app.ts` 的 `broadcast()` 中追加出站推送 |
| 接入真实 OPERA/OHIP（PMS 不再自建） | 在 `apps/server` 新增适配器：入站调用真实 OHIP REST，订阅其 Streaming/Polling 事件后转换为 `ChangeSet` 推给前端 |
| 持久化换成数据库 | `apps/server/src/app.ts` 的 `persist()` / 启动加载逻辑 |
| 鉴权 | `apps/server/src/app.ts` 增加中间件；`ohip.ts` 的头校验 |

---

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| 页面一直显示“连接中/离线” | Node 形态下检查反向代理是否按 3.4 关闭了 `proxy_buffering`；防火墙放行端口 |
| 想恢复初始演示数据 | UI：*其他 → 夜审与参数 → Reset Demo*；或删除 `DATA_FILE`；浏览器形态也可清除站点 localStorage |
| GitHub Pages 打开 404 | 确认已按方案 1 开启 Pages 且分支为 `gh-pages`；查看 Actions 是否成功 |
| 两台电脑看到的数据不一样 | 纯静态形态下数据保存在各自浏览器，属预期；需要共享请用形态 B |
| 业务日期显示为“今天” | 首次加载时以当天为业务日期生成演示数据；执行 End of Day 推进日期 |
