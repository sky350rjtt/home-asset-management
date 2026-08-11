// =============================================================================
// AddFolder.gs
//
// 役割: ADD/ フォルダの処理
//       ファイル名先頭の assetId を見て既存資産に書類を追加する
//
// 責任: ビジネスロジックのみ
//   1. ファイル名から assetId を抽出する
//   2. AssetMasterDAO で該当行を検索する
//   3. Gemini に完成済みプロンプトを渡して書類種別を判定させる
//   4. AssetMasterDAO で書類列に FileID を追記する
//   5. FileUtils でファイルを移動する
//   6. 取説(MNL)が追加された場合のみ、remarks/検索ベクトルを再生成する
//      （登録時に取説がまだ無かった資産は、ここでベクトルが初めて埋まる）
//
// 【ファイル名の規則】
//   H01REF26001_任意の名前.pdf → assetId = H01REF26001
// =============================================================================

const AddFolder = {
  process(folder, config, logSheet, docsFolder, unresFolder) {
    let mergedCount = 0, errorCount = 0, heicCount = 0;
 
    const catText = MastersDAO.buildCategoryPromptText();
    const prompt  = AddFolder._buildPrompt(catText);
 
    // 1. フォルダ内のファイルを一度すべてスキャンし、資産IDごとに「グループ分け」する
    const assetGroups = {};
 
    for (const { file, isHeic } of FileUtils.getSupportedFiles(folder)) {
      if (isHeic) { heicCount++; continue; }
 
      const assetId = FileUtils.extractAssetId(file.getName());
      if (!assetId) {
        FileUtils.moveToUnresolved(file, folder, unresFolder, 'NO_ASSET_ID');
        SheetUtils.log(logSheet, [file.getName(), 'ADD', 'ERROR', 'ファイル名先頭にassetIdが見つかりません。']);
        errorCount++;
        continue;
      }
 
      // 存在チェック
      const assetRow = AssetMasterDAO.findRowById(config.ASSET_MASTER_ID, assetId);
      if (!assetRow) {
        FileUtils.moveToUnresolved(file, folder, unresFolder, 'INVALID_ASSET_ID');
        SheetUtils.log(logSheet, [file.getName(), assetId, 'ERROR', 'assetIdがAssetMasterに見つかりません']);
        errorCount++;
        continue;
      }
 
      // 資産IDをキーにして、ファイルオブジェクトと行番号をストック
      if (!assetGroups[assetId]) {
        assetGroups[assetId] = { assetRow, files: [] };
      }
      assetGroups[assetId].files.push(file);
    }
 
    // 2. 資産IDごとに、まとまった書類セットを一括並列処理していく
    for (const [assetId, group] of Object.entries(assetGroups)) {
      const validFiles = group.files;
      const assetRow = group.assetRow;
      const firstFilename = validFiles[0].getName();
 
      try {
        const blobs = validFiles.map(f => f.getBlob());
        const filenames = validFiles.map(f => f.getName());
 
        // 【マルチファイル対応】同じ資産IDの書類を、1回のリクエストでGeminiへ丸投げ
        const info = Gemini.analyze(config.GEMINI_API_KEY, config.GEMINI_MODEL, prompt, blobs, filenames);
        if (!info) throw new Error('Gemini解析失敗（リトライ上限到達）');
 
        if (!MastersDAO.isValidCategory(info.category)) {
          console.warn(`[AddFolder Validation] 不正なカテゴリコード: "${info.category}" → OTH に補正`);
          info.category = 'OTH';
        }
 
        const assetInfo = AssetMasterDAO.getAssetInfo(config.ASSET_MASTER_ID, assetRow);
 
        let hasManual = false;

        // 3. Geminiの確定した「docType」を元に、1枚ずつ安全にリネームして台帳へ追記
        validFiles.forEach(file => {
          const fname = file.getName();
          const ext = FileUtils.getExt(file);
          
          // AIの返したファイル名マッピングから正確に書類タイプを特定
          const fileMeta = (info.files || []).find(f => {
            if (!f.filename) return false;
            const targetFname = String(fname).toLowerCase();
            const aiFname = String(f.filename).toLowerCase();
            return targetFname === aiFname || targetFname.includes(aiFname) || aiFname.includes(targetFname);
          });
          const dt = fileMeta ? fileMeta.docType : Constants.DOC_TYPE.OTH.code;
          if (dt === Constants.DOC_TYPE.MNL.code) hasManual = true;
 
          // 台帳側から現在の最新の連番（空き番号）を取得
          const seq = AssetMasterDAO.getNextSeq(config.ASSET_MASTER_ID, assetRow, dt);
 
          // assetId自体にカテゴリコード(REF等)が含まれているため、ファイル名の構成パーツに
          // categoryは含めない（例: H01REF26001_Toshiba_...）。
          file.setName(FileUtils.buildFileName(
            [assetId, dt, assetInfo.maker || info.maker, assetInfo.modelNumber || info.modelNumber, seq],
            ext
          ));
 
          // 1枚ごとに台帳の該当セルへFileIDを確実に追記（これで連番の衝突を防ぐ）
          if (assetRow) {
            AssetMasterDAO.appendFileId(config.ASSET_MASTER_ID, assetRow, dt, file.getId());
          }
 
          FileUtils.move(file, folder, docsFolder);
          SheetUtils.log(logSheet, [fname, assetId, 'MERGED', `${dt}_${seq}`]);
          mergedCount++;
        });
 
        // 最後に、領収書などから得られた購入情報を台帳へ上書きアップデート
        AssetMasterDAO.updatePurchaseInfo(config.ASSET_MASTER_ID, assetRow, info);

        // 取説(MNL)がこの回に含まれていた場合のみ、remarks/ベクトルを再生成する。
        //   追加のGemini呼び出しは不要：info.remarks/info.summaryは冒頭のanalyze()で
        //   この取説を含めて解析済みのため、ここでは組み立て・埋め込みのみ行う。
        //   受領書だけの追加ではremarks/summaryはnull想定のため、既存のS列/T列を上書きしない。
        if (hasManual && (info.remarks || info.summary)) {
          // 【上書き前の監査ログ】S列は「人間＆AI共用」の欄のため、人間が書いた既存メモを
          //   問答無用で消さないよう、上書き前の値と違えばログに残す（上書き自体は止めない）。
          const oldRemarks = AssetMasterDAO.getRemarks(config.ASSET_MASTER_ID, assetRow);
          if (oldRemarks && oldRemarks !== String(info.remarks || '').trim()) {
            SheetUtils.log(logSheet, [firstFilename, assetId, 'REMARKS_OVERWRITTEN', `旧: ${oldRemarks}`]);
          }

          const richText = VectorMaintenance.buildRichText(
            assetInfo.product, assetInfo.maker, assetInfo.model, info.remarks, info.summary
          );
          const embeddingString = VectorMaintenance.computeEmbeddingString(config, richText);
          AssetMasterDAO.updateRemarksAndEmbedding(
            config.ASSET_MASTER_ID, assetRow, info.remarks, embeddingString
          );

          if (embeddingString) {
            console.log(`[AddFolder Logic] ${assetId} の取説追加を検知。remarks/ベクトルを再生成しました。`);
          } else {
            // 【失敗の可視化】沈黙させず、ログに残して人間が気づけるようにする。
            SheetUtils.log(logSheet, [firstFilename, assetId, 'VECTOR_FAILED', 'ベクトル生成失敗のためT列は空欄のままです']);
          }
        }
 
      } catch(e) {
        // エラー時はその資産IDのファイルセットを一括退避
        validFiles.forEach(f => FileUtils.moveToUnresolved(f, folder, unresFolder, 'PROCESS_ERROR'));
        SheetUtils.log(logSheet, [firstFilename, assetId, 'ERROR', e.message]);
        errorCount += validFiles.length;
      }
 
      Utilities.sleep(4500); // 連続API判定を避けるウェイト
    }
 
    return { mergedCount, errorCount, heicCount };
  },
 
  // プロンプト本文の組み立ては PromptBuilder.gs に委譲する（Location.gsと共用）。
  // ここで渡すのは「対象が既存資産である」という、この処理フロー固有の文脈情報のみ。
  _buildPrompt(catText) {
    return PromptBuilder.buildAssetAnalysisPrompt(
      'You will receive multiple files (e.g., Manual, Warranty, Receipt) for a SINGLE existing asset product.',
      catText
    );
  },
};