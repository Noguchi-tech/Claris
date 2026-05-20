# Claris 開発ルール

更新日: 2026-05-20  
対象: `Claris_app`

この文書は、今後 Claris を Codex で開発するときの標準ルールである。

## 1. 基本方針

- 現行実装を壊さない。
- 現在動いている静的 PWA 構造を優先する。
- ローカル保存、オフライン利用、IndexedDB、Service Worker、JSON バックアップ導線を維持する。
- UI の開閉記号は、表示を `+`、非表示を `-` に統一する。
- 大きな変更の前には、目的、影響範囲、差分方針を説明する。
- 実装変更で要件や仕様が変わる場合は、docs も同じタイミングで更新する。
- 標準入口は `requirements.md`、`architecture.md`、`api-spec.md`、`development-rules.md` とする。

## 2. 禁止事項

- 同期前バックアップなしで同期処理を実装しない。
- ユーザーデータを自動で完全削除しない。
- オフライン時に保存できない仕様にしない。
- 現行 PWA 構造を不要に大きく変更しない。
- React / TypeScript / Vite へ勝手に移行しない。
- Express / SQLite / Drizzle ORM を前提にしすぎない。
- Firebase / Supabase / PostgreSQL を導入しない。
- 依存関係を勝手に追加しない。
- 実装前に docs と実装方針を矛盾させない。
- PWA 本体に秘密情報や認証トークンを置かない。
- 設定画面に外部 LLM エンドポイントや連携名を復活させない。
- PWA 本体から外部 LLM へ直接 POST する処理を追加しない。

## 3. PWA に関するルール

- iPhone のホーム画面 PWA としての動作を壊さない。
- `manifest.webmanifest`、`sw.js`、アイコン、キャッシュ対象の変更は慎重に行う。
- 静的アセットを変更した場合は、必要に応じて Service Worker のキャッシュ名や参照バージョンを更新する。
- `index.html`、`styles.css`、`app.js` を分割・移行する場合は、理由と移行手順を docs に残す。
- アプリ本体ファイルは同期対象データに含めない。

## 4. データに関するルール

- IndexedDB の既存データ構造を不用意に破壊しない。
- 保存済みデータの互換性を保つため、内部キーの変更は原則避ける。
- 既存の `createdAt`、`updatedAt` を維持する。
- タスク関連メモの開閉 UI は保存データ構造に含めない。閉じた状態でも既存の `task.memoIds` とメモ同期処理が失われないよう、保存用 input は維持する。
- 優先度の色変更では `P1` / `P2` / `P3` / `SUB` の保存値、意味、順序を変更しない。
- 同期用メタ情報は `deletedAt`、`syncStatus`、`deviceId`、`version` を標準とする。
- 添付ファイルは `attachments[]` に保存し、`ownerType`、`ownerId`、`fileName`、`mimeType`、`size`、`createdAt`、`updatedAt`、`deletedAt`、`syncStatus`、`deviceId`、`version`、`dataUrl` または `blob` を保持する。
- 添付ファイルの削除は原則として論理削除に寄せ、ユーザーデータを自動で完全削除しない。
- 既存データに同期用メタ情報がない場合は、起動時正規化で `version: 1`、`deletedAt: null`、`syncStatus: "local-only"`、現端末の `deviceId`、不足している `updatedAt` を補完する。
- 新規作成、編集、削除、復元で変更されたデータは `syncStatus: "pending"` とし、対象データの `version` を `+1` する。新規作成時は `version: 1` とする。
- 現行 `deletedItems` と将来の論理削除設計を混同しない。
- 現行 `deletedItems` は復元機能のため維持し、削除時は退避レコードと退避された元データの両方に `deletedAt` を付与する。
- 完全削除機能を扱う場合は、同期と復元への影響を明記する。

## 5. バックアップに関するルール

- 同期処理の前には必ず `before-sync` バックアップを作成する。
- master JSON は `Claris_app/data/claris-master-YYYY-MM-DD.json` に配置する。起動時上書きに使う場合は `fullSync: true` と一意の `importId` を含め、反映前の `before-sync` バックアップ仕様を変えない。
- 復元処理の前には必ず `before-restore` バックアップを作成する。
- 同期メタ情報を既存 state へ補完する前には、可能な限り `before-metadata-migration` バックアップを作成する。
- バックアップには state 全体、件数、schemaVersion、作成理由、作成日時を含める。
- 初期案では複数世代、最大10件程度を保持する。
- 手動バックアップは自動削除から除外できる余地を残す。
- バックアップ作成に失敗した場合、同期や復元を進めない。

## 6. 同期に関するルール

- 初期同期はローカル優先とする。
- 既存データの `local-only` は、同期 API 実装前の履歴データを示す。通常編集で発生した未送信変更は `pending` として扱う。
- IndexedDB を正とし、サーバーはバックアップ・同期先として扱う。
- オフライン時はローカル保存を優先する。
- 同期失敗時にユーザーの編集内容を消してはいけない。
- `updatedAt` が新しいデータを優先するが、判断が難しい場合は `conflict` として残す。
- 競合時はローカル側データ、サーバー側データ、競合発生日時、理由、採用データを保持できるようにする。
- 初期実装では競合解決 UI を後回しにしてよいが、データ構造は先に用意する。

## 7. API に関するルール

- 現行 `server.mjs` は静的配信と確認 API のみとする。
- メモ AI 整理は、当面サーバー API や Claris 内 AI 処理を追加せず、AI 整理用 `.json` ファイル共有と、外部 LLM の JSON 回答を手動貼り付けまたは `.json` ファイル選択で検証する導線に留める。
- `memo_ai_summary` 取り込みでは `clarisImportType`、`version`、`memoId`、`agendas` / `policies` / `actions` の文字列配列を必ず検証し、検証失敗時は保存データを変更しない。
- AI 整理結果の反映では内部キー `agenda`、`decisions`、`nextActions` を維持し、表示上の項目記号 `■`、`●`、`・` と必要な句点補完だけを行う。
- 同期 API を追加する前に `api-spec.md` を更新する。
- 最小 API 案は `GET /api/sync/pull`、`POST /api/sync/push`、`POST /api/backup`、`GET /api/backup`、`POST /api/restore` とする。
- API 実装時も Express / SQLite / Drizzle ORM を最初から前提にしない。
- 認証方式は初期同期設計では固定しない。

## 8. docs 更新ルール

- 日付付き docs は詳細資料として残してよい。
- 今後も有効な内容は標準4ファイルへ統合する。
- 古い内容や現在方針と矛盾する内容は、過去資料として明記するか、標準4ファイルには採用しない。
- 現時点の標準入口は `requirements.md`、`architecture.md`、`api-spec.md`、`development-rules.md` の4ファイルである。日付付き docs は詳細資料、過去資料、引き継ぎ資料として参照し、仕様判断では標準4ファイルを優先する。
- 実装と docs に食い違いがある場合は、先に差分、矛盾点、判断が必要な点を一覧化する。

## 9. 次回実装前チェック

同期実装へ進む前に、最低限次を確認する。

1. バックアップ保存場所を決める。
2. `deviceId` が `settings.deviceId` に保存され、各同期対象データへ反映されていることを確認する。
3. 同期対象コレクションを確定する。
4. `deletedItems` を tombstone として使い続けるか、専用コレクションへ分けるかを決める。
5. `local-only` を初回同期でどう扱うかを決める。
6. API を `server.mjs` へ追加するか、別サーバーへ分けるか決める。
7. 実装後も静的 PWA とオフライン利用が壊れていないことを確認する。

## 10. リポジトリとミラー運用

- 正式な開発ディレクトリは `/Users/noguchi_rl99/Development/Claris/Claris_app` とする。このディレクトリの `main` ブランチと `origin` remote を GitHub Pages 反映対象の source of truth として扱う。
- `app.js`、`styles.css`、`index.html`、`manifest.webmanifest`、`sw.js`、`docs/` を別ディレクトリへ手動コピーしてミラーファイルを増やさない。
- `/Users/noguchi_rl99/Documents/Codex/Claris`、`/Users/noguchi_rl99/Documents/GitHub/Claris`、iCloud Drive 配下、過去の `backups/` 配下は直接編集対象にしない。必要な内容がある場合は、本体リポジトリへ差分として取り込む。
- GitHub clone は単一の source of truth に寄せる。複数 clone が見つかった場合は、削除前に remote、branch、最新 commit、主要ファイルのハッシュ、未コミット差分を確認し、本体と削除候補を明確に分けて報告する。
- 配布用コピーやバックアップを作る必要がある場合は、用途、作成日、削除予定または保持理由を docs か作業メモに残し、実装対象と誤認しない名前にする。
- `.DS_Store` はコミットしない。見つけた場合は `.gitignore` と Git 追跡状態を確認する。
