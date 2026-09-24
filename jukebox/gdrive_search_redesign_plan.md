# jukebox: Google Drive MP3 パス階層検索 & キャッシュ再設計 方針書

## 1. 背景と目的

### 現状の課題
現在の `jukebox` では、MP3 ファイルを Google Drive から探す際に `fileName`（例: `song.mp3`）単体でドライブ全体を検索しています。
そのため以下の課題が発生していました：
- **誤検索リスク**: 複数年度や別コンピレーションアルバムに同名のファイルが存在した場合、誤ったファイルをヒット・キャッシュしてしまう。
- **検索パフォーマンス・タイムアウト**: 全ドライブ検索のためタイムアウト（15秒）が発生しやすい。

### 再設計の目的
`track.mp3_file` に含まれるパス階層情報（例: `/music/2025/2025-075.Toolroom Amsterdam 2025/mp3/song.mp3`）を活用し、**親フォルダ ID を段階的に特定・キャッシュ**することで、次回以降 **100% 正確 ＆ 0ms / 1 クエリでピンポイント検索・再生** できる仕組みへ刷新します。

---

## 2. パス解析と Google Drive 階層構造

### パスの共通フォーマット
```text
/music/{YEAR}/{FOLDER_NAME}/mp3/{FILENAME}
```

- **`YEAR`**: `2024`, `2025`, `2026` などの年度（`startDiscovery` 時に年度フォルダ ID を取得済み）
- **`FOLDER_NAME`**: `tracks`（標準）または `2025-075.Toolroom Amsterdam 2025`（アルバム名）
- **`mp3`**: MP3 音声ファイルが直接格納されているフォルダ名
- **`FILENAME`**: 実際の MP3 ファイル名

### キャッシュキーの定義
- **親フォルダ キャッシュキー**: `"{YEAR}/{FOLDER_NAME}/mp3"` （例: `"2025/2025-075.Toolroom Amsterdam 2025/mp3"`）
- **ファイル キャッシュキー**: パス全体を小文字化・正規化した文字列（例: `"music/2025/tracks/mp3/song.mp3"`）

---

## 3. Google Drive API 検索 ＆ キャッシュ設計

### A. 検索フロー

```text
曲の再生 / 先読み開始
 ├── 1. 新パス形式キャッシュ (pathFileIds) を検索
 │    └── ヒット時 ➔ 即座に File ID を返却 (0ms / 100% 正確)
 │
 └── 2. キャッシュ未ヒット時
      ├── 親フォルダ ID (folderIds) がキャッシュに存在するか確認
      │    ├── 存在する ➔ その mp3FolderId を親にしてファイル検索 (1 クエリ)
      │    └── 存在しない ➔ [初回] 年度 ID からアルバム/mp3 フォルダ ID を検索・特定し保存 (1〜2 クエリ)
      │
      └── 正解の File ID を取得後、新パス形式キャッシュ (pathFileIds) に保存
```

### B. クエリ仕様
- **必ず完全一致演算子 `=` を使用**（`contains` は同名 Mix 違い誤検知防止のため使用不可）。
- **シングルクォートのエスケープ必須**: `replace(/'/g, "\\'")`
- **クエリ例（親フォルダ ID 判明時）**:
  ```javascript
  q = `'${mp3FolderId}' in parents and name = '${safeFileName}' and trashed = false`
  ```

---

## 4. IndexedDB スキーマ ＆ マイグレーション方針

### スキーマ変更 (`dbVersion: 6`)
1. **新規オブジェクトストア `pathFileIds`**
   - Key: `path`（正規化済みフルパス）
   - Value: `{ path, id, updatedAt }`
2. **新規オブジェクトストア `folderIds`**
   - Key: `folderKey`（例: `"2025/2025-075.../mp3"`）
   - Value: `{ folderKey, id, updatedAt }`
3. **旧ストア `fileIds`**
   - 削除せず残すが、**旧ストアからの自動昇格（無検証コピー）は行わない**。
   - 新ストア `pathFileIds` は、100% 検証済みの正しい検索結果のみでクリーンに構築する。

---

## 5. エッジケース ＆ 懸念点への対策一覧

| 懸念点 | リスク | 対応策 |
| :--- | :--- | :--- |
| **1. シングルクォート `'`** | API 構文エラー (`Invalid query`) | クエリ埋め込み前に `replace(/'/g, "\\'")` を徹底 |
| **2. パスの表記揺れ** | キャッシュ未ヒット | 先頭 `/` 除去 ＋ 小文字化を行う `normalizePath()` を通す |
| **3. Unicode 正規化 (NFC)** | 濁点/アクセント文字（`é`, `æ`等）の検索不一致 | ファイル名・パスに `str.normalize('NFC')` を適用 |
| **4. ドライブ側のフォルダ変更/削除** | 検索不能・古い ID 参照 | 検索 0 件 / 404 時に該当 `folderId` キャッシュを削除し再検索 |
| **5. 同名曲の Mix 違い** | 意図しない Mix の再生 | クエリは完全一致 `=` を徹底（`contains` 不可） |
| **6. Prefetch との重複検索** | 無駄な API 通信 | リクエスト重複防止（In-flight Promise Deduplication） |
| **7. レート制限 (`429`)** | 一時的アクセスブロック | 指数バックオフ（1s ➔ 2s ➔ 4s）による短時間リトライ |
| **8. アカウント切り替え (`403`)** | 別アカウント ID 参照エラー | `403` 検出時にキャッシュ削除 ＆ 再ログイン時対応 |
| **9. iOS / Safari 例外** | IndexedDB エラーで再生停止 | DB 操作を全 `try-catch` し、DB 失敗時も API 検索へ倒して再生継続 |

---

## 6. 実装対象ファイル

- [`jukebox/jukebox.js`](file:///home/koichi/development/Tracksource2Juno/jukebox/jukebox.js)
  - `JukeboxDB` のスキーマ更新と `getFolderId` / `setFolderId` / `getPathFileId` / `setPathFileId` 追加
  - `googleDriveSearchFetchByPath(track, signal)` の新設
  - `playSong` および先読み（`prefetchNextTrack`）部分の呼び出し差し替え

---
*本書は別セッションでのスムーズな実装再開のための設計仕様書です。*
