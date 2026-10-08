/**
 * iOS Location Picker — Vercel 适配版（Edge Runtime + Upstash Redis REST）
 *
 * 由 location-picker/worker/src/index.js 移植，对外行为与 Worker 版完全一致：
 *   GET  /loc.json?token=   → 读取坐标 JSON（Loon / Shadowrocket configUrl）
 *   POST /set?token=        → 保存坐标
 *   POST /enable?token=     → 伪造 / 恢复真实定位切换
 *   GET  /?token=           → 地图选点网页（必须带正确 token）
 *   GET  /health            → 健康检查（无需 token）
 *
 * 与 Worker 版仅两处差异：
 *   1. 配置来自 process.env：TOKEN 同义；CF KV 绑定换成 Upstash REST 连接信息
 *      （KV_REST_API_URL / KV_REST_API_TOKEN，或 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）
 *   2. 存储为 Upstash Redis 单 key（"loc"），纯 fetch 调 REST，零 npm 依赖；
 *      Redis 单 key 强一致，保存即生效，没有 CF KV 约 60 秒的缓存等待。
 *      另外写库失败这里返回 500 JSON（Worker 版是直接抛异常），方便部署期排错。
 */

import { PAGE } from "../lib/page.js";

export const config = { runtime: "edge" };

const KV_KEY = "loc";

const DEFAULT = {
  enabled: true,          // false = 脚本放行原始响应（恢复真实定位）
  latitude: 37.3349,
  longitude: -122.00902,
  altitude: 530,
  horizontalAccuracy: 39,
  verticalAccuracy: 1000,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // 选点页 URL 带 ?token=，务必阻止它经 Referer 泄漏给 unpkg / 高德 / OSM / open-meteo / nominatim
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

// 选点页专属 CSP：页面 URL 带 token，锁死脚本来源与可连接域名做纵深防御，
// 万一 CDN 被投毒也无法把 token 外传。script/style 需 'unsafe-inline'（页面自身内联），
// 外部脚本只放行 unpkg（已配 SRI）；connect 只放行地图/地理编码接口。
const PAGE_CSP = [
  "default-src 'none'",
  "script-src https://unpkg.com 'unsafe-inline'",
  "style-src https://unpkg.com 'unsafe-inline'",
  "img-src 'self' https: data:", // 地图瓦片（高德 wprd0*/webst0*、OSM 多子域）
  "connect-src 'self' https://api.open-meteo.com https://nominatim.openstreetmap.org",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function jsonResponse(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function textResponse(body, contentType, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function unauthorized() {
  return jsonResponse({ error: "bad token" }, 403);
}

// 常量时间比较，避免通过响应时延逐字节爆破 token
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

function checkToken(request) {
  const configured = process.env.TOKEN;
  if (!configured) {
    return { ok: false, error: "server misconfigured: TOKEN secret not set" };
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (token == null || !safeEqual(token, configured)) {
    return { ok: false, error: "bad token" };
  }
  return { ok: true };
}

function storeConfig() {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    return null;
  }
  return { base: String(base).replace(/\/+$/, ""), token: String(token) };
}

async function readLoc() {
  const store = storeConfig();
  if (!store) {
    return { ...DEFAULT };
  }
  try {
    const res = await fetch(store.base + "/get/" + KV_KEY, {
      headers: { Authorization: "Bearer " + store.token },
    });
    const j = await res.json();
    if (!j || j.result == null) {
      return { ...DEFAULT };
    }
    return JSON.parse(j.result);
  } catch {
    return { ...DEFAULT }; // 与 Worker 版一致：读失败回落默认坐标（fail-open）
  }
}

async function writeLoc(obj) {
  const store = storeConfig();
  if (!store) {
    throw new Error("storage not configured");
  }
  const res = await fetch(store.base + "/set/" + KV_KEY, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + store.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(obj),
  });
  if (!res.ok) {
    throw new Error("storage write failed: HTTP " + res.status);
  }
}

function setInt(target, key, value) {
  if (value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value))) {
    target[key] = Math.round(Number(value));
  }
}

function wrapLng(lng) {
  return ((((Number(lng) + 180) % 360) + 360) % 360) - 180;
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  // vercel.json 把 /:path* 重写到 /api/:path*，这里剥掉 /api 前缀还原业务路由；
  // 不带前缀的形式（/loc.json）同样匹配，便于不经 rewrites 直接调试本函数。
  const pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const auth = checkToken(request);

  if (pathname === "/loc.json" && request.method === "GET") {
    if (!auth.ok) {
      return unauthorized();
    }
    const loc = await readLoc();
    return jsonResponse(loc);
  }

  if (pathname === "/set" && request.method === "POST") {
    if (!auth.ok) {
      return unauthorized();
    }
    let j;
    try {
      const bodyText = await request.text();
      if (bodyText.length > 10000) {
        return jsonResponse({ error: "payload too large" }, 413);
      }
      j = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "bad json" }, 400);
    }
    const la = Number(j.lat);
    const loRaw = Number(j.lng);
    if (!Number.isFinite(la) || !Number.isFinite(loRaw) || la < -90 || la > 90) {
      return jsonResponse({ error: "bad coords" }, 400);
    }
    const lo = wrapLng(loRaw);
    const cur = await readLoc();
    cur.enabled = true; // 保存一个新位置 = 开启伪造
    cur.latitude = la;
    cur.longitude = lo;
    setInt(cur, "altitude", j.altitude);
    setInt(cur, "horizontalAccuracy", j.horizontalAccuracy);
    setInt(cur, "verticalAccuracy", j.verticalAccuracy);
    try {
      await writeLoc(cur);
    } catch {
      return jsonResponse({ error: "storage unavailable" }, 500);
    }
    return jsonResponse(cur);
  }

  // ---- 一键切换：伪造 / 恢复真实定位 ----
  if (pathname === "/enable" && request.method === "POST") {
    if (!auth.ok) {
      return unauthorized();
    }
    let j;
    try {
      const bodyText = await request.text();
      if (bodyText.length > 10000) {
        return jsonResponse({ error: "payload too large" }, 413);
      }
      j = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "bad json" }, 400);
    }
    const cur = await readLoc();
    cur.enabled = j.enabled !== false; // false=恢复真实定位（脚本放行）
    try {
      await writeLoc(cur);
    } catch {
      return jsonResponse({ error: "storage unavailable" }, 500);
    }
    return jsonResponse(cur);
  }

  if ((pathname === "/" || pathname === "") && request.method === "GET") {
    if (!auth.ok) {
      return unauthorized();
    }
    return new Response(PAGE, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": PAGE_CSP,
        ...CORS,
      },
    });
  }

  if (pathname === "/health") {
    return jsonResponse({ ok: true, kv: !!storeConfig(), tokenConfigured: !!process.env.TOKEN });
  }

  // 浏览器会自动请求 favicon；这里静默返 204，避免落到 404 分支产生噪音日志
  if (pathname === "/favicon.ico") {
    return new Response(null, { status: 204, headers: CORS });
  }

  return textResponse("not found", "text/plain", 404);
}
