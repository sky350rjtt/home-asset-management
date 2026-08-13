# HomeAssetManagement

家庭の家電・書類をAIで自動整理し、一元管理するシステム。

## 概要

INBOXフォルダにPDFを投入すると、Gemini APIが内容を解析し、
自動でファイル名を整え、台帳に登録、整理フォルダへ移動する。

## 技術構成

- Google Apps Script (バックエンド)
- Google Sheets (データベース)
- Google Drive (ファイルストレージ)
- Gemini API (文書解析・ベクトル検索)
- Tailwind CSS (フロントエンド)

## ディレクトリ構成

| パス | 役割 |
|---|---|
| `src/core/` | 全システム共通・他プロジェクトへ流用可 |
| `src/dao/` | データアクセス層(シートの読み書き) |
| `src/logic/` | ビジネスロジック層 |
| `src/ui/` | フロントエンド・エントリポイント |
| `docs/` | 設計ドキュメント |

## セットアップ

1. Google スプレッドシートを作成
2. Config シート・Masters シートを作成(詳細は docs/SPEC.md)
3. src/ 配下のファイルをGASプロジェクトへ反映する（以下いずれか）
   - GASエディタに直接配置（手動コピペ）
   - [clasp](https://github.com/google/clasp) でpush（`.devcontainer/` に開発環境あり。下記参照）
4. Gemini API キーを Config シートに設定
5. WebApp としてデプロイ（`webapp.executeAs` は `USER_ACCESSING`。詳細は `docs/ARCHITECTURE.md` 2.2節）

## GAS開発環境（clasp）

VS Codeの「Dev Containers」拡張でこのリポジトリを開くと、Node.js + clasp の環境が立ち上がる。

1. コンテナ起動後、初回のみ認証：`npm run login`（`--no-localhost`でURLが表示されるので、
   ブラウザで開いて認可コードをターミナルに貼り付ける）
2. `.clasp.json` の `scriptId` を、対象のApps ScriptプロジェクトのスクリプトID
   （GASエディタ → プロジェクトの設定 → スクリプトID）に書き換える
3. `npm run push` でこのリポジトリの内容をApps Scriptプロジェクトへ反映する
   （**注意**：Apps Script側の内容を上書きする。手動編集分が反映されていない場合は先に`npm run pull`で
   差分を確認する）

主なコマンド：`npm run push` / `npm run pull` / `npm run status` / `npm run open`（GASエディタを開く）/
`npm run deploy`

## 設計原則

- 処理・マスタ・データを混ぜない
- 疎結合(各モジュールは互いを知らない)
- 人間の注意力に頼らず、仕組みで正しさを担保する

詳細は `docs/ARCHITECTURE.md` を参照。

## ライセンス

Private / 個人利用