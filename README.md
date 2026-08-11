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
3. GASエディタに src/ 配下のファイルを配置
4. Gemini API キーを Config シートに設定
5. WebApp としてデプロイ

## 設計原則

- 処理・マスタ・データを混ぜない
- 疎結合(各モジュールは互いを知らない)
- 人間の注意力に頼らず、仕組みで正しさを担保する

詳細は `docs/ARCHITECTURE.md` を参照。

## ライセンス

Private / 個人利用