// =============================================================================
// MastersDAO.gs
//
// 役割: Mastersシートからマスタデータを読み込む（読み取り専用）
// 責任: 拠点リスト・カテゴリリストの提供のみ
//
// 流用: 構造流用可。
//       書類管理システムなら書類カテゴリを同じ形式でMastersシートに書けばよい。
//       このファイルの読み込みロジックは1文字も変えず使える。
//
// 【Mastersシートの形式】
//   セクション1: 拠点リスト（A列=コード、B列=名前、C列=種別コード）
//   セクション2: カテゴリリスト（A列=コード、B列=名前、C列=例示）
//   セクションはA列の値で判別（"LOCATION_"で始まる行が拠点、"CATEGORY_"で始まる行がカテゴリ）
//
// 【他モジュールへの依存】Constants（シート名の定数 SHEET のみ）
// =============================================================================

const MastersDAO = (() => {
  let _cache = null;
 
  return {
    load() {
      if (_cache) return _cache;
 
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Constants.SHEET.MASTERS);
      if (!sheet) throw new Error('Mastersシートが見つかりません。');
 
      const lastRow = sheet.getLastRow();
      if (lastRow === 0) throw new Error('Mastersシートが空です。マスタデータを入力してください。');
 
      const rows         = sheet.getRange(1, 1, lastRow, 3).getValues();
      const locationsMap = {};
      const categories   = [];
 
      rows.forEach(([code, name, extra]) => {
        if (!code) return;
        const key = String(code).trim();
 
        // --- 拠点リストの処理 ---
        if (key.startsWith('LOCATION_')) {
          
          if (key.endsWith('_NAME')) {
            // LOCATION_H01_NAME -> H01 を特定
            const locCode = key.replace('LOCATION_', '').replace('_NAME', '').toUpperCase();
            if (!locationsMap[locCode]) {
              locationsMap[locCode] = { code: locCode, name: '' };
            }
            // B列の人間用の名前（Nerima など）を取得
            locationsMap[locCode].name = String(name).trim();
          }
          
          // ※ _TYPE 行は完全に無視されるため、Mastersシートに残っていても削除してもどちらでも動きます。
          
        // --- カテゴリリストの処理 ---
        } else if (key.startsWith('CATEGORY_')) {
          categories.push({
            code:     key.replace('CATEGORY_', '').toUpperCase(),
            name:     String(name).trim(),
            examples: String(extra || '').trim(),
          });
        }
      });
 
      // 【修正】名前（name）が正しく取得できている拠点を有効化
      const locations = Object.values(locationsMap).filter(loc => loc.name);
 
      if (!locations.length)  throw new Error('Mastersシート：拠点が1件も設定されていません。');
      if (!categories.length) throw new Error('Mastersシート：カテゴリが1件も設定されていません。');
 
      _cache = { locations, categories };
      return _cache;
    },
 
    getLocations()  { return this.load().locations; },
    getCategories() { return this.load().categories; },
 
    isValidCategory(categoryCode) {
      if (!categoryCode) return false;
      const target = String(categoryCode).trim().toUpperCase();
      return this.getCategories().some(c => c.code === target);
    },
 
    buildCategoryPromptText() {
      return this.getCategories()
        .map(c => `${c.code}=${c.name}（${c.examples}）`)
        .join('\n');
    },
 
    clear() { _cache = null; },
  };
})();