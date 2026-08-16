// =============================================================================
// intelligentSearch.gs
//
// 役割: フロントエンド（Viewerアプリ）からのAIベクトル検索リクエストの受付とソート
// 責任: コサイン類似度の総当たり計算と、スコア順の降順ソートのみ。
//       Gemini APIとの直接の通信ロジックは Gemini.gs へ完全委ねる。
// =============================================================================

/**
 * フロントエンド（Web UI）から google.script.run 経由で呼び出される、AIベクトル検索のエントリポイント。
 * @param {string} query - ユーザーが検索窓に入力した文字列
 * @returns {Object[]}   - AIおすすめ順に並び替えられた資産データの配列
 */
function EXCLUSIVE_AI_VECTOR_SEARCH_ENTRANCE(query) {
  if (typeof _assertAllowedUser === 'function') {
    _assertAllowedUser();
  }
  return AiSearchNamespace.execute(query);
}

// 検索ロジックをまとめた名前空間。フロントエンドに公開するのは
// EXCLUSIVE_AI_VECTOR_SEARCH_ENTRANCE のみで、内部実装は直接呼び出させない。
var AiSearchNamespace = {
  execute: function(query) {
    // 1. サーバー内部で全データをロード（ここでベクトル(T列)も一緒に取得＝台帳を読むのは1回だけ）
    //    読み込み・見せ方への整形は shared/AssetPresenter.gs（Entry.gsと共用）に委譲する。
    var allData = [];
    try {
      allData = AssetPresenter.loadFromLedger(true);
    } catch(e) {
      throw new Error("【データロード失敗】台帳の読み込みでエラー: " + e.toString());
    }

    if (!allData || allData.length === 0) return [];
    if (!query || query.trim() === "") {
      // 検索語が無ければベクトルは不要。念のため外して軽く返す。
      return allData.map(function(a){ var c=Object.assign({},a); delete c.embeddingRaw; return c; });
    }

    var config = Config.load();

    // 2. 検索ワードをベクトル化（Gemini.embed 共通コンポーネントを呼ぶ）
    var queryVector = Gemini.embed(config.GEMINI_API_KEY, config.GEMINI_EMBED_MODEL, query.trim(), config.GEMINI_EMBED_DIMENSION);
    if (!queryVector) {
      throw new Error("【Gemini APIエラー】検索語のベクトル化に失敗しました。APIキー・EMBEDモデル名・無料枠の秒間制限を確認してください。");
    }

    // 3. 各資産のベクトルと総当たりでコサイン類似度を計算
    //    ※IDの再マッチングは不要。ローダーが最初から正しい行のベクトルを付けている（あいまい照合を廃止）。
    var scored = [];
    var validScoreCount = 0;
    for (var j = 0; j < allData.length; j++) {
      var asset = allData[j];
      var score = -1.0;
      if (asset.embeddingRaw) {
        try {
          var assetVector = JSON.parse(asset.embeddingRaw);
          // 安全策：次元数が食い違うベクトル（EMBEDモデルを途中変更した等）はスコア対象外にする
          if (assetVector.length === queryVector.length) {
            score = this.cosineSimilarity(queryVector, assetVector);
            validScoreCount++;
          }
        } catch(e) { /* パース失敗は無害にスルー */ }
      }
      scored.push({ asset: asset, score: score });
    }

    if (validScoreCount === 0) {
      throw new Error("【ベクトル未検出】台帳のT列に有効なベクトルが1件もありません。新規登録時のEMBED生成、またはEMBEDモデルの次元一致を確認してください。");
    }

    // 4. スコアの高い順に並べ替え
    scored.sort(function(a, b) { return b.score - a.score; });

    // 4.5【足切り】類似度が低すぎる（＝意味的に無関係な）結果まで一覧に混ぜない。
    //     閾値はコードにハードコードせず、Configシートの GEMINI_SEARCH_MIN_SCORE から取得する
    //     （未設定なら0＝足切りしない）。
    scored = scored.filter(function(item) { return item.score >= config.SEARCH_MIN_SCORE; });

    // 5. 通信を軽くするため、重いベクトルを外してフロントへ返却
    return scored.map(function(item) {
      var safeAsset = Object.assign({}, item.asset);
      delete safeAsset.embeddingRaw;
      return safeAsset;
    });
  },

  /**
   * 2つのベクトルのコサイン類似度を計算する。
   */
  cosineSimilarity: function(vecA, vecB) {
    var dotProduct = 0.0;
    var normA = 0.0;
    var normB = 0.0;
    for (var i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
};