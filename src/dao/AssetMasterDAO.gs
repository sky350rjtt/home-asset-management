// =============================================================================
// AssetMasterDAO.gs
//
// 役割: AssetMasterシートへのデータアクセスのみ（DAO = Data Access Object）
// 責任: データの読み書きのみ。業務ロジック（何を登録するか・ベクトル変換等）は持たない。
//       AssetMaster固有の列定義（COL・DOC_COL）もここで管理する。
//
// 【他モジュールへの依存】Constants（シート名の定数SHEET、書類種別の定数DOC_TYPE）
// =============================================================================

const AssetMasterDAO = (() => {
 
  const COL = {
    ASSET_ID:       1, // A列
    LOC_CODE:       2, // B列：拠点コード
    LOC_NAME:       3, // C列：拠点名
    CATEGORY:       4, // D列
    MAKER:          5, // E列
    PRODUCT:        6, // F列
    MODEL:          7, // G列
    INSTALL:        8, // H列
    REG_YEAR:       9, // I列
    PURCHASE_DATE:  10, // J列
    PURCHASE_PRICE: 11, // K列
    PURCHASE_STORE: 12, // L列
    WARRANTY_EXP:   13, // M列
    DISPOSED:       14, // N列：廃棄日。空欄=稼働中／日付記入=廃棄。GASは書き込まない（人間の手動運用列）
    MNL:            15, // O列
    RCP:            16, // P列
    WRT:            17, // Q列
    OTH:            18, // R列
    REMARKS:        19, // S列：人間用＆AI用の言い換えキーワード
    EMBEDDING:      20, // T列：AI専用のベクトル格納庫
  };
 
  const DOC_COL = {
    MNL: 15,
    RCP: 16,
    WRT: 17,
    OTH: 18,
  };
 
  // 台帳の物理的な列数。COL定義から自動算出するので、列を増減してもここは追従する。
  const WIDTH = Math.max.apply(null, Object.keys(COL).map(function(k){ return COL[k]; }));

  function _getSheet(assetMasterId) {
    const ss = assetMasterId
      ? SpreadsheetApp.openById(assetMasterId)
      : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(Constants.SHEET.ASSET);
    if (!sheet) throw new Error('AssetMasterシートが見つかりません。');
    return sheet;
  }
 
  return {
    /**
     * 台帳の全行を読み、物理列を「意味のある名前」に変換した配列で返す。
     * ★台帳の列配置(COL/DOC_COL)を知ってよいのは、この DAO だけ。
     *   呼び出し側(Entry等)は row[13] のような生インデックスを一切触らない。
     * @param {boolean} includeEmbedding trueならT列（巨大ベクトル）も同梱。省略時は付けない。
     */
    readAll(assetMasterId, includeEmbedding) {
      const sheet   = _getSheet(assetMasterId);
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      const values = sheet.getRange(2, 1, lastRow - 1, WIDTH).getValues();
      const pick = (r, col) => String(r[col - 1] == null ? '' : r[col - 1]).trim();

      return values.map(function(r, idx) {
        const rec = {
          rowNumber:    idx + 2, // 書き戻し用（バッチ処理がこの行を再度特定するため）
          assetId:      pick(r, COL.ASSET_ID),
          locationCode: pick(r, COL.LOC_CODE),
          locationName: pick(r, COL.LOC_NAME),
          category:     pick(r, COL.CATEGORY),
          maker:        pick(r, COL.MAKER),
          productName:  pick(r, COL.PRODUCT),
          modelNumber:  pick(r, COL.MODEL),
          purchaseDate: pick(r, COL.PURCHASE_DATE),
          disposed:     pick(r, COL.DISPOSED), // N列＝廃棄日。空欄=稼働中。
          remarks:      pick(r, COL.REMARKS),
          docIds: {
            MNL: pick(r, DOC_COL.MNL),
            RCP: pick(r, DOC_COL.RCP),
            WRT: pick(r, DOC_COL.WRT),
            OTH: pick(r, DOC_COL.OTH),
          },
        };
        if (includeEmbedding) rec.embedding = pick(r, COL.EMBEDDING);
        return rec;
      });
    },

    findRowById(assetMasterId, assetId) {
      const sheet   = _getSheet(assetMasterId);
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return 0;
      const ids = sheet.getRange(2, COL.ASSET_ID, lastRow - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === assetId) return i + 2;
      }
      return 0;
    },
 
    insert(assetMasterId, data) {
      const sheet   = _getSheet(assetMasterId);
      const row     = new Array(WIDTH).fill(''); // 20列ぶんの空箱を用意（初期値は全部カラ）

      const currentYearStr = String(new Date().getFullYear()).slice(-2);

      row[COL.ASSET_ID - 1]       = data.assetId;
      row[COL.LOC_CODE - 1]       = data.locationCode; 
      row[COL.LOC_NAME - 1]       = data.locationName; 
      row[COL.CATEGORY - 1]       = data.category       || '';
      row[COL.MAKER - 1]          = data.maker          || '';
      row[COL.PRODUCT - 1]        = data.productName    || '';
      row[COL.MODEL - 1]          = data.modelNumber    || '';
      row[COL.REG_YEAR - 1]       = currentYearStr;    
      row[COL.PURCHASE_DATE - 1]  = data.purchaseDate   || '';
      row[COL.PURCHASE_PRICE - 1] = data.purchasePrice  || '';
      row[COL.PURCHASE_STORE - 1] = data.purchaseStore  || '';
      row[COL.WARRANTY_EXP - 1]   = data.warrantyExpiry || '';
      // N列（廃棄日）は空欄のまま＝稼働中。書類IDは後段のappendFileId()が入れるため、ここでは触らない。
      row[COL.REMARKS - 1]        = data.remarks        || '';
      
      // ★DAOは思考停止で、渡された embedding の数値をそのままT列に突っ込むだけ
      row[COL.EMBEDDING - 1]      = data.embedding      || '';
 
      sheet.appendRow(row);
      return sheet.getLastRow(); 
    },

    /**
     * T列（EMBEDDING）にベクトルデータをピンポイントで上書き保存する
     */
    updateEmbedding(assetMasterId, assetId, embeddingJson) {
      const sheet = _getSheet(assetMasterId);
      const row = this.findRowById(assetMasterId, assetId);
      if (!row) return;
      sheet.getRange(row, COL.EMBEDDING).setValue(embeddingJson);
    },
 
    appendFileId(assetMasterId, row, docType, fileId) {
      const sheet = _getSheet(assetMasterId);
      const col   = DOC_COL[docType] || DOC_COL[Constants.DOC_TYPE.OTH.code];
      const cell  = sheet.getRange(row, col);
      const cur   = cell.getValue();
      cell.setValue(cur ? `${cur}, ${fileId}` : fileId);
    },
 
    getNextSeq(assetMasterId, row, docType) {
      const sheet = _getSheet(assetMasterId);
      const col   = DOC_COL[docType] || DOC_COL[Constants.DOC_TYPE.OTH.code];
      const val   = sheet.getRange(row, col).getValue();
      if (!val) return 1;
      return val.toString().split(',').filter(s => s.trim()).length + 1;
    },
 
    updatePurchaseInfo(assetMasterId, row, info) {
      const sheet = _getSheet(assetMasterId);
      [
        [COL.PURCHASE_DATE,  info.purchaseDate],
        [COL.PURCHASE_PRICE, info.purchasePrice],
        [COL.PURCHASE_STORE, info.purchaseStore],
        [COL.WARRANTY_EXP,   info.warrantyExpiry],
      ].forEach(([col, val]) => {
        if (val && !sheet.getRange(row, col).getValue())
          sheet.getRange(row, col).setValue(val);
      });
    },
 
    getAssetInfo(assetMasterId, row) {
      const sheet = _getSheet(assetMasterId);
      const [maker, product, model] = sheet
        .getRange(row, COL.MAKER, 1, 3).getValues()[0];
      return { maker, product, model };
    },

    /**
     * S列（remarks）だけを軽量に読む。上書き前の既存値確認（監査ログ用）に使う。
     */
    getRemarks(assetMasterId, row) {
      const sheet = _getSheet(assetMasterId);
      return String(sheet.getRange(row, COL.REMARKS).getValue() || '').trim();
    },

    /**
     * S列（remarks）とT列（embedding）を1回のAPI呼び出しでまとめて書き込む。
     * ★S/T列は物理的に隣接(19,20)しているため、getRange(row,19,1,2)で一括更新できる。
     *   remarksとembeddingは常にセットで更新される情報なので、書き込みも1回にまとめる
     *   （ネットワーク往復を減らし、片方だけ書けて片方が失敗する中途半端な状態も避ける）。
     * @param {string} remarks         S列に書くあいまい検索ワード
     * @param {string} embeddingJson   T列に書くベクトルのJSON文字列（空文字なら未生成扱い）
     */
    updateRemarksAndEmbedding(assetMasterId, row, remarks, embeddingJson) {
      const sheet = _getSheet(assetMasterId);
      sheet.getRange(row, COL.REMARKS, 1, 2).setValues([[remarks || '', embeddingJson || '']]);
    },
 
    assignId(assetMasterId, locationCode, categoryCode) {
      const sheet   = _getSheet(assetMasterId);
      const lastRow = sheet.getLastRow();
      
      const currentYearStr = String(new Date().getFullYear()).slice(-2); 
      const prefix = `${locationCode}${categoryCode}${currentYearStr}`;
      let maxSeq = 0; 
      
      if (lastRow > 1) {
        const idValues = sheet.getRange(2, COL.ASSET_ID, lastRow - 1, 1).getValues();
        
        idValues.forEach(row => {
          const id = String(row[0]);
          if (id.length === 11 && id.startsWith(prefix)) {
            const idSeq = id.substring(8, 11); 
            const seqNum = parseInt(idSeq, 10);
            if (!isNaN(seqNum) && seqNum > maxSeq) {
              maxSeq = seqNum;
            }
          }
        });
      }
      
      const nextSeq = maxSeq + 1;
      const paddedSeq = String(nextSeq).padStart(3, '0'); 
      
      return `${prefix}${paddedSeq}`;
    },
  };
})();