import { QuotaError, handleRequest, sweep, type Converter, type PluginEnv } from "./plugin";

/** Cloudflare Workers の入口。変換は Cloudflare Images の binding（wrangler.toml の [images]） */
interface Env extends PluginEnv {
  IMAGES: ImagesBinding;
  /** 定期処理が 1 回に直す枚数（既定 20） */
  SWEEP_BUDGET?: string;
  /** 定期処理が 1 回に使う外への呼び出しの数（既定 45。Workers の無料プランの上限は 50、有料プランなら 900 などに上げられる） */
  SWEEP_SUBREQUESTS?: string;
}

const streamOf = (bytes: Uint8Array) => new Response(bytes).body!;
/** 組み込みの fetch をそのまま渡すと、deps.fetch(...) の形で呼ばれたときに Illegal invocation になるので包む */
const fetchFn: typeof fetch = (input, init) => fetch(input, init);

function imagesConverter(images: ImagesBinding): Converter {
  return async (bytes, { width, quality }) => {
    try {
      const out = await images.input(streamOf(bytes)).transform({ width, fit: "scale-down" }).output({ format: "image/webp", quality });
      return new Uint8Array(await new Response(out.image()).arrayBuffer());
    } catch (e) {
      // 9422: その月の変換の枠を使い切った（無料プランは 1 か月 5,000 回。超えてもお金はかからず、この失敗になる）
      if ((e as { code?: unknown }).code === 9422 || /9422/.test(String((e as Error).message))) throw new QuotaError();
      throw e;
    }
  };
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handleRequest(req, env, { fetch: fetchFn, convert: imagesConverter(env.IMAGES) }),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    ctx.waitUntil(
      sweep(env, { fetch: fetchFn, convert: imagesConverter(env.IMAGES) }, num(env.SWEEP_BUDGET, 20), num(env.SWEEP_SUBREQUESTS, 45)).then(
        (r) => console.log(`webp sweep: fixed ${r.fixed}${r.failed ? `, failed ${r.failed}` : ""}${r.quota ? " (quota exceeded)" : ""}`),
        (e: unknown) => console.error(`webp sweep: ${e instanceof Error ? e.message : String(e)}`),
      ),
    );
  },
};
