// =============================================================================
// VectorMaintenance.gs
//
// 役割: 「検索用ベクトルを作る」という一連の処理を1箇所に集約する共通部品。
//       Location.gs（新規登録時）／AddFolder.gs（取説の後追加時）／RemarksBatch.gs
//       （過去データの一括復旧）の3箇所が、まったく同じロジックを重複して持たないための置き場所。
//
// 責任: ベクトル化用テキストの組み立てと、埋め込み生成後のセル上限ガードのみ。
//       AI通信はGemini.gsに、列の読み書きはAssetMasterDAOに完全委任する。
//
// 【remarks と summary の役割分担】
//   - remarks（あいまい検索ワード）：「チンするやつ」等、呼び方のゆらぎを吸収する言い換え語。
//                                    S列に保存され、人間が読んでも意味が分かる情報。
//   - summary （要約文）           ：説明書の中身に基づく機能・特徴の説明文。
//                                    ベクトル生成の材料としてのみ使い、どの列にも保存しない
//                                    （生成→embed→破棄、の使い捨て）。
// =============================================================================

const VectorMaintenance = {
  /**
   * ベクトル化する生テキストを組み立てる。
   * ★将来の引っ越し・資産移動に対応するため、拠点(B,C列)やシステム用カテゴリコード(D列)は
   *   絶対に含めない。
   * @param {string} productName
   * @param {string} maker
   * @param {string} modelNumber
   * @param {string} remarks  あいまい検索ワード（S列に保存される値と同じもの）
   * @param {string} summary  要約文（保存はしない。ここで使い切って捨てる）
   */
  buildRichText(productName, maker, modelNumber, remarks, summary) {
    return [
      "製品名: " + (productName ? String(productName).trim() : ''),
      "メーカー: " + (maker ? String(maker).trim() : ''),
      "型番: " + (modelNumber ? String(modelNumber).trim() : ''),
      "備考: " + (remarks ? String(remarks).trim() : ''),
      "要約: " + (summary ? String(summary).trim() : '')
    ].join(" | ");
  },

  /**
   * richTextをベクトル化し、Sheetsのセル上限(50,000字)に対する安全ガードをかけた
   * JSON文字列を返す。失敗時・危険域超過時は空文字を返す（呼び出し側はそのままT列に書ける）。
   */
  computeEmbeddingString(config, richText) {
    const vector = Gemini.embed(
      config.GEMINI_API_KEY, config.GEMINI_EMBED_MODEL, richText, config.GEMINI_EMBED_DIMENSION
    );
    if (!vector) {
      console.warn('[VectorMaintenance] ベクトル生成に失敗しました。空欄のまま処理を続行します。');
      return '';
    }

    let embeddingString = JSON.stringify(vector);
    // 【セル上限ガード】EMBEDモデルの次元数変更等でセル上限に接近すると、書込時に
    // 不明瞭なエラーで処理全体が落ちるため、危険域では保存自体をスキップする。
    if (embeddingString.length > 45000) {
      console.warn(`[VectorMaintenance] ベクトルがセル上限に接近（${embeddingString.length}字）。保存をスキップします。EMBEDモデルの次元数を確認してください。`);
      return '';
    }
    return embeddingString;
  },

  // 過去データの復旧（RemarksBatch.gs）専用：説明書PDFの実物から remarks/summary を再抽出する。
  _buildExtractPrompt() {
    return `
Read the attached product manual and return a SINGLE JSON object ONLY. No preamble, explanation, or markdown fences.

{
  "remarks": "User-friendly query expansion keywords in concise Japanese. Predict 3-5 keywords that a family member might type in a search window to find this product. Include general alternative names, colloquial expressions, katakana/hiragana variations, or the main purpose/action of this item. Separate with commas. (e.g., for ウォーターオーブン -> 電子レンジ, レンジ, オーブン, チンするやつ, 温め). CRITICAL: ONLY the positive primary purpose/function. NEVER include peripheral words from 'Safety Precautions', 'Warnings', or 'Troubleshooting' sections. Under 150 characters.",
  "summary": "A concise 2-3 sentence Japanese summary of the product's core functions and distinguishing features, based on the manual content (e.g., specific modes, capacity, unique functionality). Do NOT include safety warnings, cautions, or troubleshooting content. Under 200 characters."
}
`;
  },

  /**
   * @returns {{remarks:string, summary:string}|null} 抽出失敗時はnull
   */
  extractRemarksAndSummary(apiKey, model, pdfBlob, filename) {
    const info = Gemini.analyze(apiKey, model, this._buildExtractPrompt(), pdfBlob, filename);
    if (!info) return null;
    return {
      remarks: info.remarks ? String(info.remarks).trim() : '',
      summary: info.summary ? String(info.summary).trim() : ''
    };
  },
};