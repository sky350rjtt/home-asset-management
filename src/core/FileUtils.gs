// =============================================================================
// FileUtils.gs
//
// 役割: ファイル操作のみ
// 責任: ファイルの取得・移動・命名規則の適用
//
// 流用: 完全流用可。どんなシステムでも1文字も変えず使える。
//       命名規則（buildFileName）だけはシステムに応じて変更する可能性がある。
//
// 【他モジュールへの依存】なし
// =============================================================================

const FileUtils = {
  getSupportedFiles(folder) {
    const result = [];
    const seen   = new Set();
    const all    = folder.getFiles();
 
    while (all.hasNext()) {
      const f  = all.next();
      const id = f.getId();
      if (seen.has(id)) continue;
      seen.add(id);
 
      const mime = f.getMimeType();
      if (Constants.SUPPORTED_MIME.includes(mime)) {
        result.push({ file: f, isHeic: false });
      } else if (mime === Constants.MIME_HEIC || f.getName().toLowerCase().endsWith('.heic')) {
        result.push({ file: f, isHeic: true });
      }
    }
 
    return result;
  },
 
  move(file, fromFolder, toFolder) {
    toFolder.addFile(file);
    try {
      fromFolder.removeFile(file);
    } catch(e) {
      console.warn(`[FileUtils] 移動元からの削除をスキップ: ${e.message}`);
    }
  },
 
  moveToUnresolved(file, fromFolder, unresFolder, reasonCode) {
    // 【多重付与ガード】リトライで何度も隔離されると
    //   UNRESOLVED_..._UNRESOLVED_..._元の名前 とプレフィックスが積み重なる事故が起きる。
    //   すでに UNRESOLVED_ が付いていたら二重に付けない。
    const name = file.getName();
    if (!name.startsWith('UNRESOLVED_')) {
      file.setName(`UNRESOLVED_${reasonCode}_${name}`);
    }
    this.move(file, fromFolder, unresFolder);
  },
 
  getExt(file) {
    const m = file.getMimeType();
    if (m === 'image/jpeg') return 'jpg';
    if (m === 'image/png')  return 'png';
    return 'pdf';
  },
 
  extractAssetId(filename) {
    const match = filename.match(/^([A-Z0-9]+)_/i);
    return match ? match[1].toUpperCase() : null;
  },
 
  /**
   * 配列で渡されたパーツをアンダースコアで結合し、拡張子を付与する。
   * @param {string[]} parts - ファイル名を構成するパーツの配列
   * @param {string} ext     - 拡張子
   * @returns {string}
   */
  buildFileName(parts, ext) {
    const baseName = parts
      .map(p => String(p || '').trim())
      .filter(p => p.length > 0)
      .join('_');
    return `${baseName}.${ext || 'pdf'}`;
  },
};