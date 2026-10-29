# Security Policy

## 報告方法

脆弱性を見つけた場合は、公開 Issue や Pull Request に書かず、GitHub の **非公開の脆弱性報告** から送ってください。

1. https://github.com/bantojs/banto-plugin-webp/security/advisories/new を開く（リポジトリの **Security** タブ → **Report a vulnerability**）
2. 影響する機能・再現手順・影響範囲を書く。ログや設定を貼るときは、トークン・署名シークレットを消す

Banto 本体の脆弱性は [bantojs/banto](https://github.com/bantojs/banto/security/advisories/new) へ報告してください。

## 対象

- このリポジトリの最新リリースおよび `main` ブランチ

## 対象外

- 運営者自身の Cloudflare の設定ミス（トークンを変数（Secret でない）に置いた、など）
