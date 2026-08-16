// =============================================================================
// AssetQA.gs
//
// 役割: 詳細カードから資産の取扱説明書についてAIに質問する機能
// 責任: 指定された資産IDの取扱説明書PDFをDriveから取得し、Geminiに質問を投げて
//       回答を返すことのみ。台帳の読み書きはAssetMasterDAOに、プロンプト文言は
//       PromptBuilderに、Gemini通信はGeminiにそれぞれ委譲する。
//
// 流用: 流用不可。「取扱説明書を根拠に質問に答える」という業務ルールが
//       本システム固有の設計。
//
// 【他モジュールへの依存】Config, AssetMasterDAO, PromptBuilder, Gemini
// =============================================================================

const AssetQA = (() => {
  return {
    /**
     * 資産IDと質問文を受け取り、その資産の取扱説明書PDFを根拠にGeminiへ質問する。
     * @param {string} assetId
     * @param {string} question
     * @returns {{answer: string}}
     */
    ask(assetId, question) {
      if (!assetId || !question) {
        throw new Error('資産IDと質問文の両方が必要です。');
      }

      const config  = Config.load();
      const records = AssetMasterDAO.readAll(config.ASSET_MASTER_ID, false);
      const record  = records.find(r => r.assetId === assetId);
      if (!record) {
        throw new Error(`資産ID「${assetId}」が見つかりません。`);
      }

      const manualIds = String(record.docIds.MNL || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s);

      if (manualIds.length === 0) {
        return { answer: 'この資産には取扱説明書が登録されていないため、AIに質問できません。' };
      }

      const blobs     = manualIds.map(id => DriveApp.getFileById(id).getBlob());
      const filenames = manualIds.map((_, i) => `Manual_${i + 1}`);
      const prompt    = PromptBuilder.buildAssetQAPrompt(
        record.maker, record.productName, record.modelNumber, question
      );

      const result = Gemini.analyze(config.GEMINI_API_KEY, config.GEMINI_MODEL, prompt, blobs, filenames);

      return { answer: (result && result.answer) || '回答を取得できませんでした。しばらくしてから再度お試しください。' };
    },
  };
})();
