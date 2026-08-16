// =============================================================================
// Location.gs
//
// 役割: 拠点フォルダ（H01/ H02/ 等）の処理
//       新規資産を1ファイル = 1資産として登録する
//
// 責任: ビジネスロジックのみ
//   1. MastersDAO からカテゴリを取得してプロンプトを組み立てる
//   2. Gemini に完成済みプロンプトを渡して解析させる
//   3. 拠点コード・カテゴリコードを含まない検索用ベクトルをその場で生成する
//   4. 解析成果とベクトルを AssetMasterDAO へ渡し、新規登録する
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
      //   remarks(あいまい連想語)は製品名だけで生成できる一般常識のため、
      //   取説の有無を問わず常に使ってよい。
      const hasManual = (info.files || []).some(f => f.docType === Constants.DOC_TYPE.MNL.code);
      const safeSummary = hasManual ? info.summary : null;

      // =======================================================================
      // 登録の直前に検索用ベクトルを生成する。
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

      // =======================================================================
      // 1. 各ファイルのリネームと移動、および書類IDの収集
      //    ファイル移動を先に行い、すべて成功した段階で台帳へ一括登録する（アトミック性の担保）。
      // =======================================================================
      const docTypeCounts = {};
      const docIdsMap = {
        MNL: [],
        RCP: [],
        WRT: [],
        OTH: []
      };
      const processedFiles = [];

      for (const file of validFiles) {
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

        // ドキュメントIDマップに追加
        if (docIdsMap[dt]) {
          docIdsMap[dt].push(file.getId());
        } else {
          docIdsMap.OTH.push(file.getId());
        }

        FileUtils.move(file, folder, docsFolder);
        processedFiles.push({ fname, dt, branchNum });
      }

      // =======================================================================
      // 2. 台帳への一括登録（insert）
      //    全ファイルのfileIdをdocIdsとして1回のAPI呼び出し（appendRow）で登録する。
      // =======================================================================
      let insertedRow = 0;
      try {
        insertedRow = AssetMasterDAO.insert(config.ASSET_MASTER_ID, {
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
          embedding:      embeddingString, // T列：業務ロジック層で生成したベクトルのJSON文字列
          docIds: {
            MNL: docIdsMap.MNL.join(', '),
            RCP: docIdsMap.RCP.join(', '),
            WRT: docIdsMap.WRT.join(', '),
            OTH: docIdsMap.OTH.join(', ')
          }
        });

        // 成功ログ記録
        processedFiles.forEach(({ fname, dt, branchNum }) => {
          SheetUtils.log(logSheet, [fname, assetId, 'NEW', `${dt}_${branchNum}`]);
          newCount++;
        });

      } catch (insertError) {
        // 台帳書き込みに失敗した場合はロールバック
        if (insertedRow > 0) {
          try { AssetMasterDAO.deleteRow(config.ASSET_MASTER_ID, insertedRow); } catch(_) {}
        }
        throw insertError;
      }

    } catch(e) {
      validFiles.forEach(f => FileUtils.moveToUnresolved(f, folder, unresFolder, 'PROCESS_ERROR'));
      SheetUtils.log(logSheet, ['一括処理エラー', location.code, 'ERROR', e.message]);
      errorCount += validFiles.length;
    }
 
    return { newCount, errorCount, heicCount };
  },
 
  // プロンプト本文の組み立ては PromptBuilder.gs に委譲する（AddFolder.gsと共用）。
  // ここで渡すのは「対象が新規資産である」という、この処理フロー固有の文脈情報のみ。
  _buildPrompt(catText) {
    return PromptBuilder.buildAssetAnalysisPrompt(
      'You will receive multiple files (e.g., Manual, Warranty, Receipt) for a SINGLE asset product.',
      catText
    );
  },
};