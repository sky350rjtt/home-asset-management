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
      return { newCount: 0, mergedCount: 0, errorCount: 0, heicCount: 0, message: msg };
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
      return { newCount: 0, mergedCount: 0, errorCount: 0, heicCount: 0, message: msg };
    }
 
    const logSheet    = SheetUtils.getOrCreate(Constants.SHEET.LOG,
      ['processedAt', 'filename', 'assetId', 'status', 'detail']);
    const inboxRoot   = DriveApp.getFolderById(config.INBOX_FOLDER_ID);
    const docsFolder  = DriveApp.getFolderById(config.DOCS_FOLDER_ID);
    const unresFolder = DriveApp.getFolderById(config.UNRESOLVED_FOLDER_ID);
 
    let newCount = 0, mergedCount = 0, errorCount = 0, heicCount = 0;
 
    const subFolders = inboxRoot.getFolders();
    while (subFolders.hasNext()) {
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
          continue;
        }
        const r = Location.process(subFolder, location, config, logSheet, docsFolder, unresFolder);
        newCount   += r.newCount;
        errorCount += r.errorCount;
        heicCount  += r.heicCount;
      }
    }
 
    let message = `処理完了\n新規資産登録：${newCount}件\n既存への書類追加：${mergedCount}件\nエラー隔離：${errorCount}件`;
    if (heicCount > 0) {
      message += `\n\n⚠️ HEIC形式の画像が ${heicCount} 件スキップされました。\n`
               + `JPEGまたはPNGに変換してから再投入してください。\n`
               + `（iPhone設定 → カメラ → フォーマット → 「互換性優先」を推奨）`;
    }
 
    try { SpreadsheetApp.getUi().alert(message); } catch(_) {}
 
    return { newCount, mergedCount, errorCount, heicCount, message };
  },
};