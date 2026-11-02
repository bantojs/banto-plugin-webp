import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { LEGACY_SETTINGS, MANIFEST, QuotaError, expectedVariants, handleRequest, plan, sweep, verifySignature, webpSize, type Converter, type ImageSettings } from "../src/plugin";

/**
 * Banto の hooks の署名（docs/hooks.md §3）: X-Banto-Signature: t=<epoch秒>,v1=<hex(HMAC-SHA256(secret, `${t}.${body}`))>。
 * Banto 本体を読み込まずに、公開の決まりのとおりに作る
 */
const signHookPayload = (secret: string, body: string, t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

/** Banto の hooks・マニフェスト・画像の差し替えの API（PUT /api/v1/images/{id}/file）の契約どおりに動くことを確かめる */
describe("banto-plugin-webp", () => {
  const env = { BANTO_HOOK_SECRET: "", BANTO_API_URL: "https://shop.example/api/v1", BANTO_API_TOKEN: "banto_token", BANTO_MEDIA_URL: "https://media.example" };
  const NOW = 1_760_000_000;
  const JPG = { id: "11111111-1111-4111-8111-111111111111", storage_key: "shops/s/products/p/aaaaaaaaaaaaaaaaaaaaaaaa.jpg", thumb_key: null };
  const DONE = { id: "22222222-2222-4222-8222-222222222222", storage_key: "shops/s/products/p/bbbbbbbbbbbbbbbbbbbbbbbb.webp", thumb_key: "shops/s/products/p/bbbbbbbbbbbbbbbbbbbbbbbb.thumb.webp", width: 1600, height: 1200, variants: [800], thumb_width: 400 };
  const NOTHUMB = { id: "33333333-3333-4333-8333-333333333333", storage_key: "shops/s/products/p/cccccccccccccccccccccccc.webp", thumb_key: null, width: 1600, height: 1200, variants: [800], thumb_width: null };
  const GIF = { id: "44444444-4444-4444-8444-444444444444", storage_key: "shops/s/products/p/dddddddddddddddddddddddd.gif", thumb_key: null };

  /** 幅・高さだけを持つ WebP（VP8X の見出し） */
  const webp = (w: number, h: number) => {
    const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
    return new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, 0, 0, 0, 0], le24(w - 1), le24(h - 1)));
  };
  const SETTINGS: ImageSettings = { max_width: 1600, max_height: 4096, thumb_width: 400, variant_widths: [800, 1600, 2048, 2560] };

  /** 元の画像（4000×3000 の写真とみなす）と、持っている段のファイル */
  function world(opts: { images?: unknown[]; quota?: boolean; products?: { id: string; images: unknown[] }[]; broken?: string[]; settings?: ImageSettings | "old"; files?: string[] } = {}) {
    const puts: { url: string; parts: Record<string, { type: string; size: number }>; length: string | null }[] = [];
    const converts: number[] = [];
    const mediaGets: string[] = [];
    // 変換は枠（width × height）に収める。元は 4000×3000 とみなす
    const convert: Converter = async (_bytes, { width, height }) => {
      if (opts.quota) throw new QuotaError();
      converts.push(width);
      const r = Math.min(1, width / 4000, height / 3000);
      return webp(Math.round(4000 * r), Math.round(3000 * r));
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("https://media.example/")) {
        const key = url.slice("https://media.example/".length);
        mediaGets.push(key);
        if (opts.files && !opts.files.includes(key) && !/[a-f]{24}\.(jpg|webp|gif)$/.test(key)) return new Response("no", { status: 404 });
        return new Response(webp(1600, 1200));
      }
      if (url === "https://shop.example/api/v1/image-settings") return opts.settings === "old" ? new Response("{}", { status: 409 }) : Response.json(opts.settings ?? SETTINGS);
      if (method === "GET" && /\/api\/v1\/products\?/.test(url)) {
        const items = opts.products ?? [];
        return Response.json({ items, total: items.length, limit: 50, offset: 0 });
      }
      if (method === "GET" && url.startsWith("https://shop.example/api/v1/products/")) {
        const id = decodeURIComponent(url.split("/").pop()!);
        if (opts.broken?.includes(id)) return new Response("boom", { status: 500 });
        const p = opts.products?.find((x) => x.id === id);
        return Response.json({ id, images: p ? p.images : (opts.images ?? []) });
      }
      if (method === "PUT" && url.endsWith("/file")) {
        const h = new Headers(init?.headers);
        expect(h.get("authorization")).toBe("Bearer banto_token");
        const form = await new Request("https://x/", { method: "PUT", headers: { "content-type": h.get("content-type")! }, body: init!.body as BodyInit }).formData();
        const parts: Record<string, { type: string; size: number }> = {};
        for (const [k, v] of form.entries()) if (v instanceof Blob) parts[k] = { type: v.type, size: v.size };
        puts.push({ url, parts, length: h.get("content-length") });
        return Response.json({ image_id: "x", product: {} });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    };
    return { deps: { fetch: fetchImpl, convert, now: () => NOW, seen: new Set<string>() }, puts, converts, mediaGets };
  }

  async function deliver(w: ReturnType<typeof world>, envelope: Record<string, unknown>, badSig = false) {
    env.BANTO_HOOK_SECRET = "whsec_test";
    const body = JSON.stringify(envelope);
    const sig = badSig ? "t=1,v1=00" : signHookPayload(env.BANTO_HOOK_SECRET, body, NOW);
    return handleRequest(new Request("https://plugin.example/", { method: "POST", headers: { "Content-Type": "application/json", "X-Banto-Signature": sig }, body }), env, w.deps);
  }
  const updated = (id: string) => ({ id, event: "product.updated", created_at: "", shop_id: "s", attempt: 1, data: { product_id: "p", shop_id: "s" } });

  it("署名の検証: Banto が作る形（固定の見本）を通し、時刻のずれ・違う本文・壊れたヘッダーは断る", async () => {
    // docs/hooks.md §3 の計算で作った見本（Banto 本体の signHookPayload と同じ値）
    const body = '{"id":"d-1","event":"product.updated"}';
    const header = "t=1760000000,v1=2c3c33f2a0203c89713e1623af9174430bbeba8d085d9d7cf9ce037f2e615d5b";
    expect(signHookPayload("whsec_test_vector", body, 1760000000)).toBe(header);
    expect(await verifySignature("whsec_test_vector", body, header, 1760000000)).toBe(true);
    expect(await verifySignature("whsec_test_vector", body, header, 1760000000 + 600)).toBe(false);
    expect(await verifySignature("whsec_test_vector", body + " ", header, 1760000000)).toBe(false);
    expect(await verifySignature("whsec_test_vector", body, "v1=abc", 1760000000)).toBe(false);
  });

  it("画面に貼ったシークレットの前後の空白・改行は落として確かめる。banto.ping は署名が合えば 200", async () => {
    const body = JSON.stringify({ id: "ping-1", event: "banto.ping", created_at: "", shop_id: "s", attempt: 1, data: { message: "test" } });
    const sig = signHookPayload("a".repeat(64), body, 1760000000);
    const req = () => new Request("https://plugin.example/", { method: "POST", headers: { "X-Banto-Signature": sig }, body });
    const deps = { fetch: async () => new Response(), convert: async () => new Uint8Array(), now: () => 1760000000, seen: new Set<string>() };
    const pasted = { ...env, BANTO_HOOK_SECRET: ` ${"a".repeat(64)}\n` };
    expect((await handleRequest(req(), pasted, deps)).status).toBe(200);
    expect((await handleRequest(req(), { ...env, BANTO_HOOK_SECRET: "b".repeat(64) }, deps)).status).toBe(400);
  });

  it("GET はマニフェスト（docs/hooks.md §4 の形）を返す。購読は product.updated だけ", async () => {
    const res = await handleRequest(new Request("https://plugin.example/"), env, world().deps);
    const m = (await res.json()) as { name: string; events: string[]; settings: unknown[] };
    expect(typeof m.name).toBe("string");
    expect(m.events).toEqual(["product.updated"]);
    expect(Array.isArray(m.settings)).toBe(true);
    expect(MANIFEST.events).toEqual(["product.updated"]);
  });

  it("何を直すか: 段がそろっていない画像だけ（JPEG・サムネイルなし・中間の段の不足・設定より大きい）。GIF は飛ばす", () => {
    expect(plan(JPG, SETTINGS)).toBe("fix");
    expect(plan(NOTHUMB, SETTINGS)).toBe("fix");
    expect(plan(DONE, SETTINGS)).toBe("skip");
    expect(plan(GIF, SETTINGS)).toBe("skip");
    // 中間の段が足りない・前からある長辺 400 のサムネイル・設定より大きい
    expect(plan({ ...DONE, variants: [] }, SETTINGS)).toBe("fix");
    expect(plan({ ...DONE, thumb_width: null }, SETTINGS)).toBe("fix");
    expect(plan({ ...DONE, width: 2560, height: 1920, variants: [800, 1600, 2048] }, SETTINGS)).toBe("fix");
    // 設定を大きくしても、そろっている小さな画像は作り直さない（大きくはできない）
    expect(plan(DONE, { ...SETTINGS, max_width: 2560 })).toBe("skip");
    // 0092 より前の Banto: 前と同じ「WebP でサムネイルがある」で済み
    expect(plan({ ...DONE, variants: [], thumb_width: null }, LEGACY_SETTINGS)).toBe("skip");
    expect(expectedVariants(SETTINGS, 1600)).toEqual([800]);
    expect(expectedVariants({ ...SETTINGS, max_width: 3200 }, 3200)).toEqual([800, 1600, 2048, 2560]);
    expect(webpSize(webp(819, 4096))).toEqual({ width: 819, height: 4096 });
  });

  it("product.updated: JPEG は設定の横幅の本画像・サムネイル・中間の段を作って PUT /images/{id}/file。済みは触らない", async () => {
    const w = world({ images: [JPG, DONE, GIF], settings: { ...SETTINGS, max_width: 2560 } });
    const res = await deliver(w, updated("d-1"));
    expect(res.status).toBe(200);
    // 本画像 2560（高さ 4096 の枠）・サムネイル 400・中間 800 / 1600 / 2048
    expect(w.converts).toEqual([2560, 400, 800, 1600, 2048]);
    expect(w.puts.map((p) => p.url)).toEqual([`https://shop.example/api/v1/images/${JPG.id}/file`]);
    expect(Object.keys(w.puts[0]!.parts).sort()).toEqual(["image", "thumbnail", "variant_1600", "variant_2048", "variant_800"]);
    expect(w.puts[0]!.parts["image"]!.type).toBe("image/webp");
    expect(Number(w.puts[0]!.length)).toBeGreaterThan(0);
    // 差し替えたあとにまた届く product.updated（もう直した画像だけ）は何もしない
    const again = world({ images: [DONE] });
    expect((await deliver(again, updated("d-2"))).status).toBe(200);
    expect(again.puts).toHaveLength(0);
  });

  it("WebP の本画像で足りないのがサムネイルだけなら、本画像と持っている中間の段は取ってきて送り直し、サムネイルだけ変換する", async () => {
    const w = world({ images: [NOTHUMB] });
    expect((await deliver(w, updated("d-thumb"))).status).toBe(200);
    expect(w.converts).toEqual([400]);
    expect(w.mediaGets).toContain("shops/s/products/p/cccccccccccccccccccccccc.800.webp");
    expect(Object.keys(w.puts[0]!.parts).sort()).toEqual(["image", "thumbnail", "variant_800"]);
  });

  it("0092 より前の Banto（/image-settings が 409）は、前と同じ本画像 1600 とサムネイルだけ", async () => {
    const w = world({ images: [JPG], settings: "old" });
    expect((await deliver(w, updated("d-old"))).status).toBe(200);
    expect(w.converts).toEqual([1600, 400]);
    expect(Object.keys(w.puts[0]!.parts).sort()).toEqual(["image", "thumbnail"]);
  });

  it("マニフェストは画像を変換できると宣言する（Banto の 0092 の capabilities）", () => {
    expect(MANIFEST.capabilities).toEqual(["images"]);
  });

  it("fetch は this なしで呼ぶ（Workers の組み込みの fetch は deps.fetch(...) の形で呼ぶと Illegal invocation）", async () => {
    const products = [{ id: "p2", images: [JPG] }];
    const w = world({ products, images: [JPG] });
    const inner = w.deps.fetch;
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return inner(input, init);
    } as typeof fetch;
    const deps = { ...w.deps, fetch: strict };
    expect((await sweep(env, deps, 20)).fixed).toBe(1);
    env.BANTO_HOOK_SECRET = "whsec_test";
    const body = JSON.stringify(updated("d-this"));
    const res = await handleRequest(new Request("https://plugin.example/", { method: "POST", headers: { "X-Banto-Signature": signHookPayload("whsec_test", body, NOW) }, body }), env, { ...deps, seen: new Set<string>() });
    expect(res.status).toBe(200);
  });

  it("product.updated の 1 回で直すのは 2 枚まで（Banto の 10 秒と呼び出しの上限）。残りは次の知らせで", async () => {
    const many = Array.from({ length: 5 }, (_, n) => ({ ...JPG, id: `6666666${n}-6666-4666-8666-666666666666` }));
    const w = world({ images: many });
    const res = await deliver(w, updated("d-many"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok: 2 image(s)");
    expect(w.puts).toHaveLength(2);
  });

  it("署名が違えば 400。同じ配信 ID は二度処理しない。枠が切れたら 200 で受け取って何も置かない", async () => {
    const w = world({ images: [JPG] });
    expect((await deliver(w, updated("d-3"), true)).status).toBe(400);
    expect((await deliver(w, updated("d-3"))).status).toBe(200);
    expect((await deliver(w, updated("d-3"))).status).toBe(200);
    expect(w.puts).toHaveLength(1);
    const q = world({ images: [JPG], quota: true });
    const res = await deliver(q, updated("d-4"));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/quota/);
    expect(q.puts).toHaveLength(0);
  });

  it("見回り: 直すものがある商品だけを、1 回に決まった枚数まで直す。枠が切れたら止める", async () => {
    const products = [
      { id: "p1", images: [DONE] },
      { id: "p2", images: [JPG, { ...JPG, id: "55555555-5555-4555-8555-555555555555" }] },
      { id: "p3", images: [NOTHUMB] },
    ];
    const w = world({ products });
    expect(await sweep(env, w.deps, 2)).toEqual({ fixed: 2, quota: false, failed: 0 });
    expect(w.puts).toHaveLength(2);
    const q = world({ products, quota: true });
    expect(await sweep(env, q.deps, 10)).toEqual({ fixed: 0, quota: true, failed: 0 });
  });

  it("見回り: 外への呼び出しの数（無料プランは 1 回 50）を超える前に止め、次の回に続きを直す", async () => {
    const products = [
      { id: "p2", images: [JPG, { ...JPG, id: "55555555-5555-4555-8555-555555555555" }] },
      { id: "p3", images: [NOTHUMB] },
    ];
    const w = world({ products });
    let calls = 0;
    const deps = { ...w.deps, fetch: ((i: RequestInfo | URL, init?: RequestInit) => (calls++, w.deps.fetch(i, init))) as typeof fetch, convert: ((b, o) => (calls++, w.deps.convert(b, o))) as Converter };
    // 設定 1 + 一覧 1 + 詳細 1 + 1 枚 8 まで = 11 で 1 枚。残りでは 1 枚も直せないので止める
    expect(await sweep(env, deps, 20, 12)).toEqual({ fixed: 1, quota: false, failed: 0 });
    expect(calls).toBeLessThanOrEqual(12);
    expect(w.puts).toHaveLength(1);
  });

  it("product.updated で失敗したら、理由を本文とログの両方に出して 502（Banto に再送してもらう）", async () => {
    const w = world({ images: [JPG], broken: ["p"] });
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const res = await deliver(w, updated("d-err"));
      expect(res.status).toBe(502);
      expect(await res.text()).toMatch(/banto GET \/products\/p: 500/);
    } finally {
      console.error = orig;
    }
    expect(logged.join("\n")).toMatch(/webp hooks: product p: banto GET \/products\/p: 500/);
  });

  it("見回り: 1 つの商品で失敗しても、ログに残して次の商品に進む", async () => {
    const products = [
      { id: "bad", images: [JPG] },
      { id: "p3", images: [NOTHUMB] },
    ];
    const w = world({ products, broken: ["bad"] });
    expect(await sweep(env, w.deps, 20)).toEqual({ fixed: 1, quota: false, failed: 1 });
    expect(w.puts.map((p) => p.url)).toEqual([`https://shop.example/api/v1/images/${NOTHUMB.id}/file`]);
  });
});
