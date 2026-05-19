# Claris アーキテクチャ設計書

更新日: 2026-05-19  
対象: `Claris_app`

この文書は Claris の標準設計入口である。詳細な既存設計は `Claris_design_2026_05_18.md` と `Claris_specification_2026_05_18.md` を参照する。

## 1. 現在の構造

- `index.html`: PWA メタ情報、アプリ外枠、下部ナビ、ダイアログの配置。
- `styles.css`: iPhone 向けレイアウト、ナビ、フォーム、カレンダー、各種 UI。
- `app.js`: 状態管理、IndexedDB、描画、イベント処理、録音、文字起こし、インポート/エクスポート。
- `sw.js`: Service Worker とオフラインキャッシュ。
- `manifest.webmanifest`: PWA manifest。
- `icons/`: PWA とアプリ内で使うアイコン。
- `data/`: 初期投入や手動同期に使う JSON データ。
- `server.mjs`: Node.js 標準 `http` によるローカル静的配信と確認 API。
- `docs/`: 要件、設計、API 仕様、開発ルール、詳細資料。

## 2. 現在使われている技術

- HTML
- CSS
- JavaScript
- PWA
- Service Worker
- IndexedDB
- Node.js 標準 HTTP サーバー
- JSON データファイル

## 3. 現時点では使わないもの

- React
- TypeScript
- Vite
- Express
- SQLite
- Drizzle ORM
- Firebase
- Supabase
- PostgreSQL
- `package.json` による npm プロジェクト構成
- `src/` / `public/` / `server/` ディレクトリ構成

これらは必要性、移行範囲、既存 PWA への影響が明確になるまで導入しない。

## 4. 現行データ構造

IndexedDB `claris-local-db` の `app` ストアに `state` を保存し、`backups` ストアに同期・復元・メタ情報移行前のローカルバックアップを保存する。IndexedDB の DB バージョンは `2`、state の `schemaVersion` は同期メタ情報追加後 `2` とする。

主な state:

- `schemaVersion`
- `createdAt`
- `updatedAt`
- `settings`
- `ui`
- `tasks`
- `memos`
- `policies`
- `departments`
- `projects`
- `deletedItems`

同期メタ情報追加後の同期対象レコード:

- `tasks[]`
- `memos[]`
- `policies[]`
- `departments[]`
- `deletedItems[]`

各レコードには `updatedAt`、`deletedAt`、`syncStatus`、`deviceId`、`version` を持たせる。既存データに不足がある場合は起動時の正規化で補完し、補完前に `before-metadata-migration` バックアップを `backups` ストアへ保存する。

現行実装では、`data/claris-master-2026-05-18.json` の `fullSync: true` を起動時に確認し、未適用の `importId` であれば IndexedDB の state へ上書き反映する。反映前には `backups` ストアへ `before-sync` バックアップを保存する。

`lastFullSyncBackup` または `lastTaskImportBackup` は旧来の一時退避であり、正式な世代バックアップとして扱わない。

## 5. 同期設計の基本方針

初期段階ではローカル優先の同期方式とする。

- IndexedDB を正とする。
- サーバーはバックアップ・同期先として扱う。
- オフライン時はローカルに保存する。
- オンライン復帰後に未同期データを送信する。
- 同期失敗時にローカル編集内容を消さない。
- 同期処理の前には必ずバックアップを作成する。

## 6. 同期対象コレクション

初期同期対象:

- `tasks`
- `memos`
- `policies`
- `departments`
- `settings.policyTypes`
- `deletedItems` と、退避された元データに付与される `deletedAt`

同期対象外:

- Service Worker のキャッシュ
- `index.html`、`styles.css`、`app.js` などのアプリ本体
- `icons/`
- 表示中タブ、開いているダイアログなどの瞬間的 UI 状態

`settings` は全体を無条件同期すると端末固有設定を巻き込みやすい。初期段階では分類、種別、同期に必要な項目に限定する。

## 7. 同期用データメタ情報

将来の同期対象データには次を持たせる。

- `id`: データ識別子。
- `createdAt`: 作成日時。
- `updatedAt`: 最終更新日時。
- `deletedAt`: 論理削除日時。未削除なら `null`。
- `syncStatus`: `local-only` / `pending` / `synced` / `conflict`。
- `deviceId`: 変更元端末。
- `version`: データ単位の更新番号。

`deviceId` は初回起動時に UUID 相当で生成し、`settings.deviceId` に保存する。以後は同じ値を再利用し、同期対象レコードの変更元端末として保持する。

既存データには `version: 1`、不足している `updatedAt` は補完時点、`deletedAt: null`、`syncStatus: "local-only"`、現端末の `deviceId` を補完する。既存データを `local-only` にする理由は、サーバー同期 API 未実装の段階で全件を `pending` にすると、将来の初回同期で「移行された履歴」と「明示的な未送信変更」の区別がつきにくくなるためである。

新規作成、編集、削除、復元で変更されたレコードは `syncStatus: "pending"` とし、`updatedAt` を現在日時へ更新し、`version` を `+1` する。新規作成時の `version` は `1` とする。

`deletedItems` は現行の復元 UI を壊さないため継続利用する。削除時はアクティブ配列から取り除き、`deletedItems[]` の退避レコードと退避された元データの両方に `deletedAt` を付与する。将来の同期では、この退避レコードを削除トゥームストーンとして扱い、復元時は元データの `deletedAt` を `null` に戻して `pending` とする。

## 8. バックアップ設計

同期前バックアップは、IndexedDB の state 全体を JSON スナップショットとして保存する。録音 Blob は既存エクスポートと同じく `blobOmitted: true` として省略する。

バックアップ単位:

- `id`
- `type`: `before-sync` / `before-restore` / `before-metadata-migration`
- `createdAt`
- `appVersion`
- `schemaVersion`
- `deviceId`
- `counts`
- `payloadJson`

保持方針:

- 初期実装は最大10件。
- 古い自動バックアップは削除してよい。
- 手動バックアップを自動削除対象から外せる設計にする。

復元時:

1. 現在 state を `before-restore` バックアップとして保存する。
2. 選択バックアップの state を復元する。
3. 復元日時を記録する。
4. 復元されたデータを次回同期でサーバーへ反映できるよう `syncStatus` を調整する。

## 9. 初期同期フロー

アプリ起動時の将来フロー:

1. IndexedDB を開く。
2. ローカルデータの有無を確認する。
3. サーバーデータの有無を確認する。
4. 最終同期日時を確認する。
5. 同期前バックアップを作成する。
6. 必要に応じて差分同期する。
7. 競合があれば `conflict` として残す。
8. 画面を描画する。

現行起動フローは `applyBundledTaskImport()` による同梱 JSON 反映までであり、サーバー同期はまだ実装しない。

## 10. 保存時同期フロー

タスク、メモ、運営情報を保存した時の将来フロー:

1. まず IndexedDB に保存する。
2. 対象データを `pending` とする。
3. オンラインなら同期前バックアップを作成する。
4. サーバーへ push する。
5. 成功したら `synced` とする。
6. 失敗したら `pending` のまま残す。

ローカル保存を同期成否に依存させない。

## 11. 競合解決設計

当面は操作端末1台を前提とするため競合は少ない想定だが、将来の複数端末対応を考慮してルールを持つ。

基本ルール:

- `updatedAt` が新しいデータを優先する。
- 判断が難しい場合は自動で完全削除せず `conflict` として残す。
- 削除情報と編集情報が衝突した場合も、即時物理削除しない。

競合データには次を保持する。

- ローカル側データ
- サーバー側データ
- 競合発生日時
- 競合理由
- 採用されたデータ

初期実装では競合解決 UI は後回しでもよい。ただし、データ構造として conflict を保持できるようにする。

## 12. サーバー設計方針

現時点の `server.mjs` は静的配信と確認 API のみを担当する。データ書き込み、同期、復元、外部 LLM 実行、バックグラウンドジョブは行わない。

将来サーバーを追加する場合も、最初から Express / SQLite / Drizzle ORM を前提にしない。必要になった時点で、保存方式、認証、バックアップ復元、既存 PWA への影響を整理してから導入する。

## 13. docs 配置

標準入口は次の4ファイルとする。

- `docs/requirements.md`
- `docs/architecture.md`
- `docs/api-spec.md`
- `docs/development-rules.md`

日付付き docs は詳細資料、過去資料、実装履歴として残してよい。今後の仕様判断で必要な内容は標準4ファイルへ統合する。
