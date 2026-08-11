// =============================================================================
// Gemini.gs
//
// 役割: Gemini API（マルチモデル / Embeddingモデル）との純粋な通信窓口
// 責任: 
//   1. analyze(): 巨大ファイル（数十MBのPDF等）をFile API経由で安全に一括解析
//   2. embed()  : 任意のクリーンテキストを高速に1024次元ベクトルに変換
//
// 注意: このクラスは通信の成否のみに集中し、業務ロジックや保存先は一切関知しない。
// =============================================================================

const Gemini = {
  /**
   * Gemini API で単一または複数のファイルバイナリ（Blob）を一括解析します。
   * @param {string} apiKey    - Gemini API キー
   * @param {string} model     - モデル名（例: gemini-2.5-flash）
   * @param {string} prompt    - 完成済みのプロンプト文字列
   * @param {Blob|Blob[]} inputBlobs - 解析対象ファイルのBlob、またはその配列
   * @param {string|string[]} [inputFilenames] - 任意：ログ出力用のファイル識別名、またはその配列
   * @returns {Object|null}   - 解析結果JSON、または完全失敗時はnull
   */
  analyze(apiKey, model, prompt, inputBlobs, inputFilenames = 'Unknown') {
    // 1. 届いたデータが単一なら自動的に配列に変換し、マルチ処理と共通化する（互換性維持）
    const blobs = Array.isArray(inputBlobs) ? inputBlobs : [inputBlobs];
    
    let filenames = [];
    if (Array.isArray(inputFilenames)) {
      filenames = inputFilenames;
    } else {
      filenames = blobs.map((_, i) => i === 0 ? inputFilenames : `File_${i + 1}`);
    }

    // --- MIMEタイプの一括チェック ---
    const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png'];
    for (let i = 0; i < blobs.length; i++) {
      const mimeType = blobs[i].getContentType();
      if (!allowedMimes.includes(mimeType)) {
        console.error(`[Gemini API Reject] 非対応のMIME形式です: ${mimeType} / Target: ${filenames[i]}`);
        return null;
      }
    }

    const fileDataList = []; // アップロード成功した全ファイルのメタデータを記録する帳簿

    try {
      // -------------------------------------------------------------------------
      // STEP 1-1 & 1-2: 全ファイルの並列アップロード（メモリ最適化ストリーム仕様を完全維持）
      // -------------------------------------------------------------------------
      for (let i = 0; i < blobs.length; i++) {
        const blob = blobs[i];
        const filename = filenames[i];
        const mimeType = blob.getContentType();
        const size = blob.getBytes().length.toString(); // サイズ計測用

        console.log(`[Gemini Debug] 1-1. セッション初期化を開始... [${i + 1}/${blobs.length}] / Target: ${filename} / Size: ${size} bytes`);
        
        const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
        const initRes = UrlFetchApp.fetch(initUrl, {
          method: 'post',
          headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': size,
            'X-Goog-Upload-Header-Content-Type': mimeType
          },
          contentType: 'application/json',
          payload: JSON.stringify({ file: { displayName: filename } }),
          muteHttpExceptions: true
        });

        if (initRes.getResponseCode() !== 200) {
          console.error(`[Gemini Fatal 1-1] 初期化通信が拒絶されました。Status: ${initRes.getResponseCode()} / Body: ${initRes.getContentText()}`);
          return null;
        }

        const headers = initRes.getHeaders();
        let uploadUrl = null;
        for (const key in headers) {
          if (key.toLowerCase() === 'x-goog-upload-url') {
            uploadUrl = headers[key];
            break;
          }
        }

        if (!uploadUrl) {
          console.error(`[Gemini Fatal 1-1] ヘッダーから特設URLを抽出できません。全ヘッダー: ${JSON.stringify(headers)}`);
          return null;
        }

        console.log(`[Gemini Debug] 1-2. 特設URLを確立。バイナリ送信を開始します... [${filename}]`);
        
        const uploadRes = UrlFetchApp.fetch(uploadUrl, {
          method: 'post',
          headers: {
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize'
          },
          contentType: mimeType,
          payload: blob, // ★ 24MBのパンクを防ぐ、あなたオリジナルのストリーム仕様を完全死守！
          muteHttpExceptions: true
        });

        if (uploadRes.getResponseCode() !== 200) {
          console.error(`[Gemini Fatal 1-2] バイナリ流し込みに失敗。Status: ${uploadRes.getResponseCode()} / Body: ${uploadRes.getContentText()}`);
          return null;
        }
        
        const fileData = JSON.parse(uploadRes.getContentText()).file;
        console.log(`[Gemini Debug] 1-2. Googleサーバー上に一時URIを完全確立: ${fileData.uri}`);
        
        // データを配列にストック
        fileDataList.push({
          uri: fileData.uri,
          name: fileData.name,
          mimeType: mimeType,
          filename: filename
        });
      }

      // -------------------------------------------------------------------------
      // STEP 1-3: 全ファイルが「ACTIVE」になるまで粘り強く監視（36回×5秒＝3分を完全維持）
      // -------------------------------------------------------------------------
      let isAllReady = true;

      for (const fd of fileDataList) {
        console.log(`[Gemini Debug] 1-3. Google側でのファイル前処理（ACTIVE化）の監視を開始します... [${fd.filename}]`);
        const statusUrl = `https://generativelanguage.googleapis.com/v1beta/${fd.name}?key=${apiKey}`;
        let isReady = false;

        for (let poll = 1; poll <= 36; poll++) {
          try {
            const checkRes = UrlFetchApp.fetch(statusUrl, { method: 'get', muteHttpExceptions: true });
            if (checkRes.getResponseCode() === 200) {
              const currentStatus = JSON.parse(checkRes.getContentText());
              const state = currentStatus.state || 'ACTIVE';

              console.log(`[Gemini Poll #${poll}] [${fd.filename}] 現在のステータス: ${state}`);

              if (state === 'ACTIVE') {
                isReady = true;
                break;
              }
              if (state === 'FAILED') {
                console.error(`[Gemini Fatal 1-3] Google側でのファイル変換前処理が致命的失敗しました。`);
                break;
              }
            }
          } catch(e) {
            console.warn(`[Gemini Poll Warning] ステータス確認通信で例外: ${e.message}`);
          }
          Utilities.sleep(5000); 
        }

        if (!isReady) {
          console.error(`[Gemini Fatal 1-3] ファイル [${fd.filename}] の前処理が時間内に完了しませんでした。`);
          isAllReady = false;
          break;
        }
      }

      if (!isAllReady) return null;

      // -------------------------------------------------------------------------
      // STEP 2: 確立された全URIをプロンプトと合体させ、AIに送信（最大3回リトライ・指数バックオフ）
      // -------------------------------------------------------------------------
      console.log(`[Gemini Debug] 2. AIマルチコンテンツ一括解析フェーズを開始します...`);
      const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      // ★ 修正版：ダブルクォーテーションの競合を解消
      let fileContext = "You are provided with the following files for a single product asset:\n";
      fileDataList.forEach((fd, idx) => {
        fileContext += `- File [${idx + 1}]: Temporary URI is "${fd.uri}", Original Filename is "${fd.filename}"\n`;
      });
      fileContext += "\nPlease map each 'Original Filename' to its correct docType in your response JSON.\n\n";

      // プロンプトの先頭に、このファイル名の情報を結合する
      const parts = [{ text: fileContext + prompt }];

      // 実際のバイナリデータを結合
      fileDataList.forEach(fd => {
        parts.push({ fileData: { mimeType: fd.mimeType, fileUri: fd.uri } });
      });

      let resultJson = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = UrlFetchApp.fetch(generateUrl, {
            method:      'post',
            contentType: 'application/json',
            payload:     JSON.stringify({
              contents: [{ parts: parts }],
              generationConfig: { temperature: 0.1 },
            }),
            muteHttpExceptions: true,
          });

          const status = res.getResponseCode();
          const body   = res.getContentText();

          if (status === 200) {
            const text = JSON.parse(body).candidates?.[0]?.content?.parts?.[0]?.text || '';
            console.log(`[Gemini OK] 全書類の統合 ➔ 解析成功（応答文字数: ${text.length}）`);

            // ★ マークダウンの ```json を確実に弾く、あなたオリジナルの安全パースを完全死守！
            const match = text.match(/\{[\s\S]*\}/);
            if (match) { 
              resultJson = JSON.parse(match[0]); 
            } else {
              console.error(`[Gemini Data Error] 応答にJSON構造が含まれていません: ${text}`); 
            }
            break;
          }

          if (status === 429 || status >= 500) {
            console.warn(`[Gemini API Warning] Status ${status} / Attempt ${attempt}/3 / 混雑エラーを検知。`);
            if (attempt < 3) { 
              Utilities.sleep(5000 * Math.pow(2, attempt - 1)); // 指数バックオフ
              continue; 
            }
          }

          console.error(`[Gemini API Fatal] Status ${status}: ${body.substring(0, 300)}`);
          break;

        } catch(e) {
          console.error(`[Gemini Network Error] Attempt ${attempt} 失敗 / Message: ${e.message}`);
          if (attempt < 3) { 
            Utilities.sleep(5000 * Math.pow(2, attempt - 1)); 
            continue; 
          }
          break;
        }
      }

      return resultJson;

    } catch(e) {
      console.error(`[Gemini Fatal STEP1-2] 処理フェーズで予期せぬ例外クラッシュ: ${e.message}`);
      return null;
    } finally {
      // -------------------------------------------------------------------------
      // STEP 3: 【マナー】Googleサーバー上の一時ファイルをすべて安全に一括削除
      // -------------------------------------------------------------------------
      fileDataList.forEach(fd => {
        try {
          const deleteUrl = "https://generativelanguage.googleapis.com/v1beta/" + fd.name + "?key=" + apiKey;
          const deleteRes = UrlFetchApp.fetch(deleteUrl, { method: 'delete', muteHttpExceptions: true });
          if (deleteRes.getResponseCode() === 200) {
            console.log(`[Gemini Cleanup OK] 一時ファイルを完全消去しました: ${fd.name} (${fd.filename})`);
          } else {
            console.warn(`[Gemini Cleanup Warning] 一時ファイルの消去に失敗: ${deleteRes.getContentText()}`);
          }
        } catch(e) {
          console.warn(`[Gemini Cleanup Error] 後始末フェーズで例外発生: ${e.message}`);
        }
      });
    }
  }, // 🚨 ここにカンマを打って、既存の analyze と新規の embed を美しく並列化！

  // =======================================================================
  // ★ ここから embed メソッド（テキストの超高速ベクトル変換用）
  // =======================================================================
  /**
   * 🧠 テキストをベクトル化する（Embedding生成）
   * @param {string} apiKey     - Gemini API キー
   * @param {string} embedModel - ベクトル化用モデル名（Configから調達）
   * @param {string} text       - ベクトル化したいクリーンな文章
   * @returns {number[]|null}  1024次元のベクトル配列 or 失敗時null
   */
  /**
   * @param {string} apiKey
   * @param {string} embedModel
   * @param {string} text
   * @param {number} [dimension] - 出力次元数を明示固定する（省略時はモデルの既定次元）
   */
  embed(apiKey, embedModel, text, dimension) {
    if (!text) return null;
    
    // 💡 テキストデータなのでファイルのアップロードは不要。直接エンドポイントへPOSTするだけ
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + embedModel + ":embedContent?key=" + apiKey;
    const payload = {
      model: `models/${embedModel}`,
      content: { parts: [{ text: text }] },
    };
    // 【次元数の明示固定】指定が無ければモデルの既定値に流されるため、呼び出し側は
    // 必ずConfig.GEMINI_EMBED_DIMENSIONを渡すこと。次元が変動すると保存済みベクトルと
    // 比較不能になり、検索が静かに機能しなくなる。
    if (dimension) payload.outputDimensionality = dimension;

    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      const json = JSON.parse(res.getContentText());
      if (json.error) {
        console.error(`[Gemini Embed Error] ${json.error.message}`);
        return null;
      }
      return json.embedding.values; // 1024次元の純粋な数字の配列を返す
    } catch(e) {
      console.error(`[Gemini Embed Network Error] ${e.message}`);
      return null;
    }
  }
};