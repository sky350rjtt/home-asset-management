# ARCHITECTURE.md — HomeAssetManagement 設計文書

本ドキュメントは `src/` 配下の実装コード（各ファイル冒頭のヘッダーコメント、および実際の呼び出し関係）
から起こしたアーキテクチャ文書。推測・一般論は含めず、コードに書かれている実態のみを記載する。

---

## 1. 設計原則

### 1.1 処理・マスタ・データの分離

コード上、明確に3層に役割が分かれている。

- **インフラ設定**（`Config.gs`）：フォルダID・APIキー・AIモデル名の管理のみ。
  ヘッダーコメントに明記：「拠点・カテゴリ（マスタ）は持たない → MastersDAO.gs が担当」
- **マスタ**（`MastersDAO.gs`）：拠点・カテゴリのリストを読むだけの読み取り専用DAO
- **データ**（`AssetMasterDAO.gs`）：台帳（トランザクションデータ）への読み書き専用DAO。
  ヘッダーコメントに明記：「データの読み書きのみ。業務ロジック（何を登録するか・ベクトル変換等）は持たない」
- **処理（ビジネスロジック）**（`Location.gs` / `AddFolder.gs` / `Scanner.gs`）：
  上記のDAO/マスタ/設定を呼び出して業務フローを組み立てる層。ロジック自体は列位置やシート構造を一切知らない

`AssetMasterDAO.gs` のコメントがこの分離の意図を最も端的に表している：

> 台帳の列配置(COL/DOC_COL)を知ってよいのは、この DAO だけ。
> 呼び出し側(Entry等)は row[13] のような生インデックスを一切触らない。

### 1.2 疎結合・単一の真実源（Single Source of Truth）

- シート名（`Constants.SHEET`）、書類種別（`Constants.DOC_TYPE`）は `Constants.gs` に一元化。
  `Constants.gs` 自身のコメントに、これが後から導入された経緯が明記されている：

  > 以前はLocation.gs/AddFolder.gsの2箇所に一言一句同じ文字列がコピペされていた
  > （本部が1箇所変えれば全店舗に伝わる、の欠如）。

- Configシートの行位置（`B5` 等）を決め打ちにせず、キー名で毎回検索する方式に統一
  （`Config.load()`, `Entry.gs` の `_writeConfigValue()` / `getModelSettings()` が同じ流儀）。
  行の増減があってもコードが壊れない設計。
- 検索用ベクトルのテキストには、拠点コード・拠点名・カテゴリコードを**意図的に含めない**
  （`VectorMaintenance.buildRichText` のコメント）：

  > ★将来の引っ越し・資産移動に対応するため、拠点(B,C列)やシステム用カテゴリコード(D列)は絶対に含めない。

  資産が拠点間で移動しても検索の意味が変わらないようにする設計判断。
- 「検索の足切りスコア閾値」や「Embeddingの次元数」はコードにハードコードされた既定値を置かない方針
  （`Config.gs` のコメント：「Configシートが唯一の真実源」「わからないから止める」を徹底）。
  未設定・不正値は握りつぶさず、その場でエラーにする **fail-fast** 方針。

### 1.3 補足：GASの実行モデルに起因する制約

Google Apps Scriptは、`.gs` ファイルを跨いだ ES Modules 的な `import`/`export` を持たず、
プロジェクト内の全ファイルの最上位の関数・`const` は**単一のグローバル名前空間を共有**する。
ファイル分割はあくまで人間可読性のための整理であり、実行時の疎結合を強制するものではない点に留意が必要。

この特性により、依存の向きを誤ったコードでも構文上はエラーにならず動いてしまう点には注意がいる。
実際に一時期、`logic/IntelligentSearch.gs` の `AiSearchNamespace.execute()` が `ui/Entry.gs` 内で定義された
グローバル関数 `_loadAssetsFromLedger()` を直接呼び出しており、「UI層をロジック層が参照する」逆依存が
発生していた。これは `shared/AssetPresenter.gs` へロジックを切り出すリファクタリングで解消済み
（2.2節参照）。GASの実行モデル自体はこの種の逆依存を防いでくれないため、依存の向きはコードレビューで
人間が意識的に保つ必要がある、という教訓として記録しておく。

---

## 2. 各ファイルの依存関係

ヘッダーコメントに明記された「他モジュールへの依存」と、実際のコード上の呼び出しを突き合わせた依存関係。

### 2.1 依存レイヤー図

```
[Layer 0: 依存なし]
  Constants.gs
  Gemini.gs      … 業務ロジックへの依存なし。通信の成否のみに集中する「純粋な通信窓口」
  SheetUtils.gs

[Layer 1: Constantsのみに依存]
  Config.gs          → Constants（SHEET.CONFIG）
  FileUtils.gs        → Constants（SUPPORTED_MIME, MIME_HEIC）
  MastersDAO.gs        → Constants（SHEET.MASTERS）
  AssetMasterDAO.gs    → Constants（SHEET.ASSET, DOC_TYPE.OTH.code）

[Layer 2: Layer0/1に依存]
  AssetPresenter.gs    → Config, AssetMasterDAO, MastersDAO, Constants
  PromptBuilder.gs     → Constants（buildDocTypePromptText, buildDocTypeShortPromptText）
  VectorMaintenance.gs → Gemini（analyze, embed）

[Layer 3: 業務ロジック]
  Location.gs          → Constants, MastersDAO, Gemini, AssetMasterDAO, VectorMaintenance, PromptBuilder, FileUtils, SheetUtils
  AddFolder.gs          → Constants, MastersDAO, Gemini, AssetMasterDAO, VectorMaintenance, PromptBuilder, FileUtils, SheetUtils
  IntelligentSearch.gs  → Config, Gemini, AssetPresenter

[Layer 4: 制御フロー]
  Scanner.gs    → Config, MastersDAO, Constants, AddFolder, Location, SheetUtils
                  （+ GAS組込 DriveApp, LockService, SpreadsheetApp）

[Layer 5: 入口・ルーティング]
  Entry.gs      → Scanner, Config, AssetMasterDAO, MastersDAO, Constants, AssetPresenter
                  （+ GAS組込 HtmlService, SpreadsheetApp）

[Layer 6: 保守バッチ（独立実行）]
  RemarksBatch.gs → Config, AssetMasterDAO, VectorMaintenance（+ DriveApp）

[Layer 7: UI（google.script.run 経由でLayer5/Layer3を呼ぶ）]
  Index.html        → Entry.gs（getModelSettings, runScanFromUI）※後方互換のため残置。doGetの既定ルーティング先
  index_viewer.html → Entry.gs（getAssetStorageData, getModelSettings, runScanFromUI, getCurrentUserRole）,
                       IntelligentSearch.gs（EXCLUSIVE_AI_VECTOR_SEARCH_ENTRANCE）
```

IntelligentSearch.gs は以前 `Entry.gs` へ逆依存していたため独立した層（旧Layer 5'）として扱っていたが、
`AssetPresenter.gs` への切り出しにより Layer 2 → Layer 3 という他の業務ロジックと同じ一方向の依存に
揃った（詳細は 1.3節、2.2節）。

### 2.2 「どれがどれを呼ぶか」個別メモ

- **Scanner.gs** はINBOX直下のサブフォルダを走査し、フォルダ名が `ADD`（大文字小文字を無視して比較）なら
  `AddFolder.process()`、それ以外はMastersの拠点コードと照合できれば `Location.process()` を呼ぶ。
  一致する拠点が無いフォルダは `console.warn` のみでスキップされ、中のファイルは一切処理・移動されない
  （個別ファイルのエラー時に行われる `UNRESOLVED/` への隔離とは異なる挙動）。
- **Location.gs / AddFolder.gs** はいずれも `MastersDAO.buildCategoryPromptText()` でカテゴリ一覧を取得し、
  `PromptBuilder.buildAssetAnalysisPrompt()` でプロンプト本文を組み立て、`Gemini.analyze()` を呼び、
  結果を `AssetMasterDAO` に書き込む前に `VectorMaintenance` でベクトル化する、という同型の流れを持つ
  （新規登録 vs 追加登録の違いは、`PromptBuilder`に渡す冒頭文と、ファイル名に使う`maker`/`modelNumber`を
  台帳の既存値と新規抽出値のどちらから優先するか、の2点のみ）。
- **PromptBuilder.gs** は資産解析プロンプトの組み立てロジックを一箇所に集約する。以前は
  `Location.gs`と`AddFolder.gs`がそれぞれ独立にプロンプト全文を保持しており、大半のフィールドの指示文が
  一字一句コピペされていた（かつ`modelNumber`/`summary`/末尾の`CRITICAL`行には、意図的な使い分けとは
  考えにくい表記ゆれが生じていた）。これを解消するためのリファクタリングで導入されたファイル
  （経緯の詳細は `SPEC.md` 7.0節）。
- **VectorMaintenance.gs** はベクトル生成の組み立てロジックを一箇所に集約しており、
  `Location.gs`（新規登録時）・`AddFolder.gs`（取説の後追加時）・`RemarksBatch.gs`（過去データ一括復旧）の
  3箇所が同じロジックを重複して持たないための共通部品、とヘッダーコメントに明記されている。
- **AssetPresenter.gs** は台帳の読み込み・見せ方への整形ロジックを一箇所に集約する。以前は
  `Entry.gs`内のグローバル関数 `_loadAssetsFromLedger()` として存在し、`IntelligentSearch.gs`（ロジック層）
  がそれを直接呼ぶ逆依存になっていた。両者が対等に依存できる Layer 2 へ切り出すことで解消した。
  `includeEmbedding`引数（`false`＝ブラウザ送信用の軽量版／`true`＝サーバー内部のAI検索専用）による
  不要データの転送カットは、切り出し後も変更せずそのまま維持している。
- **IntelligentSearch.gs** は `AssetPresenter.loadFromLedger(true)` を呼んで台帳全件（embedding付き）を
  1回だけロードし、クエリを `Gemini.embed()` でベクトル化した上で総当たりのコサイン類似度計算を行う。
- **Entry.gs** は `doGet(e)` のクエリパラメータ `p` によって配信するHTMLを切り替える唯一のルーター
  （`p=v` → `index_viewer.html`、それ以外 → `Index.html`）。台帳データの取得は
  `AssetPresenter.loadFromLedger(false)` に委譲し、`Entry.gs`自身はUI向けエンドポイント
  （`getAssetStorageData`, `getModelSettings`, `runScanFromUI`等）の提供に専念する。
- **Entry.gs の `getCurrentUserRole()`** は `Config.load()` の `ADMIN_EMAILS`（カンマ区切り文字列）にのみ依存し、
  現在アクセスしているユーザーが管理者かどうかを`'admin'|'viewer'`で返す。UIの出し分け専用（実行制御には使わない）。
  `Session.getActiveUser().getEmail()` がアクセス者本人のメールアドレスを返すのは
  `appsscript.json` の `webapp.executeAs` が `"USER_ACCESSING"` の場合のみという制約があり、
  `"USER_DEPLOYING"`（自分として実行）のままだと常に空文字を返す。この制約により、WebAppは
  `executeAs: "USER_ACCESSING"` でデプロイする方針とした（2026-08-14。詳細は`CHANGELOG.md`参照）。
  この方式では台帳スプレッドシートおよびConfig記載のDriveフォルダへの読み書きも各アクセス者自身の
  権限で実行されるため、閲覧者にもスプレッドシートの共有権限（最低限Viewer）を個別に付与する必要がある。
- **旧 `Index.html`（独立ページ）は`index_viewer.html`の`scan-sheet`（ボトムシート）に統合された**。
  `getModelSettings()`・`runScanFromUI()`の呼び出しロジック自体はそのまま`scan-sheet`側へ移植されており、
  `Entry.gs`側の変更は不要だった（両画面が同じシグネチャの関数を呼ぶだけの関係になっている）。
  `Index.html`自体は削除せず残置している。理由は`doGet(e)`の既定ルーティング（`p`パラメータ省略時の
  遷移先）としての後方互換性のため。

---

## 3. 完全流用可 / 構造流用可 / 流用不可の分類

各ファイルのヘッダーコメントに明記された分類をそのまま記載する。**明記が無いファイルは「明記なし」とし、
根拠のない推測による分類は行わない。**

### 3.1 明記されている分類

| ファイル | 分類 | 根拠（コメント原文） |
|---|---|---|
| `core/Constants.gs` | **完全流用可** | 「完全流用可。どのシステムでも変更不要。」 |
| `core/FileUtils.gs` | **完全流用可**（命名規則のみ変更の可能性） | 「完全流用可。どんなシステムでも1文字も変えず使える。命名規則（buildFileName）だけはシステムに応じて変更する可能性がある。」 |
| `core/SheetUtils.gs` | **完全流用可** | 「完全流用可。どんなシステムでも1文字も変えず使える。」 |
| `dao/MastersDAO.gs` | **構造流用可** | 「構造流用可。書類管理システムなら書類カテゴリを同じ形式でMastersシートに書けばよい。このファイルの読み込みロジックは1文字も変えず使える。」 |
| `config/Config.gs` | **流用不可**（構造は参考可） | 「流用不可。アプリごとに設定値が変わるため。ただし読み込み方の構造は他システムの参考にできる。」 |
| `shared/PromptBuilder.gs` | **流用不可** | 「流用不可。remarksの生成指示・summaryの扱い・files[]マッピング仕様など、家電資産管理という本システム固有の業務ルールがプロンプト文言に直接埋め込まれている。Constants.gs（完全流用可）にこのロジックを置くと、Constants.gsの『他システムへ持って行っても1文字も変えず使える』という前提を壊してしまうため、あえて別ファイルに分離している。」 |
| `shared/AssetPresenter.gs` | **流用不可** | 「流用不可。台帳の見せ方（id/name/loc/locName等のキー名、書類リンクの組み立て方）は本システム固有の画面仕様に合わせた設計。」 |

### 3.2 明記なし（客観的な観察に基づく参考情報）

以下のファイルはヘッダーコメントに流用可否の明記がない。実装内容から観察できる客観的な特徴のみ記す。

| ファイル | 観察される特徴 |
|---|---|
| `core/Gemini.gs` | `analyze()`/`embed()` とも、引数として渡された `apiKey`・`model`・`prompt`・Blob以外の状態を持たず、業務固有の判断（何を登録するか等）は一切含まない汎用HTTP通信層 |
| `dao/AssetMasterDAO.gs` | `COL`/`DOC_COL` というAssetMasterシート固有の列配置を直接保持しており、シート構造が変わればこのファイル自体の書き換えが前提になる |
| `logic/Location.gs`, `logic/AddFolder.gs` | プロンプト文言・カテゴリ運用・ファイル命名規則など、本システム固有の業務ルールをハードコードしている |
| `logic/Scanner.gs`, `ui/Entry.gs` | 本システムのフォルダ構成・シート構成・画面構成を前提にした制御フロー |
| `logic/IntelligentSearch.gs` | `AssetPresenter.gs` が返すオブジェクト形状（`embeddingRaw`等のキー名）を前提にしており、単独では成立しない |
| `maintenance/RemarksBatch.gs` | AssetMasterの列構成・書類保存形式（Drive上のファイルID）に強く依存する保守バッチ |
| `shared/VectorMaintenance.gs` | ベクトル化するテキストの組み立て方（製品名・メーカー・型番・remarks・summaryの結合）は本システムの台帳スキーマに合わせた設計 |
| `ui/Index.html`, `ui/index_viewer.html` | 本システムのサーバー関数名（`runScanFromUI` 等）に直接依存するフロントエンド |

---

## 4. 既知の技術的制約

### 4.1 GASの実行時間・API呼び出しレート制約への対応

コード上、以下の複数箇所で「時間のかかる処理を細切れにする」「連続API呼び出しを避ける」設計が取られている。

- **`RemarksBatch.gs`**：全件を一度に処理せず、`START_INDEX` / `BATCH_SIZE` という手動指定の安全弁を持つ。
  ヘッダーコメント／コード内コメントにも「無料枠のRPM上限に合わせて」「小分けに実行してください」と明記されている。
  1件処理するごとに `Utilities.sleep(4000)` を挟む。
- **`AddFolder.gs`**：資産グループ（1資産分のファイルセット）を処理するごとに `Utilities.sleep(4500)` を挟み、
  「連続API判定を避けるウェイト」とコメントされている。
- **`Scanner.run()`**：`LockService.getScriptLock()` + `waitLock(10000)` で二重実行を防止する。
  「メニューとWebAppから同時に実行された場合」の競合を想定した設計（ヘッダーコメントより）。
- **`Gemini.gs`**：ファイルのアップロード後、Google側の前処理完了（`ACTIVE`化）を最大36回×5秒（＝3分）
  ポーリングして待つ。`generateContent` 呼び出しは429/5xxエラー時に最大3回まで指数バックオフでリトライする
  （`5000ms * 2^(attempt-1)`）。

これらはいずれも、GASの実行時間制限やAPI無料枠のレート制限といった、
単発の巨大リクエストや連続呼び出しでは完走できない制約を前提に、
「小分け」「待機」「排他制御」で回避する設計になっていることが読み取れる。

### 4.2 Files API（resumable upload）を使う理由

`Gemini.gs` の `analyze()` は、`generateContent` にBase64等でファイルを直接埋め込むのではなく、
Gemini Files APIの**resumable upload**（`X-Goog-Upload-Protocol: resumable`）を使ってバイナリを
アップロードし、得られた一時URI (`fileData.uri`) を `generateContent` のリクエストに参照として渡す方式を取る。

コード内コメントにその意図が明記されている：

> payload: blob, // ★ 24MBのパンクを防ぐ、あなたオリジナルのストリーム仕様を完全死守！

数十MB規模になりうる説明書PDF等を、リクエストボディに全量インライン化せずストリームとして送ることで、
単一リクエストのペイロードサイズ制約による失敗を避ける設計。アップロード完了後、Google側のファイルが
`ACTIVE` になるまでポーリングしてから解析リクエストを送り、解析処理の `finally` 節で一時ファイルを
必ず削除する（後始末の徹底、`Gemini Cleanup` ログ）。

### 4.3 ベクトル検索の直列フォールバック方式

台帳検索は2段階の**直列フォールバック**構成になっている（`index_viewer.html` の `executeSearch()`）。

1. **ローカル文字列検索を先に試す**：入力クエリを正規化（`utils.normalizeText` — 全角/半角統一、
   ひらがな→カタカナ統一、大文字小文字統一、法人格ノイズ除去、空白除去）した上で、ブラウザ側に
   保持している全資産データ（`name`, `maker`, `model`, `cat`, `catName`, `remarks`）に対して
   部分一致検索を行う。**1件でもヒットすればサーバーには一切問い合わせない。**
2. **ローカルで0件だった場合のみ**、サーバー側の `EXCLUSIVE_AI_VECTOR_SEARCH_ENTRANCE()`
   （`IntelligentSearch.gs`）を呼び出し、Gemini Embeddingによる意味検索にフォールバックする。

サーバー側のベクトル検索自体も、ANNインデックス等は使わず、台帳全行のEmbedding（T列）を毎回
**総当たり**でコサイン類似度計算する方式（`AiSearchNamespace.cosineSimilarity`）。
次元数が食い違うベクトル（Embeddingモデルを途中変更した場合等）はスコア計算対象から除外される
安全策も入っている。スコアが1件も計算できなかった場合はエラーを投げる（サイレントに空結果を返さない）。
`Config.SEARCH_MIN_SCORE` 未満の結果はソート後に足切りされる。

### 4.4 その他の技術的制約・安全策

- **セル文字数上限のガード**：`VectorMaintenance.computeEmbeddingString()` は、生成したベクトルの
  JSON文字列長が45,000字を超えたら保存自体をスキップする（Google Sheetsのセル上限50,000字に接近した
  危険域での書込失敗を未然に防ぐ）。
- **Embeddingモデル変更時の次元不一致**：`Config.GEMINI_EMBED_DIMENSION` を明示指定しない限り
  モデルの既定次元に流されるため、`Gemini.embed()` は呼び出し側が必ず次元数を渡す前提の設計になっている
  （渡し忘れると「保存済みベクトルと比較不能になり、検索が静かに機能しなくなる」とコメントされている）。
- **多重実行によるファイル名破壊の防止**：`FileUtils.moveToUnresolved()` は、既に `UNRESOLVED_` が
  付与されたファイルへの再隔離時にプレフィックスを二重に積まないガードを持つ。
- **人間の入力を上書きしない設計**：`AssetMasterDAO.updatePurchaseInfo()` は対象セルが既に値を持つ場合は
  上書きしない。`N列`（廃棄日）はGASが一切書き込まない、完全に人間の手動運用に委ねる列として設計されている。
- **AIによるS列（remarks）上書きの監査**：`AddFolder.gs` は取説追加時にS列を再生成する際、
  上書き前の既存値と新しい値が異なればログシートに `REMARKS_OVERWRITTEN` として記録する
  （上書き自体は止めないが、消えたことを人間が追跡できるようにする）。
