/**
 * Banto 外部プラグインの実例: 商品の画像を、Banto が使う **横幅の段**（本画像・中間の段・サムネイル）の WebP にする。
 *
 * Banto の Worker は画像を処理しない（Workers の CPU の制限・Cloudflare 固有の機能をコアで使わない）。管理画面からの
 * アップロードは既定ではブラウザが段を作るが、ショップの設定で「外部の変換プラグインに任せる」にすると元の写真のまま届く。
 * 裏の取り込み・URL からの取り込み・前からの画像も元の形式のまま残る。このプラグインはそれを外で作り直し、Banto の API で戻す
 * （Banto の docs/images.md・docs/hooks.md・docs/api.md「画像のファイルを差し替える」）。
 *
 *   POST（hooks）… product.updated を受け、その商品の画像のうち段がそろっていないものを直す
 *   定期処理    … 全商品を見回って、残っているものを決まった枚数だけ直す（前からの画像・枠が切れて止まった分）
 *
 * 作る大きさは GET /api/v1/image-settings（Banto の 0092）: 本画像の横幅 max_width・高さの上限 max_height・サムネイルの横幅・
 * 中間の段 variant_widths（本画像より狭いものだけ）。Banto が 0092 より前なら、本画像 1600・サムネイル 400 だけ（前と同じ）。
 * 差し替えは PUT /api/v1/images/{id}/file（0077、中間の段 variant_<横幅> は 0092）。並び順・SKU への結び付けはそのまま。
 * もう持っている段（WebP の本画像・横幅 400 のサムネイル・中間の段）は取ってきて送り直すだけで、変換しない（変換の枠を使わない）。
 * 差し替えるとまた product.updated が届くが、段がそろった画像は飛ばすので繰り返さない。
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

/** 画像を横幅 width・高さ height の枠に収まる（大きいときだけ縮める、縦横の比はそのまま）WebP にする。枠が切れたら QuotaError */
export type Converter = (bytes: Uint8Array, opts: { width: number; height: number; quality: number }) => Promise<Uint8Array>;

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
  version: "2.0.0",
  description: "商品の画像を、Banto のショップの設定に合わせた横幅の段（本画像・800px などの中間の段・横幅 400px のサムネイル）の WebP にします。「外部の変換プラグインに任せる」にしたショップの新しい画像・取り込んだ画像・前からの画像が対象です。",
  events: ["product.updated"],
  settings: [],
  // Banto の 0092: ショップの設定「商品画像の変換」を「外部の変換プラグインに任せる」にしたときの相手
  capabilities: ["images"],
} as const;

/** 作る大きさ（Banto の GET /api/v1/image-settings） */
export interface ImageSettings {
  max_width: number;
  max_height: number;
  thumb_width: number;
  variant_widths: number[];
}

/** Banto が 0092 より前のとき（前と同じ: 本画像 1600・サムネイル 400、中間の段なし） */
export const LEGACY_SETTINGS: ImageSettings = { max_width: 1600, max_height: 4096, thumb_width: 400, variant_widths: [] };

/** Banto が受け取る大きさ（本画像・中間の段 5MB・サムネイル 1MB） */
const MAX_MAIN = 5 * 1024 * 1024;
const MAX_THUMB = 1024 * 1024;

interface Envelope {
  id: string;
  event: string;
  shop_id: string;
  data: Record<string, unknown>;
}

export interface ApiImage {
  id: string;
  storage_key: string;
  thumb_key: string | null;
  width?: number | null;
  height?: number | null;
  /** 0092 から。持っている中間の段の横幅 */
  variants?: number[] | null;
  /** 0092 から。サムネイルの横幅（null は前からある長辺 400 のサムネイル） */
  thumb_width?: number | null;
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

/** WebP の見出しから横幅と高さ（読めなければ null） */
export function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") return null;
  const chunk = ascii(12, 16);
  if (chunk === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  if (chunk === "VP8 ") return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  if (chunk === "VP8L") {
    const v = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** 中間の段のキー（Banto の src/media/variants.ts の variantKey と同じ形） */
export const variantKeyOf = (storageKey: string, width: number) => storageKey.replace(/\.[a-z0-9]+$/i, "") + `.${width}.webp`;

/** 本画像の横幅が mainWidth のときに要る中間の段 */
export const expectedVariants = (s: ImageSettings, mainWidth: number) => s.variant_widths.filter((w) => w > s.thumb_width && w < mainWidth);

/**
 * 直すかどうか。GIF は動きを失わないように飛ばす。
 * 済み = 本画像が WebP（か AVIF）で設定の大きさに収まり、サムネイルがあり（0092 からは横幅 400 と分かるもの）、要る中間の段がそろっている
 */
export function plan(image: ApiImage, s: ImageSettings = LEGACY_SETTINGS): "skip" | "fix" {
  const ext = extOf(image.storage_key);
  if (ext === "gif") return "skip";
  if (ext !== "webp" && ext !== "avif") return "fix";
  if (!image.thumb_key) return "fix";
  // 0092 より前の Banto（設定に中間の段が無い）は、前と同じ「WebP でサムネイルがある」で済み
  if (s.variant_widths.length === 0) return "skip";
  if (image.thumb_width !== s.thumb_width) return "fix";
  const w = image.width ?? null;
  const h = image.height ?? null;
  if (!w || !h || w > s.max_width || h > s.max_height) return "fix";
  const have = new Set(image.variants ?? []);
  return expectedVariants(s, w).every((v) => have.has(v)) ? "skip" : "fix";
}

/** Banto の API で 404 のときは null（商品が消えた）。それ以外の失敗は投げる（hooks なら 5xx で再送してもらう） */
async function api<T>(env: PluginEnv, deps: PluginDeps, path: string, init: RequestInit = {}): Promise<T | null> {
  // fetch は deps のメソッドとして呼ばない（Workers の fetch は this が違うと Illegal invocation になる）
  const doFetch = deps.fetch;
  const res = await doFetch(`${env.BANTO_API_URL.replace(/\/+$/, "")}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${env.BANTO_API_TOKEN}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`banto ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** 置き場所からファイルを取る（無ければ null） */
async function media(env: PluginEnv, deps: PluginDeps, key: string): Promise<Uint8Array | null> {
  const doFetch = deps.fetch;
  const res = await doFetch(`${env.BANTO_MEDIA_URL.replace(/\/+$/, "")}/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`media ${key}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 1 枚を直す。直したら true。もう持っている段は取ってきて送り直すだけ（変換しない） */
async function fixImage(env: PluginEnv, deps: PluginDeps, image: ApiImage, s: ImageSettings): Promise<boolean> {
  if (plan(image, s) === "skip") return false;
  const original = await media(env, deps, image.storage_key);
  if (!original) throw new Error(`media ${image.storage_key}: 404`);
  const ext = extOf(image.storage_key);
  // 本画像: WebP・AVIF で設定の大きさに収まっていればそのまま。ほかは変換
  const fits = (ext === "webp" || ext === "avif") && original.byteLength <= MAX_MAIN && !!image.width && !!image.height && image.width <= s.max_width && image.height <= s.max_height;
  const main = fits ? original : await deps.convert(original, { width: s.max_width, height: s.max_height, quality: 82 });
  const mainWidth = webpSize(main)?.width ?? (fits ? image.width! : s.max_width);
  // サムネイル: 横幅 400 と分かっているものは取ってきて使う
  const reuseThumb = fits && image.thumb_key && image.thumb_width === s.thumb_width ? await media(env, deps, image.thumb_key) : null;
  const thumb = reuseThumb ?? (await deps.convert(original, { width: s.thumb_width, height: s.max_height, quality: 80 }));
  // 中間の段: 本画像をそのまま使うときは、持っている段を取ってきて使う
  const variants: { width: number; bytes: Uint8Array }[] = [];
  for (const w of expectedVariants(s, mainWidth)) {
    const reuse = fits && (image.variants ?? []).includes(w) ? await media(env, deps, variantKeyOf(image.storage_key, w)) : null;
    variants.push({ width: w, bytes: reuse ?? (await deps.convert(original, { width: w, height: s.max_height, quality: 82 })) });
  }
  if (main.byteLength > MAX_MAIN || thumb.byteLength > MAX_THUMB || variants.some((v) => v.bytes.byteLength > MAX_MAIN)) throw new Error(`converted image is too large: ${image.id}`);
  const form = new FormData();
  form.append("image", new Blob([main.slice()], { type: fits && ext === "avif" ? "image/avif" : "image/webp" }), "image");
  form.append("thumbnail", new Blob([thumb.slice()], { type: "image/webp" }), "thumbnail.webp");
  for (const v of variants) form.append(`variant_${v.width}`, new Blob([v.bytes.slice()], { type: "image/webp" }), `variant_${v.width}.webp`);
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

/** 作る大きさを Banto に聞く。0092 より前の Banto（404・409）なら前と同じ大きさ */
export async function imageSettings(env: PluginEnv, deps: PluginDeps): Promise<ImageSettings> {
  const doFetch = deps.fetch;
  const res = await doFetch(`${env.BANTO_API_URL.replace(/\/+$/, "")}/image-settings`, { headers: { Authorization: `Bearer ${env.BANTO_API_TOKEN}` } });
  if (res.status === 404 || res.status === 409) return LEGACY_SETTINGS;
  if (!res.ok) throw new Error(`banto GET /image-settings: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const v = (await res.json()) as Partial<ImageSettings>;
  const n = (x: unknown, d: number) => (typeof x === "number" && x > 0 ? x : d);
  return {
    max_width: n(v.max_width, 1600),
    max_height: n(v.max_height, 4096),
    thumb_width: n(v.thumb_width, 400),
    variant_widths: Array.isArray(v.variant_widths) ? v.variant_widths.filter((x): x is number => typeof x === "number" && x > 0) : [],
  };
}

/** 1 つの商品の画像を直す。直した枚数を返す（limit 枚で止める） */
export async function fixProduct(env: PluginEnv, deps: PluginDeps, productId: string, limit = Infinity, settings?: ImageSettings): Promise<number> {
  const s = settings ?? (await imageSettings(env, deps));
  const product = await api<{ images?: ApiImage[] }>(env, deps, `/products/${encodeURIComponent(productId)}`);
  if (!product) return 0;
  let n = 0;
  for (const image of product.images ?? []) {
    if (n >= limit) break;
    if (await fixImage(env, deps, image, s)) n++;
  }
  return n;
}

/** 1 回の実行の外への呼び出し（fetch と変換）の数が上限に来た。Workers の無料プランは 1 回 50 まで */
class SubrequestBudget extends Error {}

/**
 * 1 枚を直すのに使う外への呼び出しの数の上限（元の画像を取る・本画像・サムネイル・中間の段 4 つ・差し替え。
 * 商品の詳細と設定は別に 1 ずつ）。持っている段を取ってくるときも 1 ずつ数える
 */
const CALLS_PER_IMAGE = 8;

/**
 * hooks の 1 回で直す枚数。Banto は 10 秒で待つのをやめて再送するので、その中に収まる数にする（1 枚で最大 6 回変換するので 2 枚）。
 * 差し替えるとまた product.updated が積まれる（届けている途中の知らせには重ならない、Banto の 0075）ので、
 * 残りは次の知らせ（5 分ごと）と見回りで続きを直す
 */
export const HOOK_IMAGES = 2;

/** 外への呼び出しを数える deps。上限を超えたら SubrequestBudget */
function counting(deps: PluginDeps, calls: number): { deps: PluginDeps; used: () => number } {
  const doFetch = deps.fetch;
  let used = 0;
  const take = () => {
    if (++used > calls) throw new SubrequestBudget();
  };
  return {
    deps: {
      ...deps,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => (take(), doFetch(input, init))) as typeof fetch,
      convert: (bytes, opts) => (take(), deps.convert(bytes, opts)),
    },
    used: () => used,
  };
}

/**
 * 全商品を見回って、残っているものを直す（定期処理）。1 回に budget 枚まで、外への呼び出しは calls 回まで
 * （Workers の無料プランは 1 回の実行で 50 まで。超えるとその場で落ちるので、手前で止める）。
 * 枠が切れたら止める（次の回・次の月に続き）。1 つの商品で失敗しても、ログに残して次の商品に進む（同じ画像で毎回止まらない）。
 * 直したものは飛ばすので、続きの位置を覚えなくてよい
 */
export async function sweep(env: PluginEnv, deps: PluginDeps, budget = 20, calls = 45): Promise<{ fixed: number; quota: boolean; failed: number }> {
  const { deps: counted, used } = counting(deps, calls);
  let fixed = 0;
  let failed = 0;
  try {
    const settings = await imageSettings(env, counted);
    for (let offset = 0; fixed < budget; offset += 50) {
      const page = await api<{ items: { id: string; images?: ApiImage[] }[]; total: number }>(env, counted, `/products?limit=50&offset=${offset}`);
      if (!page || page.items.length === 0) break;
      for (const p of page.items) {
        if (fixed >= budget) break;
        // 一覧に画像があれば、直すものがある商品だけ詳細を引く
        const todo = p.images ? p.images.filter((i) => plan(i, settings) !== "skip").length : 1;
        if (todo === 0) continue;
        // 残りの呼び出しで 1 枚も直せないなら、ここで止める（次の回に続き）
        const left = Math.floor((calls - used() - 1) / CALLS_PER_IMAGE);
        if (left < 1) return { fixed, quota: false, failed };
        try {
          fixed += await fixProduct(env, counted, p.id, Math.min(budget - fixed, left), settings);
        } catch (e) {
          if (e instanceof QuotaError || e instanceof SubrequestBudget) throw e;
          failed++;
          console.error(`webp sweep: product ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (offset + 50 >= page.total) break;
    }
  } catch (e) {
    if (e instanceof QuotaError) return { fixed, quota: true, failed };
    if (e instanceof SubrequestBudget) return { fixed, quota: false, failed };
    throw e;
  }
  return { fixed, quota: false, failed };
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
    // 1 回に直すのは HOOK_IMAGES 枚まで（Banto の 10 秒・無料プランの呼び出しの上限に収める）。残りは次の知らせと見回りで
    const n = await fixProduct(env, counting(deps, 2 + HOOK_IMAGES * CALLS_PER_IMAGE).deps, productId, HOOK_IMAGES);
    seen.add(envelope.id);
    if (seen.size > 5000) seen.clear();
    return new Response(`ok: ${n} image(s)`);
  } catch (e) {
    // 枠が切れた: 再送してもらっても同じなので 200 で受け取り、定期処理が次の月に直す
    if (e instanceof QuotaError) return new Response("quota exceeded; the scheduled sweep will retry");
    // それ以外（Banto・置き場所の一時的な失敗）は 5xx で再送してもらう。理由はログにも出す
    // （Banto の配信の履歴は本文の先頭しか残さないので、Workers Logs で全文を読めるように）
    const message = e instanceof Error ? e.message : String(e);
    console.error(`webp hooks: product ${productId}: ${message}`);
    return new Response(message, { status: 502 });
  }
}

const defaultSeen = new Set<string>();
