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

### 一、把仓库导入 Vercel

1. 打开 [vercel.com](https://vercel.com) 并登录（可用 GitHub 账号直接登录）。
2. 点 **Add New… → Project**。
3. 在 **Import Git Repository** 里导入本仓库：
   - 已 fork 到自己账号的，列表里直接点 **Import**（推荐，之后 push 能自动触发部署）；
   - 没 fork 的，把公开仓库地址粘贴进输入框也能导入，但后续更新要手动同步。
4. 在 **Configure Project** 页配置：
   - **Root Directory**：点 **Edit**，依次展开选到 `location-picker/vercel`；
   - **Framework Preset**：显示 **Other** 属正常，不用改；
   - **Build and Output Settings**：全部留空，不用动；
   - **Environment Variables**：这一步可以先不填，后面统一配。
5. 点 **Deploy** 完成首次部署。

> **为什么识别不出框架？** Vercel 靠扫描依赖和框架配置文件来自动识别（比如检测到 `next` 依赖就认作 Next.js）。本项目刻意零依赖、无框架，Vercel 扫不到任何特征，只会回落到 **Other**——这不是识别失败，选 Other 就是正确答案。此时 Install / Build / Output 全部留空，Vercel 会直接部署 `api/` 里的函数，`vercel.json` 的 rewrites 与框架无关、照常生效。

首次部署后服务已能跑，但还没配存储和口令。访问 `/health` 会看到 `kv:false, tokenConfigured:false`，属于预期，继续往下配。

### 二、添加 Upstash Redis（存坐标的数据库）

**方式一（推荐）：Vercel 内一键集成**

1. 进入项目，点顶部 **Storage** 标签。
2. 点 **Create Database**（或 Browse Marketplace），在列表里选 **Upstash → Redis**（就是原来的 Vercel KV）。
3. 按提示创建：名字随意（如 `loc-redis`），区域选离你近的（国内用户建议新加坡）。
4. 创建完成后把它 **Connect / 连接** 到当前项目，环境勾选 **Production**。
5. 集成会自动往项目注入环境变量（`KV_REST_API_URL` / `KV_REST_API_TOKEN` 或 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`）。**两组名字代码都认，给哪组用哪组，不用改代码。**

**方式二：upstash.com 手动建库**

1. 打开 [console.upstash.com](https://console.upstash.com)，注册/登录。
2. **Create Database**：类型选 Redis，名字随意，区域选近的。
3. 建好后在数据库详情页 **REST API** 区域复制 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`。
4. 回到 Vercel 项目 → **Settings → Environment Variables**，把这两个变量原样添加（环境勾 Production）。

> Upstash 免费额度对个人选点使用完全够用。两种方式等价，已用方式一就不要再重复建。

### 三、设置访问口令 TOKEN

1. 生成一个随机口令：

   ```bash
   openssl rand -hex 24
   ```

   没有 openssl 就用密码管理器生成 32 位以上的随机字符串。不要用弱口令。
2. Vercel 项目 → **Settings → Environment Variables** 添加：
   - **Name**：`TOKEN`
   - **Value**：刚生成的随机字符串
   - **Environments**：勾 **Production**

### 四、重新部署并验证

> **关键一步：环境变量和 Storage 集成只对「新的部署」生效。** 首次部署之后才配的变量，必须重新部署才会被函数读到，否则会一直卡在 `kv:false`。

1. 项目 → **Deployments** → 最新一条右侧 **⋯ → Redeploy**。
2. 部署完成后访问（换成你的域名）：

   ```text
   https://你的项目.vercel.app/health
   ```

   必须看到：

   ```json
   {"ok":true,"kv":true,"tokenConfigured":true}
   ```

**对照排错：**

| 看到的现象 | 原因 | 处理 |
|-----------|------|------|
| `kv:false` | Redis 没接上 | 回第二步：确认数据库已 Connect 到本项目；方式二检查组变量名是否拼对 |
| `tokenConfigured:false` | TOKEN 没设 | 回第三步 |
| 改完变量还是 false | 没有重新部署 | 回第四步 Redeploy（最常见） |
| 保存定位返回 `{"error":"storage unavailable"}` | 写库失败 | REST URL/Token 复制时多了空格或缺字符，重新复制 |
| `/health` 直接 404 / 500 | 函数构建或路由异常 | Deployments → 该次部署的日志；确认 Root Directory 是 `location-picker/vercel`、Preset 是 Other |

### 五、完整走一遍（强烈建议）

1. 浏览器打开 `https://你的项目.vercel.app/?token=你的TOKEN` —— 能看到地图页。
2. 在地图上点一下放图钉 → 点 **保存定位** → 看到「已保存 ✓」。
3. 打开 `https://你的项目.vercel.app/loc.json?token=你的TOKEN` —— 经纬度已变成刚保存的位置，说明存储链路完全打通。
4. 换一个错误 token 访问 —— 返回 `{"error":"bad token"}`，说明鉴权正常。

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
