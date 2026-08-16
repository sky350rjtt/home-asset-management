// =============================================================================
// Config.gs
//
// 役割: Configシートからインフラ設定を読み込む
// 責任: フォルダID・APIキー・AIモデル名の管理のみ
//       拠点・カテゴリ（マスタ）は持たない → MastersDAO.gs が担当
//
// 流用: 流用不可。アプリごとに設定値が変わるため。
//       ただし読み込み方の構造は他システムの参考にできる。
//
// 【Configシートの形式】
//   A列=キー、B列=値
//   GEMINI_MODEL, INBOX_FOLDER_ID, DOCS_FOLDER_ID,
//   UNRESOLVED_FOLDER_ID, ASSET_MASTER_ID
//
// 【他モジュールへの依存】Constants（シート名の定数 SHEET のみ）
// =============================================================================

const Config = (() => {
  let _cache = null;
 
  return {
    load() {
      if (_cache) return _cache;
 
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Constants.SHEET.CONFIG);
      if (!sheet) throw new Error('Configシートが見つかりません。');
 
      const lastRow = sheet.getLastRow();
      if (lastRow === 0) throw new Error('Configシートが空です。設定値を入力してください。');
 
      const raw = {};
      sheet.getRange(1, 1, lastRow, 2).getValues()
        .forEach(([k, v]) => { if (k) raw[String(k).trim()] = v; });
 
      // 【APIキーの安全な調達（ハイブリッド方式）】
      // 1. スクリプトプロパティ（PropertiesService）にあれば最優先（シート閲覧者にキーを見せない安全な設定）
      // 2. 未設定なら従来のConfigシートの値にフォールバック（後方互換性を維持）
      let scriptPropApiKey = null;
      try {
        scriptPropApiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
      } catch(e) {
        console.warn(`[Config] スクリプトプロパティ取得スキップ: ${e.message}`);
      }
      const geminiApiKey = String(scriptPropApiKey || raw['GEMINI_API_KEY'] || '').trim();

      _cache = {
        GEMINI_API_KEY:       geminiApiKey,
        GEMINI_MODEL:         String(raw['GEMINI_MODEL']         || ''),
        GEMINI_EMBED_MODEL:   String(raw['GEMINI_EMBED_MODEL']   || ''),
        // 【次元数の明示固定】Configシートの GEMINI_EMBED_DIMENSION 行が唯一の真実源。
        //   ここにハードコードされた既定値は置かない（getModelSettingsと同じfail-fast方針）。
        //   未設定・不正値ならこの場でエラーにし、静かに間違った次元で走らせない。
        GEMINI_EMBED_DIMENSION: (() => {
          const n = parseInt(raw['GEMINI_EMBED_DIMENSION'], 10);
          if (!n || n <= 0) {
            throw new Error('Configシートに GEMINI_EMBED_DIMENSION（次元数の数値）が正しく設定されていません。例: 768');
          }
          return n;
        })(),
        INBOX_FOLDER_ID:      String(raw['INBOX_FOLDER_ID']      || ''),
        DOCS_FOLDER_ID:       String(raw['DOCS_FOLDER_ID']       || ''),
        UNRESOLVED_FOLDER_ID: String(raw['UNRESOLVED_FOLDER_ID'] || ''),
        ASSET_MASTER_ID:      String(raw['ASSET_MASTER_ID']      || ''),
        // 【管理者判定】カンマ区切りのメールアドレス一覧。未設定でもエラーにしない
        //   （閲覧機能自体はこれが無くても成立するため、fail-fastの対象外）。
        //   空配列への変換はgetCurrentUserRole()側の責務とし、ここでは生文字列のまま保持する。
        ADMIN_EMAILS:         String(raw['ADMIN_EMAILS']         || ''),
        // 【閲覧許可リスト】カンマ区切りのメールアドレス一覧。ここに無いユーザーはWebアプリの
        //   中身を一切見せない（doGetの入口で弾く）。ADMIN_EMAILSの人は暗黙に閲覧も許可される
        //   （_isAllowedUser側で合算判定するため、ここに二重登録する必要はない）。
        ALLOWED_EMAILS:       String(raw['ALLOWED_EMAILS']       || ''),
        // 【検索の足切り閾値】この値に「正解」は無く運用しながら調整するものなので、
        //   コード側に決め打ちの数値は置かない。未設定時は0（＝足切りしない）という
        //   中立な既定値にとどめ、閾値を持ちたければConfigシートに明示的に追加してもらう。
        SEARCH_MIN_SCORE: raw['GEMINI_SEARCH_MIN_SCORE']
          ? parseFloat(raw['GEMINI_SEARCH_MIN_SCORE'])
          : 0,
      };

      const missing = ['GEMINI_API_KEY', 'INBOX_FOLDER_ID', 'DOCS_FOLDER_ID', 'UNRESOLVED_FOLDER_ID']
        .filter(k => !_cache[k]);
      if (missing.length) {
        let msg = `Configの必須項目が未入力です：${missing.join(', ')}`;
        if (missing.includes('GEMINI_API_KEY')) {
          msg += '（※GEMINI_API_KEYはスクリプトプロパティまたはConfigシートに設定してください）';
        }
        throw new Error(msg);
      }

      return _cache;
    },
 
    clear() { _cache = null; },
  };
})();