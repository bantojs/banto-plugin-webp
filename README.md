# banto-plugin-webp

[Banto](https://github.com/bantojs/banto) の商品の画像を **WebP（長辺 1600px）** にし、一覧用の **サムネイル（長辺 400px）** を作る外部プラグインです。
変換には Cloudflare Images を使い、自分の Cloudflare アカウントに Worker を 1 つ置いて動かします。

> **無保証です。** MIT ライセンスで、現状のまま提供します（[LICENSE](LICENSE)）。開発チームはこのプラグインを置いた Worker のホスティング・稼働に責任を持ちません。テレメトリは送りません。

**Banto 本体のコードは一切読み込まず**、Banto の公開の契約（[hooks](https://github.com/bantojs/banto/blob/main/docs/hooks.md) のマニフェスト・署名・再送と、[AI 用 API](https://github.com/bantojs/banto/blob/main/docs/api.md)）だけで動きます。
必要な Banto: **データベースの更新 0077_api_image_replace が当たっていること**（`PUT /api/v1/images/{id}/file`）。

| ファイル | 役割 |
| --- | --- |
| `src/plugin.ts` | 本体。`handleRequest`（hooks）と `sweep`（見回り）。ランタイムに依存しない。変換（`convert`）は差し替えられる |
| `src/index.ts` | Cloudflare Workers の入口。変換は Cloudflare Images の binding |
| `wrangler.toml` | Workers の設定（Images の binding・1 時間ごとの見回り） |
| `test/plugin.test.ts` | 署名（Banto の docs/hooks.md §3 の見本）・何を直すか・差し替えの本文・枠切れ・見回りのテスト（`npm test`） |

## なぜ外部プラグインか

管理画面から商品の画像を上げると、ブラウザが WebP とサムネイルにしてから送ります。
ただ、Banto のサーバー（Worker）は画像を処理しません（Workers の CPU の制限と、Cloudflare 固有の機能をコアで使わない方針のため）。
そのため、次の画像は元の形式（JPEG・PNG）のまま、サムネイルも無いままです。

- WooCommerce の取り込みで、裏（Cron）で取り込んだ画像
- AI 用 API の URL からの取り込み（`POST /products/{id}/images`）
- 前から入っている画像

このプラグインは、それを外で作り直して Banto に戻します。

## 動き

1. Banto が `product.updated` を送る。商品を保存したときだけでなく、画像を足した・変えたときにも届きます（0075）。
2. プラグインが、その商品の画像を AI 用 API（`products:read`）で読む。
3. WebP でない画像・サムネイルの無い画像だけを、置き場所（`BANTO_MEDIA_URL`）から取ってきて変換する。
   - JPEG・PNG: 本画像（1600px）とサムネイル（400px）の 2 回変換します。
   - WebP・AVIF でサムネイルが無いもの: 本画像はそのまま、サムネイルだけを作ります（1 回）。
   - GIF は飛ばします（動きを失わないため）。
4. `PUT /api/v1/images/{id}/file`（`products:write`、0077）で差し替える。並び順・SKU への結び付けはそのままで、前のファイルは Banto が消します。
5. 差し替えるとまた `product.updated` が届きますが、もう直した画像は飛ばすので繰り返しません。

さらに **1 時間に 1 回、全商品を見回り**、残っている画像を 20 枚（`SWEEP_BUDGET`）まで直します。前から入っている画像と、枠が切れて止まった分はここで片付きます。

## Cloudflare Images の料金

- 無料プランは **1 か月に 5,000 回の変換**まで（[公式の料金](https://developers.cloudflare.com/images/pricing/)）。1 枚の画像につき 2 回なので、**1 か月に約 2,500 枚**です。
- 無料プランで超えると、変換がエラー（`9422`）になるだけで、お金はかかりません。このプラグインは、そのときは何も置かずに止まり、次の月の見回りで続きから直します。
- 前からの画像をまとめて直すときは超えやすいです。例: 1 万枚なら 2 万回です。無料のままなら 4 か月に分かれます。有料にすれば、超えた分は 1,000 回ごとに $0.50 です。
- Images に画像を置く（保存・配信）機能は使いません。置き場所は今までどおり Banto の R2 です。

## 置き方

### A. Deploy ボタン

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bantojs/banto-plugin-webp)

画面で `BANTO_API_URL`・`BANTO_MEDIA_URL`・`BANTO_API_TOKEN` を入れます（下の表）。`BANTO_HOOK_SECRET` は、Banto に送信先を登録したあとで入れ直します（手順 2）。

### B. コマンドで（開発者向け）

```bash
git clone https://github.com/bantojs/banto-plugin-webp.git
cd banto-plugin-webp
npm install
npx wrangler secret put BANTO_API_TOKEN   # Banto の管理画面 → AI 連携（トークン）で発行（products:read + products:write）
npx wrangler deploy                       # https://banto-plugin-webp.<あなた>.workers.dev
```

### 値を入れる

Cloudflare の画面 → Workers & Pages → banto-plugin-webp → 設定 → **変数とシークレット** に、次の 2 つを変数で入れます。

| 名前 | 値 |
| --- | --- |
| `BANTO_API_URL` | `https://<Banto の URL>/api/v1` |
| `BANTO_MEDIA_URL` | Banto の `MEDIA_BASE_URL`（R2 の独自ドメイン、例 `https://media.example.com`）。設定していなければ `https://<Banto の URL>/media` |

1. Banto の管理画面 → ショップ → **連携** → **送信先を追加** に、上の Worker の URL を入れます。マニフェストが読まれ、購読は `product.updated` だけになります。
2. 保存すると **署名シークレット** が表示されるので、`npx wrangler secret put BANTO_HOOK_SECRET` で貼ります。
3. 商品の画像を足すと、数分以内（hooks の配信は 5 分ごとの Cron）に WebP とサムネイルに替わります。前からの画像は、1 時間ごとの見回りで少しずつ替わります。

Banto のデータベースに **0077_api_image_replace** が当たっていないと、差し替えは 409 `migration_required` になります（Banto の管理画面の「アップデート」で当てます）。

`BANTO_API_TOKEN` は商品を書き換えられるトークンです。**変数ではなくシークレット**に入れ、このプラグインのためだけに発行してください（漏れたら Banto の管理画面で取り消します）。

## うまくいかないとき

- **Banto のテスト送信（banto.ping）が届かない（このプラグインのログに何も出ない）**: Banto とこのプラグインを同じ Cloudflare アカウントに置くと、Cloudflare は Worker から Worker への fetch を error 1042 で断ります。両方の設定に `compatibility_flags = ["global_fetch_strictly_public"]` が要ります（このリポジトリの `wrangler.toml` には入っています）。Banto の側は、最新の `wrangler.jsonc` に更新してください。
- **400 bad signature**（ログに `webp hooks: bad signature`）: `BANTO_HOOK_SECRET` を Banto の送信先の画面からコピーし直します。

## ログ

`wrangler.toml` で Cloudflare のログ（Workers Logs）を ON にしてあります。
Cloudflare の画面 → Workers & Pages → banto-plugin-webp → **ログ** で、見回りの結果（`webp sweep: fixed 3`）や、差し替えに失敗したときの理由（hooks への 502 の本文）が見られます。

- 失敗を原因ごとにまとめる **Issues** も ON です。**Traces** は切ってあります（遅い原因を探すときだけ `[observability.traces] enabled = true`）。
- ログは自分の Cloudflare アカウントに数日だけ残ります。開発チームには届きません。
- 要らなければ `wrangler.toml` の `[observability]` を `enabled = false` にします。ダッシュボードで切っても、次のデプロイで `wrangler.toml` のとおりに戻ります。

## 開発

```bash
npm install
npm run lint   # 型の検査
npm test       # テスト
npm run build  # Workers 向けのビルド（dry-run）
```

## ほかのランタイムで動かす

`src/plugin.ts` は `fetch` と変換の関数（`convert`）を受け取るだけです。Node なら `convert` を sharp などで書き、`handleRequest` と `sweep` を呼べば動きます。

## ライセンス

MIT（[LICENSE](LICENSE)）。脆弱性の報告は [SECURITY.md](SECURITY.md)。
