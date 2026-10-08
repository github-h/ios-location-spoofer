import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Vercel 适配层冒烟测试。处理器是 Edge 风格（Fetch API），在 Node ≥ 18 下可直接
// import 并调用，无需 Vercel、无需网络（未配置 Upstash 时 readLoc 回落默认坐标）。
// 文件名含方括号，file URL 里需百分号编码才能被 import()/readFile 正确解析。
const adapterPath = new URL("../../vercel/api/%5B%5B...path%5D%5D.js", import.meta.url);
const handler = (await import(adapterPath)).default;

const ENV_KEYS = [
  "TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

test("health 无需 token，如实报告存储与口令配置状态", async () => {
  clearEnv();
  try {
    const bare = await handler(new Request("https://h.test/api/health"));
    assert.equal(bare.status, 200);
    assert.deepEqual(await bare.json(), { ok: true, kv: false, tokenConfigured: false });

    process.env.TOKEN = "t";
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "k";
    const configured = await handler(new Request("https://h.test/api/health"));
    assert.deepEqual(await configured.json(), { ok: true, kv: true, tokenConfigured: true });

    // 不带 /api 前缀的直连形式同样路由（rewrites 未生效时也可用）
    const direct = await handler(new Request("https://h.test/health"));
    assert.equal(direct.status, 200);
  } finally {
    clearEnv();
  }
});

test("token 校验：未配置 TOKEN 视为服务端配置错误，缺失/错误 token 一律 403", async () => {
  clearEnv();
  try {
    const misconfigured = await handler(new Request("https://h.test/api/loc.json?token=x"));
    assert.equal(misconfigured.status, 403);

    process.env.TOKEN = "secret-token";
    for (const url of [
      "https://h.test/api/loc.json",
      "https://h.test/api/loc.json?token=wrong",
      "https://h.test/api/?token=wrong",
    ]) {
      const res = await handler(new Request(url));
      assert.equal(res.status, 403, url);
      assert.deepEqual(await res.json(), { error: "bad token" });
    }
  } finally {
    clearEnv();
  }
});

test("loc.json 正确 token 放行；未配置存储时回落 Worker 版同款默认坐标", async () => {
  clearEnv();
  process.env.TOKEN = "secret-token";
  try {
    const res = await handler(new Request("https://h.test/api/loc.json?token=secret-token"));
    assert.equal(res.status, 200);
    const loc = await res.json();
    assert.equal(loc.enabled, true);
    assert.equal(loc.latitude, 37.3349);
    assert.equal(loc.longitude, -122.00902);
    assert.equal(loc.horizontalAccuracy, 39);
  } finally {
    clearEnv();
  }
});

test("选点页带正确 token 返回 HTML 且带安全响应头，错误 token 403", async () => {
  clearEnv();
  process.env.TOKEN = "secret-token";
  try {
    const res = await handler(new Request("https://h.test/api/?token=secret-token"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(await res.text(), /保存定位/);
  } finally {
    clearEnv();
  }
});

test("set/enable 未配置存储时返回 500，而不是假成功", async () => {
  clearEnv();
  process.env.TOKEN = "secret-token";
  try {
    const bad = await handler(
      new Request("https://h.test/api/set?token=secret-token", {
        method: "POST",
        body: JSON.stringify({ lat: 31.23, lng: 121.47 }),
      }),
    );
    assert.equal(bad.status, 500);
    assert.deepEqual(await bad.json(), { error: "storage unavailable" });

    const enable = await handler(
      new Request("https://h.test/api/enable?token=secret-token", {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    assert.equal(enable.status, 500);
  } finally {
    clearEnv();
  }
});

test("set 参数校验与 Worker 版一致：坏 JSON 400、越界坐标 400", async () => {
  clearEnv();
  process.env.TOKEN = "secret-token";
  try {
    const badJson = await handler(
      new Request("https://h.test/api/set?token=secret-token", { method: "POST", body: "not json" }),
    );
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "bad json" });

    const badCoords = await handler(
      new Request("https://h.test/api/set?token=secret-token", {
        method: "POST",
        body: JSON.stringify({ lat: 91, lng: 0 }),
      }),
    );
    assert.equal(badCoords.status, 400);
    assert.deepEqual(await badCoords.json(), { error: "bad coords" });
  } finally {
    clearEnv();
  }
});

test("杂项行为与 Worker 版一致：OPTIONS 204、favicon 204、未知路径 404", async () => {
  clearEnv();
  try {
    const options = await handler(new Request("https://h.test/api/loc.json", { method: "OPTIONS" }));
    assert.equal(options.status, 204);

    const favicon = await handler(new Request("https://h.test/api/favicon.ico"));
    assert.equal(favicon.status, 204);

    const missing = await handler(new Request("https://h.test/api/nope"));
    assert.equal(missing.status, 404);
  } finally {
    clearEnv();
  }
});

test("源码 parity：Edge runtime、Upstash 环境变量名、常量时间 token 比较", async () => {
  const src = await readFile(adapterPath, "utf8");
  assert.match(src, /export const config = \{ runtime: "edge" \}/);
  assert.match(src, /KV_REST_API_URL/);
  assert.match(src, /UPSTASH_REDIS_REST_URL/);
  assert.match(src, /function safeEqual\(/);
});
