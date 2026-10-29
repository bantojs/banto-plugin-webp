/**
 * Banto 外部プラグインの実例: 商品の画像を WebP にし、サムネイル（長辺 400px）を作る。
 *
 * Banto の Worker は画像を処理しない（Workers の CPU の制限・Cloudflare 固有の機能をコアで使わない）。管理画面からの
 * アップロードはブラウザが WebP にするが、裏の取り込み・URL からの取り込み・前からの画像は元の形式のまま残る。
 * このプラグインはそれを外で作り直し、Banto の API で戻す（Banto の docs/hooks.md・docs/api.md「画像のファイルを差し替える」）。
 *
 *   POST（hooks）… product.updated を受け、その商品の画像のうち WebP でない・サムネイルの無いものを直す
 *   定期処理    … 全商品を見回って、残っているものを決まった枚数だけ直す（前からの画像・枠が切れて止まった分）
 *
 * 差し替えは PUT /api/v1/images/{id}/file（0077）。並び順・SKU への結び付けはそのまま。差し替えるとまた product.updated が
 * 届くが、もう WebP でサムネイルもある画像は飛ばすので繰り返さない。
 * 変換そのもの（convert）は差し替えられる。index.ts は Cloudflare Images の binding を使う（Node なら sharp などに替えられる）。
 * 秘密（Banto のトークンと署名シークレット）はこのプラグイン自身の環境変数に置く。Banto の DB には入れない。
 */

export interface PluginEnv {
  /** Banto の管理画面 → 連携 → 送信先に表示される「署名シークレット」 */
  BANTO_HOOK_SECRET: string;
  /** https://<Banto の URL>/api/v1 */
  BANTO_API_URL: string;
  /** Banto の AI 用トークン（products:read と products:write） */
  BANTO_API_TOKEN: string;
  /** 画像の置き場所の URL。Banto の MEDIA_BASE_URL（R2 の独自ドメイン）か https://<Banto の URL>/media */
  BANTO_MEDIA_URL: string;
}

/** 枠（Cloudflare Images の無料の 1 か月 5,000 回など）が切れた。次の月まで待つ */
export class QuotaError extends Error {
  constructor(message = "image transformation quota exceeded") {
    super(message);
    this.name = "QuotaError";
  }
}

/** 画像を長辺 width 以下（大きいときだけ縮める）の WebP にする。枠が切れたら QuotaError */
export type Converter = (bytes: Uint8Array, opts: { width: number; quality: number }) => Promise<Uint8Array>;

export interface PluginDeps {
  fetch: typeof fetch;
  convert: Converter;
  /** 署名の時刻検証用（テストで固定する） */
  now?: () => number;
  /** 冪等化に使う配信 ID の記憶（再送は分単位の間隔なので同じ isolate に当たりやすい） */
  seen?: Set<string>;
}

export const MANIFEST = {
  name: "画像を WebP に",
  version: "1.0.0",
  description: "商品の画像を WebP（長辺 1600px）にし、一覧用のサムネイル（長辺 400px）を作ります。取り込んだ画像・前からの画像が対象です。",
  events: ["product.updated"],
  settings: [],
} as const;

/** Banto の管理画面からのアップロードと同じ大きさ */
export const MAIN_WIDTH = 1600;
export const THUMB_WIDTH = 400;
/** Banto が受け取る大きさ（本画像 5MB・サムネイル 1MB） */
const MAX_MAIN = 5 * 1024 * 1024;
const MAX_THUMB = 1024 * 1024;

interface Envelope {
  id: string;
  event: string;
  shop_id: string;
  data: Record<string, unknown>;
}

interface ApiImage {
  id: string;
  storage_key: string;
  thumb_key: string | null;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** Banto の docs/hooks.md §3 のとおり（Stripe と同じ形のヘッダー） */
export async function verifySignature(secret: string, body: string, header: string | null, now: number, toleranceSeconds = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  if (Math.abs(now - Number(t)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

const extOf = (key: string) => key.slice(key.lastIndexOf(".") + 1).toLowerCase();

/**
 * 直すかどうか。GIF は動きを失わないように飛ばす。WebP・AVIF でサムネイルもあるものは済み。
 * WebP・AVIF でサムネイルが無いものは、本画像はそのままでサムネイルだけを作る
 */
export function plan(image: ApiImage): "skip" | "thumb" | "both" {
  const ext = extOf(image.storage_key);
  if (ext === "gif") return "skip";
  if (ext === "webp" || ext === "avif") return image.thumb_key ? "skip" : "thumb";
  return "both";
}

/** Banto の API で 404 のときは null（商品が消えた）。それ以外の失敗は投げる（hooks なら 5xx で再送してもらう） */
async function api<T>(env: PluginEnv, deps: PluginDeps, path: string, init: RequestInit = {}): Promise<T | null> {
  const res = await deps.fetch(`${env.BANTO_API_URL.replace(/\/+$/, "")}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${env.BANTO_API_TOKEN}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`banto ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** 1 枚を直す。直したら true */
async function fixImage(env: PluginEnv, deps: PluginDeps, image: ApiImage): Promise<boolean> {
  const todo = plan(image);
  if (todo === "skip") return false;
  const src = await deps.fetch(`${env.BANTO_MEDIA_URL.replace(/\/+$/, "")}/${image.storage_key}`);
  if (!src.ok) throw new Error(`media ${image.storage_key}: ${src.status}`);
  const original = new Uint8Array(await src.arrayBuffer());
  const main = todo === "thumb" && original.byteLength <= MAX_MAIN ? original : await deps.convert(original, { width: MAIN_WIDTH, quality: 82 });
  const thumb = await deps.convert(original, { width: THUMB_WIDTH, quality: 80 });
  if (main.byteLength > MAX_MAIN || thumb.byteLength > MAX_THUMB) throw new Error(`converted image is too large: ${image.id}`);
  const form = new FormData();
  const mainType = todo === "thumb" ? (extOf(image.storage_key) === "avif" ? "image/avif" : "image/webp") : "image/webp";
  form.append("image", new Blob([main.slice()], { type: mainType }), "image");
  form.append("thumbnail", new Blob([thumb.slice()], { type: "image/webp" }), "thumbnail.webp");
  // Content-Length が要るので、本文を一度組み立ててから送る
  const req = new Request("https://banto.invalid/", { method: "PUT", body: form });
  const body = new Uint8Array(await req.arrayBuffer());
  await api(env, deps, `/images/${encodeURIComponent(image.id)}/file`, {
    method: "PUT",
    headers: { "Content-Type": req.headers.get("content-type")!, "Content-Length": String(body.byteLength) },
    body,
  });
  return true;
}

/** 1 つの商品の画像を直す。直した枚数を返す（limit 枚で止める） */
export async function fixProduct(env: PluginEnv, deps: PluginDeps, productId: string, limit = Infinity): Promise<number> {
  const product = await api<{ images?: ApiImage[] }>(env, deps, `/products/${encodeURIComponent(productId)}`);
  if (!product) return 0;
  let n = 0;
  for (const image of product.images ?? []) {
    if (n >= limit) break;
    if (await fixImage(env, deps, image)) n++;
  }
  return n;
}

/**
 * 全商品を見回って、残っているものを直す（定期処理）。1 回に budget 枚まで。枠が切れたら止める（次の回・次の月に続き）。
 * 直したものは飛ばすので、続きの位置を覚えなくてよい
 */
export async function sweep(env: PluginEnv, deps: PluginDeps, budget = 20): Promise<{ fixed: number; quota: boolean }> {
  let fixed = 0;
  for (let offset = 0; fixed < budget; offset += 50) {
    const page = await api<{ items: { id: string; images?: ApiImage[] }[]; total: number }>(env, deps, `/products?limit=50&offset=${offset}`);
    if (!page || page.items.length === 0) break;
    for (const p of page.items) {
      if (fixed >= budget) break;
      // 一覧に画像があれば、直すものがある商品だけ詳細を引く
      if (p.images && !p.images.some((i) => plan(i) !== "skip")) continue;
      try {
        fixed += await fixProduct(env, deps, p.id, budget - fixed);
      } catch (e) {
        if (e instanceof QuotaError) return { fixed, quota: true };
        throw e;
      }
    }
    if (offset + 50 >= page.total) break;
  }
  return { fixed, quota: false };
}

export async function handleRequest(req: Request, env: PluginEnv, deps: PluginDeps): Promise<Response> {
  if (req.method === "GET") {
    return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.BANTO_HOOK_SECRET || !env.BANTO_API_URL || !env.BANTO_API_TOKEN || !env.BANTO_MEDIA_URL) return new Response("plugin not configured", { status: 500 });

  const body = await req.text();
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  // 画面に貼るときに混ざった前後の空白・改行は落とす（Banto のシークレットは 64 桁の hex）
  if (!(await verifySignature(env.BANTO_HOOK_SECRET.trim(), body, req.headers.get("X-Banto-Signature"), now))) {
    // 理由だけをログに出す（シークレットの値は出さない）。ほとんどは BANTO_HOOK_SECRET の貼り間違い
    console.warn(`webp hooks: bad signature (header ${req.headers.has("X-Banto-Signature") ? "present" : "missing"}); copy the signing secret from Banto again into BANTO_HOOK_SECRET`);
    return new Response("bad signature", { status: 400 });
  }
  let envelope: Envelope;
  try {
    envelope = JSON.parse(body) as Envelope;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!envelope || typeof envelope.id !== "string" || typeof envelope.event !== "string") return new Response("bad envelope", { status: 400 });
  const seen = deps.seen ?? defaultSeen;
  if (seen.has(envelope.id)) return new Response("already processed");
  if (envelope.event !== "product.updated") return new Response("ignored");
  const productId = envelope.data["product_id"];
  if (typeof productId !== "string") return new Response("ignored");
  try {
    const n = await fixProduct(env, deps, productId);
    seen.add(envelope.id);
    if (seen.size > 5000) seen.clear();
    return new Response(`ok: ${n} image(s)`);
  } catch (e) {
    // 枠が切れた: 再送してもらっても同じなので 200 で受け取り、定期処理が次の月に直す
    if (e instanceof QuotaError) return new Response("quota exceeded; the scheduled sweep will retry");
    // それ以外（Banto・置き場所の一時的な失敗）は 5xx で再送してもらう
    return new Response(e instanceof Error ? e.message : String(e), { status: 502 });
  }
}

const defaultSeen = new Set<string>();
