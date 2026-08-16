// =============================================================================
// Scanner.gs
//
// 役割: INBOX/ のサブフォルダをスキャンして処理フローを制御する
// 責任: 全体の制御フローのみ。業務ロジック・AI・ファイル操作は知らない。
//
// 【処理の流れ】
//   1. Config・Masters からインフラ設定・マスタを読み込む
//   2. INBOX/ のサブフォルダを順にスキャン
//   3. ADD/ フォルダ → AddFolder.process()
//   4. 拠点フォルダ（H01/等）→ Location.process()
//   5. 結果を集計してメッセージを返す
//
// 【LockService】
//   二重実行を防止する（メニューとWebAppから同時に実行された場合）
//
// 【戻り値】
//   { newCount, mergedCount, errorCount, heicCount, message }
//   WebApp（Entry.gs / Index.html）でも使えるよう結果をreturnする。
//   alert()はWebAppで動作しないため、try-catchで安全に処理する。
//
// 【他モジュールへの依存】
//   ConfigModule / MastersDAO / Location / AddFolder / SheetUtils
// =============================================================================

const Scanner = {
  run() {
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch(e) {
      const msg = '別のスキャン処理が実行中です。しばらく待ってから再実行してください。';
      try { SpreadsheetApp.getUi().alert(msg); } catch(_) {}
      return { newCount: 0, mergedCount: 0, errorCount: 0, heicCount: 0, skippedFolders: [], message: msg };
    }

    try {
      return Scanner._execute();
    } finally {
      lock.releaseLock();
    }
  },

  _execute() {
    let config, masters;
    try {
      config  = Config.load();
      masters = MastersDAO.load();
    } catch(e) {
      const msg = `システム起動エラー：\n${e.message}`;
      try { SpreadsheetApp.getUi().alert(msg); } catch(_) {}
      return { newCount: 0, mergedCount: 0, errorCount: 0, heicCount: 0, skippedFolders: [], message: msg };
    }
 
    const logSheet    = SheetUtils.getOrCreate(Constants.SHEET.LOG,
      ['processedAt', 'filename', 'assetId', 'status', 'detail']);
    const inboxRoot   = DriveApp.getFolderById(config.INBOX_FOLDER_ID);
    const docsFolder  = DriveApp.getFolderById(config.DOCS_FOLDER_ID);
    const unresFolder = DriveApp.getFolderById(config.UNRESOLVED_FOLDER_ID);
 
    let newCount = 0, mergedCount = 0, errorCount = 0, heicCount = 0;
    let isTimeLimitReached = false;
    const skippedFolders = []; // 【可視化】Mastersに未定義のフォルダ名を集め、最終アラートに出す（consoleログだけでは気づかれず放置されるため）

    // 【GAS実行時間ガード】GASの最大実行時間（6分）を超過して強制中断されるのを防ぐため、
    // 4分（240秒）を経過した時点で安全にループを抜け、残りは次回スキャンに持ち越す。
    const startTime = Date.now();
    const MAX_EXECUTION_TIME_MS = 240 * 1000;

    const subFolders = inboxRoot.getFolders();
    while (subFolders.hasNext()) {
      // 時間制限チェック
      if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
        console.warn('[Scanner] 実行時間が4分を超過したため、残りの処理を次回スキャンに持ち越します。');
        isTimeLimitReached = true;
        break;
      }

      const subFolder  = subFolders.next();
      const folderName = subFolder.getName().toUpperCase();

      if (folderName === Constants.ADD_FOLDER) {
        const r = AddFolder.process(subFolder, config, logSheet, docsFolder, unresFolder);
        mergedCount += r.mergedCount;
        errorCount  += r.errorCount;
        heicCount   += r.heicCount;

      } else {
        const location = masters.locations.find(l => l.code === folderName);
        if (!location) {
          console.warn(`[Scanner Skip] Mastersに未定義のフォルダをスキップしました: ${folderName}`);
          if (!skippedFolders.includes(folderName)) skippedFolders.push(folderName);
          continue;
        }
        const r = Location.process(subFolder, location, config, logSheet, docsFolder, unresFolder);
        newCount   += r.newCount;
        errorCount += r.errorCount;
        heicCount  += r.heicCount;
      }
    }

    let message = `処理完了\n新規資産登録：${newCount}件\n既存への書類追加：${mergedCount}件\nエラー隔離：${errorCount}件`;
    if (isTimeLimitReached) {
      message += `\n\n⏳ 実行時間の上限（4分）に達したため、処理を一時中断しました。未処理のファイルは次回のスキャンで処理されます。`;
    }
    if (heicCount > 0) {
      message += `\n\n⚠️ HEIC形式の画像が ${heicCount} 件スキップされました。\n`
               + `JPEGまたはPNGに変換してから再投入してください。\n`
               + `（iPhone設定 → カメラ → フォーマット → 「互換性優先」を推奨）`;
    }
    if (skippedFolders.length > 0) {
      message += `\n\n⚠️ Mastersに未登録のフォルダ名のため、以下はスキップされました（中のファイルは未処理のまま残っています）：\n`
               + skippedFolders.map(f => `・${f}`).join('\n')
               + `\nMastersシートに拠点を追加するか、フォルダ名を確認してください。`;
    }

    try { SpreadsheetApp.getUi().alert(message); } catch(_) {}

    return { newCount, mergedCount, errorCount, heicCount, skippedFolders, message, isTimeLimitReached };
  },
};