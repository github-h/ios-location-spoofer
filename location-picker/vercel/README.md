# Location Picker — Vercel

与 `../worker/`（Cloudflare Worker 版）**接口和行为完全一致**，只是部署在 Vercel 上：免 VPS、自带 HTTPS，支持 **Loon / Shadowrocket / Surge** 的 `configUrl`。

- 运行时：Vercel **Edge Function**（单函数，`api/[[...path]].js`）
- 存储：**Upstash Redis**（Vercel Marketplace 一键集成，原 Vercel KV），代码纯 `fetch` 调 REST，零 npm 依赖
- 对外契约与 Worker 版逐行对应，改动请两边同步（`../worker/src/index.js` 是基准）

## 接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 地图选点网页（URL 加 `?token=` 才能打开） |
| `/loc.json?token=` | GET | 读取坐标 JSON |
| `/set?token=` | POST | 保存坐标 |
| `/enable` | POST | 回到真实位置（再点一下恢复伪造） |
| `/health` | GET | 健康检查（无需 token） |

## 部署

### 1. 导入仓库

Vercel → **Add New → Project** → 导入本仓库（fork 到自己账号下也可以）。

**Root Directory** 点 Edit 选到：

```text
location-picker/vercel
```

Framework Preset 选 **Other**，不用填任何构建命令。

### 2. 添加 Upstash Redis（存储坐标用）

方式一（推荐）：在项目里点 **Storage → Create Database / Browse Marketplace → Upstash → Redis**，按提示创建并连接到本项目，环境变量会自动注入。

方式二：去 [upstash.com](https://upstash.com) 手动建一个免费 Redis 库，把控制台里的 REST URL 和 REST Token 填到项目环境变量：

```text
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx
```

> 代码同时认 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 和 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 两组名字，集成给哪组就用哪组，不用改代码。

### 3. 设置访问口令

Project Settings → **Environment Variables** 添加：

```text
TOKEN=<随机字符串>
```

生成方式：`openssl rand -hex 24`。

### 4. 部署并验证

Deploy 后访问（换成你的域名）：

```text
https://你的项目.vercel.app/health
```

必须看到：

```json
{"ok":true,"kv":true,"tokenConfigured":true}
```

- `kv:false` → Redis 没接好，回第 2 步检查组变量名
- `tokenConfigured:false` → TOKEN 没设，回第 3 步
- 页面/接口 500 且 `/health` 正常 → 保存时写库失败会返回 `{"error":"storage unavailable"}`，同样是存储配置问题

> 这一步能立刻暴露部署问题：如果 `/health` 本身就打不开，先看 Vercel 的 Functions 日志确认函数按 Edge Runtime 构建。

## Loon 插件配置

Loon → 设置 → 插件 → iOS Location Spoofer → **远程配置 URL**：

```text
https://你的项目.vercel.app/loc.json?token=你的TOKEN
```

在 iPhone 浏览器打开地图页：

```text
https://你的项目.vercel.app/?token=你的TOKEN
```

点地图 → **保存定位** → 关开 iPhone 定位服务生效。

## Shadowrocket 配置

模块 `argument=` 末尾追加：

```text
&configUrl=https://你的项目.vercel.app/loc.json?token=你的TOKEN
```

## 自定义域名（可选）

Project Settings → **Domains** 绑定子域（如 `loc.example.com`）即可，Vercel 自动签 HTTPS 证书。

## 本地开发

```bash
cd location-picker/vercel
cp .env.example .env   # 填入 TOKEN 和 Upstash 两组变量之一
npx vercel dev
```

## 与 Cloudflare Worker 版差异

- 存储从 CF KV 换成 **Upstash Redis**：单 key **强一致**，**保存即生效**，没有 CF KV 约 60 秒的缓存等待
- 写库失败时返回 `500 {"error":"storage unavailable"}`（Worker 版是直接抛异常），部署期排错更直观
- 无 `/geocode` `/elevation` 服务端转发（与 Worker 版一致；这两个接口只有 Node 自托管版有）
