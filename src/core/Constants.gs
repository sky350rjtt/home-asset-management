// =============================================================================
// Constants.gs
//
// 役割: 全システム共通の定数のみ
//       AssetMaster固有の列定義（COL・DOC_COL）はAssetMasterDAO.gsが持つ
//
// 流用: 完全流用可。どのシステムでも変更不要。
//
// 【他モジュールへの依存】なし
// =============================================================================

const Constants = {
  SUPPORTED_MIME: ['application/pdf', 'image/jpeg', 'image/png'],
  MIME_HEIC:      'image/heic',
  ADD_FOLDER:     'ADD',

  // 【シート名の唯一の真実源】どのファイルも直書き禁止。名称変更はここ1箇所で完結する。
  SHEET: {
    ASSET:   'AssetMaster',
    CONFIG:  'Config',
    MASTERS: 'Masters',
    LOG:     'ProcessingLog',
  },

  // 【Config内のキー名】行位置(B5等)に依存せず、キー名で行を探すための定数。
  CONFIG_KEY: {
    GEMINI_MODEL: 'GEMINI_MODEL',
  },
  // 【書類種別の唯一の定義】ここを変えれば、JS側の比較(dt===...)とAIプロンプトの
  //   説明文の両方に反映される。以前はLocation.gs/AddFolder.gsの2箇所に
  //   一言一句同じ文字列がコピペされていた（本部が1箇所変えれば全店舗に伝わる、の欠如）。
  DOC_TYPE: {
    MNL: { code: 'MNL', label: '取扱説明書/Manual',   shortLabel: 'Manual'   },
    RCP: { code: 'RCP', label: '領収書/Receipt',       shortLabel: 'Receipt'  },
    WRT: { code: 'WRT', label: '保証書/Warranty',       shortLabel: 'Warranty' },
    OTH: { code: 'OTH', label: 'その他/Other',          shortLabel: 'Other'    },
  },

  // Location.gs/AddFolder.gsのプロンプト「docType」フィールド用（日本語併記の説明文）
  buildDocTypePromptText() {
    return Object.values(this.DOC_TYPE).map(d => `${d.code}=${d.label}`).join(', ');
  },

  // 同プロンプトの「files[].docType」フィールド用（英語のみの簡潔な説明文）
  buildDocTypeShortPromptText() {
    return Object.values(this.DOC_TYPE).map(d => `${d.code}=${d.shortLabel}`).join(', ');
  },
};