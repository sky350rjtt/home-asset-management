// =============================================================================
// SheetUtils.gs
//
// 役割: スプレッドシート操作のユーティリティ
// 責任: シートの取得・作成・ログ記録のみ
//
// 流用: 完全流用可。どんなシステムでも1文字も変えず使える。
//
// 【他モジュールへの依存】なし
// =============================================================================

const SheetUtils = {
  getOrCreate(name, headers) {
    if (!name) throw new Error('[SheetUtils] シート名が指定されていません。');
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    let   sheet = ss.getSheetByName(name);
 
    if (!sheet) {
      sheet = ss.insertSheet(name);
      if (headers && headers.length > 0) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      }
    }
    return sheet;
  },
 
  /**
   * 指定シートの末尾にタイムスタンプ付きで1行追記する。
   * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
   * @param {any[]} dataParts - 2列目以降に並べるデータの配列
   */
  log(sheet, dataParts) {
    if (!sheet) {
      console.error('[SheetUtils] 宛先シートオブジェクトが正しく渡されていません。');
      return;
    }
    sheet.appendRow([new Date(), ...(dataParts || [])]);
  },
};