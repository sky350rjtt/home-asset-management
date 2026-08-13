# SPEC.md — HomeAssetManagement 仕様書

本ドキュメントは `src/` 配下の実装コード（コメント含む）から起こした仕様書。
推測・一般論は含めず、コードに書かれている実態のみを記載する。

---

## 1. システムの目的・概要

家庭の家電・書類（取扱説明書／領収書／保証書等）を Gemini API で自動解析し、
ファイル名の整形・台帳（Google スプレッドシート）への登録・Google Drive 上の
整理フォルダへの移動までを自動化するシステム。

- Google Drive の `INBOX/` フォルダに PDF・画像を投入すると、Gemini API が内容を解析する
- 解析結果から資産情報（メーカー・型番・カテゴリ・購入情報等）を抽出し、
  `AssetMaster` シート（台帳）に登録する
- 登録済み資産に対しては、書類を追加登録できる（`ADD/` フォルダ経由）
- 台帳データは Web アプリ（Viewer 画面）から検索・閲覧できる。検索はキーワードの
  部分一致に加え、Gemini Embedding によるベクトル検索（意味検索）にも対応する

技術構成（README.md より）：Google Apps Script（バックエンド）／Google Sheets（DB）／
Google Drive（ファイルストレージ）／Gemini API（文書解析・ベクトル検索）／Tailwind CSS（フロント）。

---

## 2. ディレクトリ構成と各フォルダの役割

各ファイル冒頭のヘッダーコメントに明記された役割。

```
src/
├── config/
│   └── Config.gs            インフラ設定（フォルダID・APIキー・AIモデル名）の読み込み専用
├── core/                    全システム共通・他プロジェクトへの流用を前提としたユーティリティ層
│   ├── Constants.gs         全システム共通の定数の唯一の真実源
│   ├── FileUtils.gs         ファイル操作（取得・移動・命名規則の適用）のみ
│   ├── Gemini.gs            Gemini API（解析／Embedding）との純粋な通信窓口
│   └── SheetUtils.gs        スプレッドシート操作ユーティリティ（シート取得・ログ記録）
├── dao/                     データアクセス層（DAO = Data Access Object）
│   ├── AssetMasterDAO.gs    AssetMasterシートへの読み書き専用。列定義(COL/DOC_COL)もここで管理
│   └── MastersDAO.gs        Mastersシート（拠点・カテゴリ）の読み込み専用（読み取り専用）
├── logic/                   ビジネスロジック層
│   ├── AddFolder.gs         ADD/ フォルダの処理（既存資産への書類追加）
│   ├── IntelligentSearch.gs Viewerからのベクトル検索リクエストの受付とスコア順ソート
│   ├── Location.gs          拠点フォルダ（H01/等）の処理（新規資産登録）
│   └── Scanner.gs           INBOX/ 配下を走査し、処理フロー全体を制御
├── maintenance/
│   └── RemarksBatch.gs      過去データの remarks/embedding をPDF実物から一括復旧する保守バッチ
├── shared/                  本システム固有の共通処理（複数箇所から呼ばれる）
│   ├── AssetPresenter.gs    台帳の読み込み・画面表示用整形ロジック（Entry.gs/IntelligentSearch.gsが共用）
│   ├── PromptBuilder.gs     資産解析用Geminiプロンプトの組み立てロジック（Location/AddFolderが共用）
│   └── VectorMaintenance.gs 検索用ベクトル生成処理の共通部品（Location/AddFolder/RemarksBatchが共用）
└── ui/                      フロントエンド・エントリポイント
    ├── Entry.gs             システムの入口・マルチ画面ルーティング・データ中継
    ├── Index.html           スキャン実行用トップ画面（WebApp既定ページ）
    └── index_viewer.html    台帳閲覧・検索用Viewer画面（`?p=v` でアクセス）
```

`docs/` はこのような設計ドキュメントの置き場所（README.md より）。

---

## 3. Config / Masters シートの構造

### 3.1 Config シート（`Config.gs`）

- 形式：**A列＝キー、B列＝値**。行位置は決め打ちにせず、キー名で検索する方式（`getModelSettings`, `_writeConfigValue` も同様）。
- 読み込みはモジュール内でキャッシュされ、`Config.clear()` で再読込可能。

| キー | 必須 | 説明 |
|---|---|---|
| `GEMINI_API_KEY` | ✅必須 | Gemini API キー |
| `INBOX_FOLDER_ID` | ✅必須 | 投入用フォルダのID |
| `DOCS_FOLDER_ID` | ✅必須 | 処理済みファイルの移動先フォルダID |
| `UNRESOLVED_FOLDER_ID` | ✅必須 | エラー隔離フォルダID |
| `GEMINI_EMBED_DIMENSION` | ✅実質必須 | Embeddingの出力次元数（数値）。未設定・不正値は即エラー。**コード側にハードコードされた既定値は置かない方針**（「Configシートが唯一の真実源」） |
| `GEMINI_MODEL` | 任意（空文字許容） | 解析に使うモデル名。Configシート側でドロップダウン（入力規則）による選択式。`CONFIG_KEY.GEMINI_MODEL` 経由でキー名検索される |
| `GEMINI_EMBED_MODEL` | 任意（空文字許容） | Embedding生成用モデル名 |
| `ASSET_MASTER_ID` | 任意（空文字許容） | 台帳スプレッドシートのID。未設定時はアクティブなスプレッドシート自身を台帳として使う（`AssetMasterDAO._getSheet`） |
| `GEMINI_SEARCH_MIN_SCORE` | 任意 | 検索結果の足切りスコア閾値。未設定時は `0`（足切りしない）。**「適切な閾値」はコードが決め打ちすべきものではない**という方針でConfigシート側に置く |
| `ADMIN_EMAILS` | 任意（空文字許容） | 管理者のGoogleアカウントのメールアドレスをカンマ区切りで1セルに記入する（例: `taro@gmail.com,hanako@gmail.com`）。`Entry.gs`の`getCurrentUserRole()`がUIの出し分け（登録FABの表示可否）にのみ使用する。未設定でもエラーにせず、空配列として扱われる（fail-fastの対象外。閲覧機能自体はこれが無くても成立するため） |

必須4項目（`GEMINI_API_KEY` / `INBOX_FOLDER_ID` / `DOCS_FOLDER_ID` / `UNRESOLVED_FOLDER_ID`）のいずれかが空なら
`Config.load()` の時点でエラーになる（fail-fast）。

### 3.2 Masters シート（`MastersDAO.gs`）

- 形式：**A列＝キー、B列＝名前、C列＝補足**。A列の値のプレフィックスでセクションを判別する（見出し行等の区切りは存在せず、全行を先頭から走査する）。

**拠点セクション**（`LOCATION_` で始まる行）
- `LOCATION_{コード}_NAME` 行のみを読む（B列＝拠点の表示名、例: Nerima）
- `LOCATION_{コード}_TYPE` 行は完全に無視される（残しても削除してもどちらでも動作する）
- 名前（B列）が取得できた拠点のみ有効な拠点として扱われる

**カテゴリセクション**（`CATEGORY_` で始まる行）
- `CATEGORY_{コード}` 行：B列＝カテゴリ名、C列＝例示（プロンプト用の説明文に使われる）

拠点・カテゴリともに1件も無ければ `MastersDAO.load()` の時点でエラーになる（fail-fast）。
`buildCategoryPromptText()` は `"{code}={name}（{examples}）"` の形式で改行区切りの文字列を組み立て、
Gemini解析プロンプトの「カテゴリ一覧」として動的に注入される。

---

## 4. AssetMaster シートの列構成（COL定義）

列定義は `AssetMasterDAO.gs` の `COL` / `DOC_COL` が唯一の真実源。
「台帳の物理列を知ってよいのはこの DAO だけ」という方針で、呼び出し側（Entry.gs等）は
生の列インデックスに一切触れない。

| 列 | 定数名 | 内容・備考 |
|---|---|---|
| A (1) | `ASSET_ID` | 資産ID（命名規則は5章参照） |
| B (2) | `LOC_CODE` | 拠点コード（例: H01） |
| C (3) | `LOC_NAME` | 拠点名（例: Nerima） |
| D (4) | `CATEGORY` | カテゴリコード |
| E (5) | `MAKER` | メーカー名 |
| F (6) | `PRODUCT` | 製品名 |
| G (7) | `MODEL` | 型番 |
| H (8) | `INSTALL` | COL定義には存在するが、`readAll()` / `insert()` を含めどのロジックからも読み書きされていない列（DAOのコード上、用途の記載なし）。手動入力用の設置場所メモ欄として用意されているが、現時点では未使用。削除のコストに見合わないため、使わないまま放置する方針(2026年時点) |
| I (9) | `REG_YEAR` | 登録年（西暦下2桁）。`insert()` 時に `new Date().getFullYear()` から自動セットされる |
| J (10) | `PURCHASE_DATE` | 購入日（`YYYY/MM/DD`）。領収書等から抽出 |
| K (11) | `PURCHASE_PRICE` | 購入価格（通貨記号なしの数値） |
| L (12) | `PURCHASE_STORE` | 購入店舗（チェーン名のみ、例: ビックカメラ池袋店→ビックカメラ） |
| M (13) | `WARRANTY_EXP` | 保証期限（`YYYY/MM/DD`）。保証書から抽出 |
| N (14) | `DISPOSED` | 廃棄日。**空欄＝稼働中／日付記入＝廃棄**。GASは一切書き込まない、人間の手動運用専用列 |
| O (15) | `MNL` (`DOC_COL.MNL`) | 取扱説明書のファイルID（カンマ区切りで複数格納可） |
| P (16) | `RCP` (`DOC_COL.RCP`) | 領収書のファイルID |
| Q (17) | `WRT` (`DOC_COL.WRT`) | 保証書のファイルID |
| R (18) | `OTH` (`DOC_COL.OTH`) | その他書類のファイルID |
| S (19) | `REMARKS` | 人間用＆AI用の言い換え検索キーワード（Geminiが生成、人間も編集しうる） |
| T (20) | `EMBEDDING` | AI専用のベクトル格納庫。1024次元（Config次第）のJSON配列文字列 |

備考：
- 台帳の物理列数（`WIDTH`）は `COL` の最大値から自動算出されるため、列を増やしても追従する。
- `S列`（REMARKS）と `T列`（EMBEDDING）は物理的に隣接しているため、`updateRemarksAndEmbedding()` は
  1回のAPI呼び出し（`getRange(row,19,1,2)`）でまとめて書き込む。remarksとembeddingは常にセットで
  更新される情報であり、ネットワーク往復削減と「片方だけ書けて片方が失敗する中途半端な状態」の回避が目的。
- `J`〜`M`列（購入情報）は `updatePurchaseInfo()` で「既存セルが空のときだけ」上書きする（人間の入力を消さない）。

---

## 5. 資産IDの命名規則

`AssetMasterDAO.assignId(assetMasterId, locationCode, categoryCode)` が生成する。

```
{拠点コード}{カテゴリコード}{西暦下2桁}{連番3桁}
例: H01REF26001
```

- `locationCode` / `categoryCode` が空の場合はその場でエラーにする（fail-fast。プレフィックスが
  意味を持たない不正なIDが黙って発行されるのを防ぐ）。
- `prefix = locationCode + categoryCode + 現在年の下2桁` を組み立てる
- 連番の桁数は `SEQ_DIGITS = 3` で固定。**ID全体の期待文字列長は `prefix.length + SEQ_DIGITS` として
  毎回動的に算出する**（以前は `11` / `substring(8, 11)` という固定値のハードコードだったが、
  拠点コード・カテゴリコードの文字数が変わった際に静かに壊れる問題があったため、
  実際に組み立てた `prefix` の長さから算出する方式に修正した）。
- 台帳の既存ID群から `prefix` が一致し、かつ文字列長が期待長と一致するものだけを対象に、
  `prefix.length` 文字目以降の `SEQ_DIGITS` 桁を連番として抽出し最大値を求める
- 新しい連番は最大値+1を `SEQ_DIGITS` 桁ゼロ埋め（`padStart(SEQ_DIGITS, '0')`）して `prefix` に連結する
- **桁あふれの検知**：連番が `SEQ_DIGITS` 桁（999まで）を超える場合、ゼロ埋め後の文字列長が
  `SEQ_DIGITS` と一致しなくなる。これを検知したらエラーを投げて処理を止める。桁あふれしたIDを
  黙って発行すると、以後の同一 `prefix` に対する最大値検出（文字列長の一致判定）が効かなくなり、
  連番が1から再スタートしてID衝突を起こす恐れがあるため。

ファイル名からのID抽出は `FileUtils.extractAssetId(filename)` が担当し、
正規表現 `^([A-Z0-9]+)_` でファイル名先頭のアンダースコアまでの英数字を取り出し、大文字化して返す。

---

## 6. ファイル命名規則

### 6.1 投入時（`ADD/` フォルダのみ）

`ADD/` フォルダに置くファイルは、ファイル名の先頭に対象資産の `assetId` を付ける必要がある。

```
{assetId}_任意の名前.pdf   例: H01REF26001_任意の名前.pdf
```

先頭に有効な `assetId` が見つからない、または台帳に該当行が無い場合は
`UNRESOLVED_{理由コード}_元のファイル名` にリネームされ `UNRESOLVED/` へ隔離される
（理由コード: `NO_ASSET_ID`, `INVALID_ASSET_ID`）。
既に `UNRESOLVED_` が付いているファイルには二重に付与しない（多重付与ガード、`FileUtils.moveToUnresolved`）。

拠点フォルダ（`Location.gs` が処理する新規登録側）には、この命名規則の制約はない。

### 6.2 処理後（システムが自動リネーム、`FileUtils.buildFileName`）

```
{assetId}_{docType}_{maker}_{modelNumber}_{連番}.{拡張子}
```

- 空パーツはアンダースコアを詰めて除去される（`buildFileName`）
- `docType`: `MNL` / `RCP` / `WRT` / `OTH`（6章下記のDOC_TYPE参照）
- `maker` / `modelNumber`:
  - `Location.gs`（新規登録）: Geminiが抽出した値をそのまま使う
  - `AddFolder.gs`（既存資産への追加）: **台帳側の既存値を優先**し（`assetInfo.maker || info.maker`）、
    台帳が空の場合のみ新規抽出値を使う
- 連番:
  - `Location.gs`: 同一バッチ内での `docType` ごとのカウント（1から開始、`docTypeCounts`）
  - `AddFolder.gs`: 台帳の該当セルに既に入っているカンマ区切りファイルIDの件数+1（`getNextSeq`）。
    追加登録では連番が資産の書類全体を通して続く（バッチ内で1から振り直されない）
- 拡張子: MIMEタイプから決定（`image/jpeg`→`jpg`, `image/png`→`png`, それ以外→`pdf`）。元の拡張子は見ない

エラー時・型番未検出時等は `UNRESOLVED_{理由コード}_元のファイル名` にリネームされる
（理由コード: `NO_ASSET_ID`, `INVALID_ASSET_ID`, `NO_MODEL`（Location.gsのみ）, `PROCESS_ERROR`）。

### 6.3 書類種別（DOC_TYPE、`Constants.gs`）

| コード | ラベル |
|---|---|
| `MNL` | 取扱説明書 / Manual |
| `RCP` | 領収書 / Receipt |
| `WRT` | 保証書 / Warranty |
| `OTH` | その他 / Other |

これは唯一の定義箇所であり、JS側の比較 (`dt === ...`) とAIプロンプトの説明文の両方に反映される。
「以前はLocation.gs/AddFolder.gsの2箇所に一言一句同じ文字列がコピペされていた」問題を解消するため
`Constants.buildDocTypePromptText()` / `buildDocTypeShortPromptText()` に集約されている。

---

## 7. Gemini プロンプトの設計方針

プロンプトの実体は2種類：`PromptBuilder.buildAssetAnalysisPrompt()`（資産解析の本体、
`Location.gs`＝新規登録と`AddFolder.gs`＝既存資産への追加の両方が共用）、
`VectorMaintenance._buildExtractPrompt`（過去データ復旧バッチ専用の簡易版）。

### 7.0 共用化の経緯

`Location._buildPrompt` と `AddFolder._buildPrompt` はもともと別々にプロンプト全文を保持しており、
`docType`/`maker`/`productName`/`category`/`purchaseDate`/`purchasePrice`/`purchaseStore`/
`warrantyExpiry`/`remarks`/`files[]`スキーマは一字一句同一の文字列が2箇所にコピペされていた。
一方で `modelNumber`・`summary`・末尾の`CRITICAL`行には、意図的な使い分けとは考えにくい
表記ゆれ（ラベル列挙の全角/半角スペース違い、片方にしか無い注意書き等）が生じていた。

これを解消するため、共通部分の組み立てロジックを `shared/PromptBuilder.gs` に切り出した。
`Constants.gs` は「完全流用可（他システムでも1文字も変えず使える）」という前提を持つファイルであり、
そこに家電資産管理固有の業務ルール（remarksの生成指示・files[]マッピング仕様等）を書き込むと
その前提自体が崩れてしまうため、あえて `core/` ではなく `shared/`（`VectorMaintenance.gs`と同様、
本システム固有の共通処理を置く場所）に配置している。`Constants.gs`側は書類種別コード等の
「定義」のみを保持し、`PromptBuilder.gs`がその定義を使って実際のプロンプト文字列を組み立てる
「ロジック」を担う、という役割分担になっている。

`Location.gs`と`AddFolder.gs`に残る差異は、対象が新規資産か既存資産かという文脈を説明する冒頭の1文のみ
（`buildAssetAnalysisPrompt(introText, catText)` の `introText` 引数として渡す）。それ以外の項目で
見つかった表記ゆれは、以下の方針で統合した：
- `modelNumber`のラベル列挙にあった全角/半角スペースの違いは、「スペースの有無は同一ラベルの表記ゆれとして
  同一視してよい」という説明に書き換え、片方にしか無かった「～シリーズのような余計な文字は不要」という
  注意書きは両方の文脈に有効なため両方に適用
- `summary`の指示は、より詳しい説明（保存されず検索マッチングにのみ使うこと、取説が無ければ推測しないこと）
  を含むLocation側の文言に統一
- 末尾の`CRITICAL`行は、Location側にあった「ファイル名とdocTypeの対応付けが必須」という指示と、
  AddFolder側にあった「modelNumberが主キーであること・読み取れない項目はnullを返すこと」という指示を
  1本にまとめた

### 7.1 共通方針

- **単一JSONオブジェクトのみを返させる**（"No preamble, explanation, or markdown fences"）。
  Gemini.gs側はマークダウンの ` ```json ` フェンスが付いても弾けるよう、正規表現 `\{[\s\S]*\}` で
  本文からJSON構造だけを抜き出す安全パースを行う（応答前後の余計なテキストに強い設計）。
- `docType` の選択肢文言・カテゴリ一覧はハードコードせず、`Constants` / `MastersDAO` から動的生成して注入する
  （マスタや書類種別の定義を変えればプロンプトにも自動反映される）。
- `generationConfig.temperature: 0.1` の低温設定で、構造化抽出のブレを抑える。
- 複数ファイル（説明書・保証書・領収書など）を1リクエストにまとめて渡し、Geminiに横断的に統合解析させる
  （`Gemini.analyze` はアップロード時に各ファイルの一時URIと元ファイル名の対応表 `fileContext` を
  プロンプト本文の先頭に付加し、「どのファイルがどの`docType`か」を `files[]` 配列で回答させる）。
- 返ってきた `files[].filename` は元のファイル名と完全一致しない場合があるため、
  呼び出し側（Location.gs/AddFolder.gs）は大文字小文字を無視した部分一致（相互の `includes`）で
  ファイルとdocTypeを対応付ける。

### 7.2 主要フィールドの設計意図

- `maker`: 「一般的な企業名」「英語表記の大文字小文字は企業ロゴに従う」と明示し、
  パナソニック→Panasonic、シャープ→SHARP、東芝→TOSHIBA等の実例をプロンプトに列挙して表記揺れを防ぐ。
  不明・OEMは `OTH`。
- `modelNumber`: 「primary identifier」として最重要視。表紙・仕様ページ・最終ページまで全ページを見るよう指示し、
  「型番/形名/品番/MODEL NO/型式」を対象ラベルとして提示（ラベル中の空白の有無は同一ラベルの表記ゆれとして
  同一視してよい旨を明記）。マーケティング上の「～シリーズ」等のサフィックスは除外し、実際の型番コードのみを
  返すよう指示。複数ある場合は最初の値を採用。
- `remarks`（あいまい検索ワード、S列に保存）: 5〜8個のカンマ区切り日本語キーワードを生成させる。
  以下を**必ず含めるよう明示的に指示**：
  1. メーカー名の完全な表記揺れ（英語なら必ずカタカナ・ひらがな変換も含める。例: SONY→ソニー/そにー）
  2. 製品名の同義語・言い換え（例: 電子レンジ→レンジ、オーブン）
  3. 口語表現・主要な動作語（例: チンするやつ、温め、冷やす、洗濯）
  4. 表記種別のバリエーション（漢字/カタカナ/ひらがな混在）
  安全上の警告・トラブルシューティング由来のノイズ語は絶対に含めないことも明示。
- `summary`（要約文）: **説明書(MNL)が実際に含まれる場合のみ**生成させ、無ければ`null`を返すようプロンプトで指示。
  さらにコード側でも二重に防御しており、`info.files` の判定結果に実際にMNLが1件も含まれていなければ
  （AIがハルシネーションで何か書いてしまうリスクに備え）機械的に `summary` を破棄する
  （`Location.gs`: `hasManual` 判定、`AddFolder.gs`: `hasManual` 判定）。
  `summary` はベクトル化のためだけに使われ、**どの列にも保存されない使い捨てデータ**（`VectorMaintenance.gs`のコメントより）。
- `category`: `MastersDAO.buildCategoryPromptText()` で動的注入されたカテゴリ一覧から最も適合するコードを選ばせる。
  不正なコードが返った場合はコード側で `OTH` に補正する（`MastersDAO.isValidCategory` によるバリデーション）。

### 7.3 過去データ復旧用プロンプト（`VectorMaintenance._buildExtractPrompt`）

`RemarksBatch.gs` からのみ使用される簡易版。説明書PDF単体を読ませ `{remarks, summary}` の2フィールドのみを
返させる。制約（安全警告除外、150〜200字以内等）は本体プロンプトと同じ設計思想を踏襲している。
