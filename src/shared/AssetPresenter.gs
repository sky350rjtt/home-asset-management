// =============================================================================
// AssetPresenter.gs
//
// 役割: 台帳(AssetMaster)の全行を、画面表示・検索用の「きれいなオブジェクト配列」へ整える。
// 責任: 台帳の物理列を読むのは AssetMasterDAO.readAll() に任せる（列番号はここに一切書かない）。
//       ここは「名前付きの値」を受け取り、拠点名/カテゴリ名の解決・書類リンクの組み立て等の
//       “見せ方(プレゼンテーション)”だけを担当する。
//
// 【使いどころ】ui/Entry.gs（Viewer初期表示用、embeddingなしの軽量版）と
//   logic/IntelligentSearch.gs（AIベクトル検索用、embeddingあり）の双方から呼ばれる共通部品。
//   以前はEntry.gs内のグローバル関数 _loadAssetsFromLedger() をIntelligentSearch.gsが直接呼ぶ、
//   「UI層をロジック層が参照する」逆依存になっていたため、ここへ切り出した。
//
// 流用: 流用不可。台帳の見せ方（id/name/loc/locName等のキー名、書類リンクの組み立て方）は
//       本システム固有の画面仕様に合わせた設計。
//
// 【他モジュールへの依存】Config, AssetMasterDAO, MastersDAO, Constants（DOC_TYPEの定義）
// =============================================================================

const AssetPresenter = {
  /**
   * 台帳の全行を、画面表示用のきれいなオブジェクト配列へ整えて返す。
   * @param {boolean} includeEmbedding
   *   false … ベクトル(T列)を外して返す（ブラウザ送信用の軽量版。Entry.gsのViewer初期表示が使う）。
   *   true  … embeddingRaw を同梱（サーバー内部のAI検索専用。IntelligentSearch.gsが使う）。
   *   ベクトルはサーバー内部のAI検索でだけ使い、ブラウザには絶対に送らないための切り替えであり、
   *   不要なデータを余分に転送しないパフォーマンス配慮として維持する。
   */
  loadFromLedger(includeEmbedding) {
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
  },
};
