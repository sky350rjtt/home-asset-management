// =============================================================================
// RemarksBatch.gs
//
// 役割: 過去データの remarks(S列)・embedding(T列)を、実際に保存されている取説PDFから
//       まとめて復旧・再生成する保守バッチ。
// 責任: 対象行の抽出と進行管理のみ。列の読み書きはAssetMasterDAOに、AI通信は
//       Gemini.gsに、テキスト組み立てとセル上限ガードはVectorMaintenanceに完全委任する。
//
// 【使いどころ】
//   - AddFolder.gsの穴（V19以前は取説を後から追加してもベクトルが更新されなかった）で
//     ベクトル未生成のまま残っている過去の資産を、まとめて直したいとき
//   - remarks/summaryのプロンプトを改善した後、既存データを新プロンプトで作り直したいとき
//
// 【Web形式の取説URLについて】
//   O列（取説）にGoogle DriveのファイルIDではなく直接URL（http始まり）が入っている行は、
//   ドライブから読めないため安全にスキップし、既存のS列をそのまま残す。
// =============================================================================

function GENERATE_EMBEDDINGS_FROM_ACTUAL_PDFS() {
  // 🚨【安全弁】ここを書き換えて小分けに実行してください（例: 最初は 0 から 15件 など）
  const START_INDEX = 43;  // 何件目からスタートするか（0＝最初のデータ）
  const BATCH_SIZE   = 10; // 1回で処理する件数（無料枠のRPM上限に合わせて15件が安全）

  const config = Config.load();
  const records = AssetMasterDAO.readAll(config.ASSET_MASTER_ID, false);

  if (records.length === 0) {
    console.log('データ行がありません。');
    return;
  }

  const endIndex = Math.min(START_INDEX + BATCH_SIZE, records.length);
  console.log(`【復旧バッチ】全 ${records.length} 件中、${START_INDEX + 1} 〜 ${endIndex} 件目を処理します...`);

  for (let i = START_INDEX; i < endIndex; i++) {
    const rec = records[i];
    if (!rec.assetId || !rec.productName) continue;

    // O列（取説）は複数ファイルがカンマ連結されている場合があるため、先頭の1件を対象にする
    const firstManualRef = String(rec.docIds.MNL || '').split(',')[0].trim();

    if (!firstManualRef) {
      console.log(`[${i + 1}/${records.length}] ID: ${rec.assetId} は取説が未登録のためスキップします。`);
      continue;
    }

    if (firstManualRef.startsWith('http')) {
      // Web形式の取説（URL）はドライブから読めないため、既存のS列を残したまま安全にスキップ
      console.log(`[${i + 1}/${records.length}] ID: ${rec.assetId} はWeb取説(URL)のため解析をスキップします。`);
      continue;
    }

    let extracted = null;
    try {
      const file = DriveApp.getFileById(firstManualRef);
      const blob = file.getBlob();
      console.log(`[${i + 1}/${records.length}] ID: ${rec.assetId} の取説PDFから再抽出中...`);
      extracted = VectorMaintenance.extractRemarksAndSummary(
        config.GEMINI_API_KEY, config.GEMINI_MODEL, blob, file.getName()
      );
    } catch (e) {
      console.warn(`➔ ${rec.assetId}: PDF取得/解析に失敗（${e.toString()}）。この行はスキップします。`);
    }

    if (!extracted) {
      continue;
    }

    // 抽出に失敗した場合は既存のS列（人間が書いたメモ等）を消さずに残す
    const remarks = extracted.remarks || rec.remarks;
    const richText = VectorMaintenance.buildRichText(
      rec.productName, rec.maker, rec.modelNumber, remarks, extracted.summary
    );
    const embeddingString = VectorMaintenance.computeEmbeddingString(config, richText);

    if (embeddingString) {
      AssetMasterDAO.updateRemarksAndEmbedding(config.ASSET_MASTER_ID, rec.rowNumber, remarks, embeddingString);
      console.log(`➔ ID: ${rec.assetId} のS列/T列を復旧しました。`);
    } else {
      console.warn(`➔ ID: ${rec.assetId} はベクトル生成に失敗したためスキップしました。`);
    }

    // 無料枠のAPI制限（1分間あたりのリクエスト数）を超えないための安全弁
    Utilities.sleep(4000);
  }

  console.log('【復旧バッチ完了】指定範囲の処理が終了しました。');
}