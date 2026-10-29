import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { MANIFEST, QuotaError, handleRequest, plan, sweep, verifySignature, type Converter } from "../src/plugin";

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
  const DONE = { id: "22222222-2222-4222-8222-222222222222", storage_key: "shops/s/products/p/bbbbbbbbbbbbbbbbbbbbbbbb.webp", thumb_key: "shops/s/products/p/bbbbbbbbbbbbbbbbbbbbbbbb.thumb.webp" };
  const NOTHUMB = { id: "33333333-3333-4333-8333-333333333333", storage_key: "shops/s/products/p/cccccccccccccccccccccccc.webp", thumb_key: null };
  const GIF = { id: "44444444-4444-4444-8444-444444444444", storage_key: "shops/s/products/p/dddddddddddddddddddddddd.gif", thumb_key: null };

  function world(opts: { images?: unknown[]; quota?: boolean; products?: { id: string; images: unknown[] }[]; broken?: string[] } = {}) {
    const puts: { url: string; parts: Record<string, { type: string; size: number }>; length: string | null }[] = [];
    const converts: number[] = [];
    const convert: Converter = async (bytes, { width }) => {
      if (opts.quota) throw new QuotaError();
      converts.push(width);
      return new Uint8Array(width === 400 ? 10 : 20);
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("https://media.example/")) return new Response(new Uint8Array(100));
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
    return { deps: { fetch: fetchImpl, convert, now: () => NOW, seen: new Set<string>() }, puts, converts };
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

  it("何を直すか: JPEG・PNG は両方、WebP でサムネイルが無ければサムネイルだけ、済み・GIF は飛ばす", () => {
    expect(plan(JPG)).toBe("both");
    expect(plan(NOTHUMB)).toBe("thumb");
    expect(plan(DONE)).toBe("skip");
    expect(plan(GIF)).toBe("skip");
  });

  it("product.updated: JPEG は 1600px と 400px の WebP にして PUT /images/{id}/file。WebP は本画像をそのままでサムネイルだけ。済みは触らない", async () => {
    const w = world({ images: [JPG, DONE, NOTHUMB, GIF] });
    const res = await deliver(w, updated("d-1"));
    expect(res.status).toBe(200);
    expect(w.converts).toEqual([1600, 400, 400]);
    expect(w.puts.map((p) => p.url)).toEqual([`https://shop.example/api/v1/images/${JPG.id}/file`, `https://shop.example/api/v1/images/${NOTHUMB.id}/file`]);
    expect(w.puts[0]!.parts).toEqual({ image: { type: "image/webp", size: 20 }, thumbnail: { type: "image/webp", size: 10 } });
    // WebP の本画像は取ってきたものをそのまま（100 バイト）
    expect(w.puts[1]!.parts["image"]).toEqual({ type: "image/webp", size: 100 });
    expect(Number(w.puts[0]!.length)).toBeGreaterThan(0);
    // 差し替えたあとにまた届く product.updated（もう直した画像だけ）は何もしない
    const again = world({ images: [DONE] });
    expect((await deliver(again, updated("d-2"))).status).toBe(200);
    expect(again.puts).toHaveLength(0);
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
    // 一覧 1 + 詳細 1 + 1 枚 4 = 6 で 1 枚。残りでは 1 枚も直せないので止める
    expect(await sweep(env, deps, 20, 7)).toEqual({ fixed: 1, quota: false, failed: 0 });
    expect(calls).toBeLessThanOrEqual(7);
    expect(w.puts).toHaveLength(1);
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
