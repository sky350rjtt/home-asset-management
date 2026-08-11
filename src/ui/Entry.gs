// =============================================================================
// Entry.gs
//
// 役割: システムへの入り口およびマルチ画面ルーティング・データ中継
//   - onOpen()        : スプレッドシートを開いた時にメニューを追加
//   - scanAndExecute(): メニューから呼ばれる実行関数（Scanner.run()を呼ぶだけ）
//   - validateConfig(): Config・Mastersの設定確認
//   - doGet(e)       : WebApp として公開した時のエントリポイント（パラメータで画面分岐）
//   - getAssetStorageData() : 台帳データをViewer表示用に抽出（AI検索は intelligentSearch.gs が担当）
//   - getModelSettings() : UI（HTML）初期化時にモデル一覧と現在値を取得
//   - runScanFromUI()    : UIから実行された時のエントリポイント（モデル変更反映付き）
// =============================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Asset Management')
    .addItem('Scan & Execute', 'scanAndExecute')
    .addSeparator()
    .addItem('Config確認', 'validateConfig')
    .addToUi();
}

function scanAndExecute() {
  Scanner.run();
}

function doGet(e) {
  const page = e && e.parameter && e.parameter.p;

  if (page === 'v') {
    return HtmlService.createHtmlOutputFromFile('index_viewer')
      .setTitle('Asset Master Viewer')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } else {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('HomeAsset AI Scanner')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

/**
 * 閲覧画面（Viewer）の初期表示用。※AI検索は EXCLUSIVE_AI_VECTOR_SEARCH_ENTRANCE が担当。
 * 台帳の読み込み・見せ方への整形は shared/AssetPresenter.gs に委譲する
 * （logic/IntelligentSearch.gs と共用の部品。UI層・ロジック層のどちらからも対等に依存できる
 *  位置に置くことで、層をまたいだ依存の逆転を避けている）。
 * ここでは軽量化のためベクトル（T列）を外して返す。
 */
function getAssetStorageData() {
  try {
    return AssetPresenter.loadFromLedger(false);
  } catch (e) {
    console.error('Failed to fetch asset data for viewer:', e);
    throw new Error('台帳データの同期に失敗しました: ' + e.message);
  }
}


/**
 * Configシートの指定キーの値（B列）を書き換える。
 * 行位置(B5等)を決め打ちにせず、A列のキー名で行を探して書く方式にすることで、
 * Configの行を増減しても壊れないようにしている（getModelSettingsと同じ探し方）。
 */
function _writeConfigValue(key, value) {
  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Constants.SHEET.CONFIG);
  const lastRow = sheet.getLastRow();
  const keys    = sheet.getRange(1, 1, lastRow, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  throw new Error(`Configシートに「${key}」の行が見つかりません。`);
}

function runScanFromUI(selectedModel) {
  if (selectedModel) {
    _writeConfigValue(Constants.CONFIG_KEY.GEMINI_MODEL, selectedModel);

    if (typeof Config !== 'undefined' && Config.clear) {
      Config.clear();
    }
  }
  return Scanner.run();
}

/**
 * Configシートの「GEMINI_MODEL」行から、現在値と選択肢一覧を取得する。
 *
 * 【設計方針】Configシートはドロップダウン（データ入力規則）で選ばせる方式のため、
 *   セルが「未選択」という状態はそもそも起こり得ない。
 *   よって、この関数はコード側にモデル名を一切ハードコードしない：
 *     - GEMINI_MODEL行が見つからない → Configシートの構造が壊れている異常事態 → エラーで止める
 *     - ドロップダウン（入力規則）が外れている → 選択肢の出処が無い異常事態 → エラーで止める
 *   「わからないから適当な値で動かす」のではなく「わからないから止める」を徹底する。
 */
function getModelSettings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(Constants.SHEET.CONFIG);
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(1, 1, lastRow, 2).getValues();

  let targetRow = 0;
  let currentModel = null;

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === Constants.CONFIG_KEY.GEMINI_MODEL) {
      targetRow = i + 1;
      currentModel = String(values[i][1]).trim();
      break;
    }
  }

  if (!targetRow || !currentModel) {
    throw new Error('Configシートに「GEMINI_MODEL」の設定行が見つかりません。シート構成を確認してください。');
  }

  const range = sheet.getRange(targetRow, 2);
  const validation = range.getDataValidation();

  if (!validation || validation.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    throw new Error('Configシートの GEMINI_MODEL セルにドロップダウン（入力規則）が設定されていません。選択肢を追加・変更したい場合はこのセルの入力規則を編集してください。');
  }

  const models = validation.getCriteriaValues()[0];
  if (!models || models.length === 0) {
    throw new Error('Configシートの GEMINI_MODEL ドロップダウンに選択肢が1件もありません。');
  }

  return {
    currentModel: currentModel,
    models: models
  };
}

function validateConfig() {
  try {
    Config.clear();
    MastersDAO.clear();
    const config  = Config.load();
    const masters = MastersDAO.load();

    SpreadsheetApp.getUi().alert(
      `【環境設定チェック: OK】\n\n` +
      `🤖 使用AIモデル: ${config.GEMINI_MODEL}\n\n` +
      `🏠 登録拠点数: ${masters.locations.length} 件\n` +
      masters.locations.map(l => `  • ${l.code}（${l.name}）`).join('\n') +
      `\n\n📦 登録カテゴリ数: ${masters.categories.length} 件`
    );
  } catch(e) {
    SpreadsheetApp.getUi().alert(`❌ 設定エラーが発生しました：\n${e.message}`);
  }
}