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
 * 【内部専用ローダー】台帳の全行を、画面表示用のきれいなオブジェクト配列へ整える。
 *  - 台帳の物理列を読むのは AssetMasterDAO.readAll() に任せる（列番号はここに一切書かない）。
 *  - ここは「名前付きの値」を受け取り、拠点名/カテゴリ名の解決・書類リンクの組み立て等の
 *    “見せ方(プレゼンテーション)”だけを担当する。
 *  includeEmbedding=false … ベクトル(T列)を外して返す（ブラウザ送信用の軽量版）。
 *  includeEmbedding=true  … embeddingRaw を同梱（サーバー内部のAI検索専用）。
 */
function _loadAssetsFromLedger(includeEmbedding) {
  const config  = Config.load();
  const records = AssetMasterDAO.readAll(config.ASSET_MASTER_ID, includeEmbedding);
  const masters = MastersDAO.load();

  // カンマ連結のFileID文字列 → 画面用の {type,url} 配列。URLの組み立ては見せ方の責務なのでここでよい。
  function toFiles(rawIds, docType) {
    const raw = String(rawIds || '').trim();
    if (!raw) return [];
    return raw.split(',').map(id => ({
      type: docType,
      url: 'https://drive.google.com/file/d/' + id.trim() + '/view'
    }));
  }

  return records.map(function(rec) {
    const locObj = masters.locations.find(l => l.code === rec.locationCode);
    const catObj = masters.categories.find(c =>
      String(c.code).trim().toUpperCase() === rec.category.toUpperCase());

    const files = []
      .concat(toFiles(rec.docIds.MNL, Constants.DOC_TYPE.MNL.code))
      .concat(toFiles(rec.docIds.RCP, Constants.DOC_TYPE.RCP.code))
      .concat(toFiles(rec.docIds.WRT, Constants.DOC_TYPE.WRT.code))
      .concat(toFiles(rec.docIds.OTH, Constants.DOC_TYPE.OTH.code));

    const asset = {
      id:      rec.assetId,
      name:    rec.productName,
      loc:     rec.locationCode,
      locName: locObj ? locObj.name : rec.locationName,
      cat:     rec.category,
      catName: catObj ? catObj.name : rec.category,
      maker:   rec.maker,
      model:   rec.modelNumber,
      purchaseDate: rec.purchaseDate,
      status:  rec.disposed, // N列（廃棄日）。空欄=稼働中。
      files:   files,
      remarks: rec.remarks
    };
    // ベクトルはサーバー内部のAI検索でだけ使う。ブラウザには絶対に送らない。
    if (includeEmbedding) asset.embeddingRaw = rec.embedding || '';
    return asset;
  }).filter(function(asset) {
    return asset.id && asset.name;
  });
}

/**
 * 閲覧画面（Viewer）の初期表示用。※AI検索は EXCLUSIVE_AI_VECTOR_SEARCH_ENTRANCE が担当。
 * ここでは軽量化のためベクトル（T列）を外して返す。
 */
function getAssetStorageData() {
  try {
    return _loadAssetsFromLedger(false);
  } catch (e) {
    console.error('Failed to fetch asset data for viewer:', e);
    throw new Error('台帳データの同期に失敗しました: ' + e.message);
  }
}


/**
 * Configシートの指定キーの値（B列）を書き換える。
 * ★行位置(B5等)を決め打ちせず、A列のキー名で行を探して書く。
 *   → Configの行を増減しても壊れない。「探す」方式に統一（getModelSettingsと同じ流儀）。
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