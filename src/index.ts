import { QuotaError, handleRequest, sweep, type Converter, type PluginEnv } from "./plugin";

/** Cloudflare Workers の入口。変換は Cloudflare Images の binding（wrangler.toml の [images]） */
interface Env extends PluginEnv {
  IMAGES: ImagesBinding;
  /** 定期処理が 1 回に直す枚数（既定 20） */
  SWEEP_BUDGET?: string;
}

const streamOf = (bytes: Uint8Array) => new Response(bytes).body!;

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
  fetch: (req: Request, env: Env): Promise<Response> => handleRequest(req, env, { fetch, convert: imagesConverter(env.IMAGES) }),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const budget = Number(env.SWEEP_BUDGET ?? 20);
    ctx.waitUntil(sweep(env, { fetch, convert: imagesConverter(env.IMAGES) }, Number.isFinite(budget) && budget > 0 ? budget : 20).then((r) => console.log(`webp sweep: fixed ${r.fixed}${r.quota ? " (quota exceeded)" : ""}`)));
  },
};
