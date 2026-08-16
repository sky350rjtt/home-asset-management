// =============================================================================
// PromptBuilder.gs
//
// 役割: 資産関連Geminiプロンプトの組み立てロジック
// 責任: Location.gs（新規登録）とAddFolder.gs（既存資産への書類追加）が共用する
//       資産解析プロンプト、およびAssetQA.gsが使う詳細カード内Q&Aプロンプトの
//       組み立てのみ。書類種別コード等の「定義」はConstants.gsに残したまま、
//       その定義を使って実際のプロンプト文字列を組み立てる「ロジック」を
//       ここに集約する（役割分担: Constants=定義、PromptBuilder=組み立て）。
//
// 流用: 流用不可。remarksの生成指示・summaryの扱い・files[]マッピング仕様など、
//       家電資産管理という本システム固有の業務ルールがプロンプト文言に直接埋め込まれている。
//       Constants.gs（完全流用可）にこのロジックを置くと、Constants.gsの
//       「他システムへ持って行っても1文字も変えず使える」という前提を壊してしまうため、
//       あえて別ファイルに分離している。
//
// 【他モジュールへの依存】Constants（DOC_TYPEの定義、buildDocTypePromptText / buildDocTypeShortPromptText）
// =============================================================================

const PromptBuilder = {
  /**
   * 資産解析プロンプトの本文を組み立てる。
   * Location.gs（新規登録）とAddFolder.gs（既存資産への追加）で内容のほとんどは共通だが、
   * 冒頭の説明文（対象が新規資産か既存資産か）だけは文脈依存のため呼び出し側から渡す。
   * @param {string} introText - 冒頭の1文（対象が新規資産か既存資産かを説明する文）
   * @param {string} catText   - MastersDAO.buildCategoryPromptText() で組み立てたカテゴリ一覧
   */
  buildAssetAnalysisPrompt(introText, catText) {
    return `
${introText}
Analyze all provided files together, merge the information, and return a SINGLE JSON object ONLY. No preamble, explanation, or markdown fences.

{
  "docType": "${Constants.buildDocTypePromptText()}",
  "maker": "一般的な企業名にしてください、英語の場合は大文字小文字は企業ロゴに従う形で 例: パナソニック→Panasonic, シャープ→SHARP, 東芝→TOSHIBA, ソニー→SONY, 日立→HITACHI, 三菱→Mitsubishi, 富士通→Fujitsu, Unknown/OEM→OTH.",
  "productName": "Name in concise Japanese. 一般名称、Normalize: 冷蔵庫、テレビ、マッサージガン、エアコン、掃除機 etc...",
  "modelNumber": "型番/形名/品番/MODEL exactly as printed. Search ALL pages: 表紙・仕様ページ・最終ページ. Labels to look for: 型番, 形名, 品番, MODEL NO, 型式 (a space between characters, e.g. '型　番', is just a formatting variant of the same label — treat it identically). Exclude marketing/series suffixes such as '〜シリーズ'; return only the actual model code. If multiple model numbers appear, return the first one.",
  "category": "Best matching code from the category list below.",
  "purchaseDate": "YYYY/MM/DD from receipt, else null",
  "purchasePrice": "Price as number without currency from receipt, else null",
  "purchaseStore": "Store chain name only (ビックカメラ池袋店→ビックカメラ). Null if not receipt.",
  "warrantyExpiry": "YYYY/MM/DD from warranty doc, else null",
  "remarks": "A robust search index for query expansion and fluctuation handling. Generate a comma-separated list of 5-8 predictive search keywords in concise Japanese that a user or family member might input. YOU MUST INCLUDE ALL OF THE FOLLOWING: 1) Complete maker name variations (if the maker is in English, always provide its Katakana and Hiragana variations, e.g., SONY -> ソニー, そにー; TOSHIBA -> 東芝, とうしば; SHARP -> シャープ, しゃーぷ), 2) Product name variations and synonyms (e.g., 電子レンジ -> レンジ, オーブン), 3) Common colloquial terms or primary action words (e.g., チンするやつ, 温め, 冷やす, 洗濯), 4) Character type variations (Kanji/Katakana/Hiragana mixing). CRITICAL CRITERIA: Absolutely focus ONLY on the positive primary purpose and identity of the product. NEVER include peripheral noise from safety warnings or troubleshooting sections. No explanation, output only comma-separated words.",
  "summary": "If a Manual is among the provided files, a concise 2-3 sentence Japanese summary of the product's core functions and distinguishing features, based on the manual content (e.g., specific modes, capacity, unique functionality — what makes this model different from a generic one). Do NOT include safety warnings, cautions, or troubleshooting content. This text is used only for semantic search matching and will not be stored or displayed, so include as much distinguishing functional detail as reasonably possible within the limit. Under 200 characters. If no Manual is present among the provided files (e.g., only a receipt/photo), return null — do not guess or infer features.",
  "files": [
    {
      "filename": "Exact original filename provided in the input",
      "docType": "Classify this specific file: ${Constants.buildDocTypeShortPromptText()}"
    }
  ]
}

Category list:
${catText}

CRITICAL: Extract data by combining all files. modelNumber is the primary identifier — read all pages carefully. You MUST map each input filename to its corresponding docType in the "files" array. Return null for unreadable fields.
`;
  },

  /**
   * 詳細カード内AI Q&A用プロンプトを組み立てる。
   * 添付の取扱説明書PDFのみを根拠に、ユーザーの自由入力質問に日本語で回答させる。
   * @param {string} maker    - メーカー名
   * @param {string} product  - 製品名
   * @param {string} model    - 型番
   * @param {string} question - ユーザーの質問文
   */
  buildAssetQAPrompt(maker, product, model, question) {
    return `
あなたは「${maker} ${product} (${model})」の専任サポートAIです。
添付された取扱説明書の内容のみを根拠に、ユーザーの質問に日本語でわかりやすく簡潔に回答してください。
説明書に記載が無い内容は、憶測で答えず「取扱説明書には記載がありませんでした」と正直に回答してください。

回答は以下のJSON形式のみで返してください。説明文やマークダウンのコードフェンスは不要です。
{
  "answer": "質問への回答本文（日本語）"
}

ユーザーの質問: ${question}
`;
  },
};
