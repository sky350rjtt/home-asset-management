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
//   6. 取説(MNL)が追加された場合のみ、remarks/検索ベクトルを再生成する ★V20で追加
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
 
          // ★【大変更】assetId自体にカテゴリ(REF等)が含まれるため、配列からcategoryを完全に排除！
          // これにより、H01REF26001_Toshiba_... という無駄のない美しいファイル名になります。
          file.setName(FileUtils.buildFileName(
            [assetId, dt, assetInfo.maker || info.maker, assetInfo.modelNumber || info.modelNumber, seq],
            ext
          ));
 
          // 1枚ごとに台帳の該当セルへFileIDを確実に追記（これで連番の衝突を防ぐ）
          if (assetRow) {
            AssetMasterDAO.appendFileId(config.ASSET_MASTER_ID, assetRow, dt, file.getId());
          }
 
          FileUtils.move(file, folder, docsFolder);
          // 【バグ修正】変数名を正しいもの（seq, mergedCount）に修正
          SheetUtils.log(logSheet, [fname, assetId, 'MERGED', `${dt}_${seq}`]);
          mergedCount++;
        });
 
        // 最後に、領収書などから得られた購入情報を台帳へ上書きアップデート
        AssetMasterDAO.updatePurchaseInfo(config.ASSET_MASTER_ID, assetRow, info);

        // 【穴の解消】取説(MNL)がこの回に含まれていた場合のみ、remarks/ベクトルを再生成する。
        //   ★追加のGemini呼び出しは不要：info.remarks/info.summaryは冒頭のanalyze()で
        //     この取説を含めて解析済みのため、ここでは組み立て・埋め込みのみ行う。
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
 
  // ★【大変更】プロンプトを「マルチファイル・ファイル名マッピング仕様」へ完全同期！
  // これにより、複数ファイルを同時に投げた際、どのファイルがMNLで、どれがRCPかをAIが正しく識別します。
  _buildPrompt(catText) {
    return `
You will receive multiple files (e.g., Manual, Warranty, Receipt) for a SINGLE existing asset product.
Analyze all provided files together, merge the information, and return a SINGLE JSON object ONLY. No preamble, explanation, or markdown fences.
 
{
  "docType": "${Constants.buildDocTypePromptText()}",
  "maker": "一般的な企業名にしてください、英語の場合は大文字小文字は企業ロゴに従う形で 例: パナソニック→Panasonic, シャープ→SHARP, 東芝→TOSHIBA, ソニー→SONY, 日立→HITACHI, 三菱→Mitsubishi, 富士通→Fujitsu, Unknown/OEM→OTH.",
  "productName": "Name in concise Japanese. 一般名称、Normalize: 冷蔵庫、テレビ、マッサージガン、エアコン、掃除機 etc...",
  "modelNumber": "型番/形名/品番/MODEL exactly as printed. Search ALL pages: 表紙・仕様ページ・最終ページ. Labels: 型番、型　番、形名、形　名、品番、MODEL NO、型式. First model number if multiple.",
  "category": "Best matching code from the category list below.",
  "purchaseDate": "YYYY/MM/DD from receipt, else null",
  "purchasePrice": "Price as number without currency from receipt, else null",
  "purchaseStore": "Store chain name only (ビックカメラ池袋店→ビックカメラ). Null if not receipt.",
  "warrantyExpiry": "YYYY/MM/DD from warranty doc, else null",
  "remarks": "A robust search index for query expansion and fluctuation handling. Generate a comma-separated list of 5-8 predictive search keywords in concise Japanese that a user or family member might input. YOU MUST INCLUDE ALL OF THE FOLLOWING: 1) Complete maker name variations (if the maker is in English, always provide its Katakana and Hiragana variations, e.g., SONY -> ソニー, そにー; TOSHIBA -> 東芝, とうしば; SHARP -> シャープ, しゃーぷ), 2) Product name variations and synonyms (e.g., 電子レンジ -> レンジ, オーブン), 3) Common colloquial terms or primary action words (e.g., チンするやつ, 温め, 冷やす, 洗濯), 4) Character type variations (Kanji/Katakana/Hiragana mixing). CRITICAL CRITERIA: Absolutely focus ONLY on the positive primary purpose and identity of the product. NEVER include peripheral noise from safety warnings or troubleshooting sections. No explanation, output only comma-separated words.",
  "summary": "If a Manual (MNL) is among the provided files, a concise 2-3 sentence Japanese summary of the product's core functions and distinguishing features from the manual content. Do NOT include safety warnings or troubleshooting content. Under 200 characters. If no Manual is present, return null.",
  "files": [
    {
      "filename": "Exact original filename provided in the input",
      "docType": "Classify this specific file: ${Constants.buildDocTypeShortPromptText()}"
    }
  ]
}
 
Category list:
${catText}
 
CRITICAL: modelNumber is the primary identifier. Read all pages carefully. Return null for unreadable fields.
`;
  },
};