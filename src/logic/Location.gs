// =============================================================================
// Location.gs
//
// 役割: 拠点フォルダ（H01/ H02/ 等）の処理
//       新規資産を1ファイル = 1資産として登録する
//
// 責任: ビジネスロジックのみ
//   1. MastersDAO からカテゴリを取得してプロンプトを組み立てる
//   2. Gemini に完成済みプロンプトを渡して解析させる
//   3. 拠点フリー・カテゴリコードフリーのクリーンな検索用ベクトルをその場で生成 ★新規追加
//   4. 解析成果とベクトルを一括して AssetMasterDAO へ引き渡し、新規登録する ★リファクタリング
//   5. FileUtils でファイルを移動する
// =============================================================================

const Location = {
  process(folder, location, config, logSheet, docsFolder, unresFolder) {
    let newCount = 0, errorCount = 0, heicCount = 0;
 
    const catText = MastersDAO.buildCategoryPromptText();
    const prompt  = Location._buildPrompt(catText);
 
    const validFiles = [];
    for (const { file, isHeic } of FileUtils.getSupportedFiles(folder)) {
      if (isHeic) { heicCount++; continue; }
      validFiles.push(file);
    }

    if (validFiles.length === 0) {
      return { newCount, errorCount, heicCount };
    }
 
    try {
      const blobs = validFiles.map(f => f.getBlob());
      const filenames = validFiles.map(f => f.getName());
      const firstFilename = filenames[0]; 
 
      const info = Gemini.analyze(config.GEMINI_API_KEY, config.GEMINI_MODEL, prompt, blobs, filenames);
      if (!info) throw new Error('Gemini解析失敗（リトライ上限到達）');
 
      if (!info.modelNumber) {
        validFiles.forEach(f => FileUtils.moveToUnresolved(f, folder, unresFolder, 'NO_MODEL'));
        SheetUtils.log(logSheet, [firstFilename, location.code, 'ERROR', '型番が読み取れませんでした']);
        return { newCount, errorCount: errorCount + validFiles.length, heicCount };
      }
 
      if (!MastersDAO.isValidCategory(info.category)) {
        console.warn(`[Location Validation] 不正なカテゴリコード: "${info.category}" → OTH に補正`);
        info.category = 'OTH';
      }
 
      const assetId = AssetMasterDAO.assignId(config.ASSET_MASTER_ID, location.code, info.category);

      // 【要約文の強制ガード】summaryは取説(MNL)の中身に基づく機能説明のため、
      //   このバッチに実際にMNLが1枚も含まれていなければ生成する意味がなく、
      //   AIがそれでも何か書いてしまう(ハルシネーション)リスクがある。
      //   プロンプトで「無ければnullを返せ」と指示するだけでなく、
      //   info.files（各ファイルの判定結果）を見てコード側でも機械的に破棄する。
      //   ★remarks(あいまい連想語)は製品名だけで生成できる一般常識のため、
      //     取説の有無を問わず常に使ってよい。
      const hasManual = (info.files || []).some(f => f.docType === Constants.DOC_TYPE.MNL.code);
      const safeSummary = hasManual ? info.summary : null;

      // =======================================================================
      // 🚨【業務ロジック層】登録の直前に、その場で最強の無敵ベクトルを自動生成
      //   remarks(あいまい検索ワード)はS列に保存されるが、summary(要約文)は
      //   ベクトル化にのみ使い、この後どこにも保存せず使い捨てる。
      // =======================================================================
      const richText = VectorMaintenance.buildRichText(
        info.productName, info.maker, info.modelNumber, info.remarks, safeSummary
      );

      console.log(`[Location Logic] 新規アセットのリアルタイム・ベクトル変換を開始... ID: ${assetId}（取説あり: ${hasManual}）`);
      const embeddingString = VectorMaintenance.computeEmbeddingString(config, richText);
      if (embeddingString) {
        console.log(`[Location Logic] ベクトル生成成功（文字数: ${embeddingString.length}）`);
      } else {
        // 【失敗の可視化】沈黙させず、ログに残して人間が気づけるようにする。
        SheetUtils.log(logSheet, [firstFilename, assetId, 'VECTOR_FAILED', 'ベクトル生成失敗のためT列は空欄で登録されました']);
      }
      // =======================================================================

      // ★大修正：削ぎ落とされたクリーンな DAO 側の insert に対し、remarks と embedding の双方を渡して一発書き込み！
      // 　　　　　summary(要約文)はベクトル化にのみ使い、ここでは一切保存しない（使い捨て）。
      const assetRow = AssetMasterDAO.insert(config.ASSET_MASTER_ID, {
        assetId,
        locationCode:   location.code, // B列に入るコード（H01）
        locationName:   location.name, // C列に入る名前（Nerima）
        category:       info.category,
        maker:          info.maker,
        productName:    info.productName,
        modelNumber:    info.modelNumber,
        purchaseDate:   info.purchaseDate,
        purchasePrice:  info.purchasePrice,
        purchaseStore:  info.purchaseStore,
        warrantyExpiry: info.warrantyExpiry,
        status:         info.status,
        remarks:        info.remarks ? String(info.remarks).trim() : '', // S列：人間＆AI共用の言い換えワード
        embedding:      embeddingString // 🚨 T列：業務ロジック層で生成した1024次元のJSON文字列
      });
 
      const docTypeCounts = {};
 
      validFiles.forEach(file => {
        const fname = file.getName();
        const ext = FileUtils.getExt(file);
        
        const fileMeta = (info.files || []).find(f => {
          if (!f.filename) return false;
          const targetFname = String(fname).toLowerCase();
          const aiFname = String(f.filename).toLowerCase();
          return targetFname === aiFname || targetFname.includes(aiFname) || aiFname.includes(targetFname);
        });
        const dt = fileMeta ? fileMeta.docType : Constants.DOC_TYPE.OTH.code;
 
        if (!docTypeCounts[dt]) {
          docTypeCounts[dt] = 1;
        } else {
          docTypeCounts[dt]++;
        }
        const branchNum = String(docTypeCounts[dt]);
 
        file.setName(FileUtils.buildFileName(
          [assetId, dt, info.maker, info.modelNumber, branchNum],
          ext
        ));
 
        if (assetRow) {
          AssetMasterDAO.appendFileId(config.ASSET_MASTER_ID, assetRow, dt, file.getId());
        }
 
        FileUtils.move(file, folder, docsFolder);
        SheetUtils.log(logSheet, [fname, assetId, 'NEW', `${dt}_${branchNum}`]);
        newCount++;
      });
 
    } catch(e) {
      validFiles.forEach(f => FileUtils.moveToUnresolved(f, folder, unresFolder, 'PROCESS_ERROR'));
      SheetUtils.log(logSheet, ['一括処理エラー', location.code, 'ERROR', e.message]);
      errorCount += validFiles.length;
    }
 
    return { newCount, errorCount, heicCount };
  },
 
  // ★【プロンプトの超調教】トースターやシュレッダーの誤浮上を根絶する「ノイズ完全排除令」をインジェクション
  _buildPrompt(catText) {
    return `
You will receive multiple files (e.g., Manual, Warranty, Receipt) for a SINGLE asset product.
Analyze all provided files together, merge the information, and return a SINGLE JSON object ONLY. No preamble, explanation, or markdown fences.
 
{
  "docType": "${Constants.buildDocTypePromptText()}",
  "maker": "一般的な企業名にしてください、英語の場合は大文字小文字は企業ロゴに従う形で 例: パナソニック→Panasonic, シャープ→SHARP, 東芝→TOSHIBA, ソニー→SONY, 日立→HITACHI, 三菱→Mitsubishi, 富士通→Fujitsu, Unknown/OEM→OTH.",
  "productName": "Name in concise Japanese. 一般名称、Normalize: 冷蔵庫、テレビ、マッサージガン、エアコン、掃除機 etc...",
  "modelNumber": "型番/形名/品番/MODEL exactly as printed. Search ALL pages: 表紙・仕様ページ・最終ページ. Labels: 型番、型 番、形名、形 名、品番、MODEL NO、型式. ～シリーズのような余計な文字は不要,First model number if multiple.",
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
 
CRITICAL: Extract data by combining all files. In addition, you MUST map each input filename to its corresponding docType in the "files" array.
`;
  },
};