# Claris API 仕様書

更新日: 2026-05-22  
対象: `Claris_app/server.mjs` と将来同期 API

この文書は Claris の標準 API 入口である。現時点の `server.mjs` は静的配信、確認 API、PCバックアップJSON API を担当する。複数端末の常時差分同期や共同編集は行わない。

## 1. 現在実装済み API

### GET /api/health

ローカル開発サーバーの起動確認。

レスポンス例:

```json
{
  "ok": true,
  "app": "Claris",
  "mode": "local-pc-backup",
  "startedAt": "2026-05-22T00:00:00.000Z",
  "backupDir": "C:\\Users\\...\\Claris_app\\data\\backups"
}
```

### GET /api/capabilities

将来拡張予定の機能状態を返す。

主な項目:

- 常時同期
- AI秘書化
- 音声常駐
- Apple Watch
- バックグラウンド自動処理

この API は機能状態の表示用である。`pcBackup` と `restoreFromPcBackup` は利用可能、常時同期、AI秘書化、常駐音声、Apple Watch、完全バックグラウンド自動処理は予定状態として返す。

## 2. 将来 API の基本方針

- API は静的 PWA を壊さず、必要になった段階で追加する。
- 初期段階では IndexedDB を正とし、サーバーはバックアップ・同期先として扱う。
- メモ AI 整理は当面サーバー API を使わず、保存済みメモの本文と文字起こしを含む `.json` ファイルを共有し、外部 LLM の JSON 回答をメモ画面で検証して取り込む。Claris 内では AI 処理を実行せず、PWA 本体から外部 LLM へ直接 POST しない。
- 将来 API 化する場合も、クライアント側の `memo_ai_summary` JSON 形式、`agendas` / `policies` / `actions` 配列、メモ ID 検証を維持する。
- 同期前には必ずローカルバックアップを作成する。
- オフライン時は API 呼び出しに失敗してもローカル保存を優先する。
- 認証方式は初期 API 仕様では固定しない。
- Express / SQLite / Drizzle ORM を前提にしすぎない。
- ローカルデータには API 実装前から `deviceId`、`version`、`updatedAt`、`deletedAt`、`syncStatus` を保持する。
- 添付ファイルも将来同期対象として扱い、タスク、メモ、運営情報とは `ownerType` と `ownerId` で紐づける。

## 3. メモ AI 整理 JSON 形式

### 3.1 AI 整理用エクスポート JSON

Claris から外部 LLM アプリへ渡すファイルは、次の情報を含む `.json` とする。ファイル名は `ClarisにインポートするAI整理用_YYYY-MM-DD_メモタイトル.json` のように、Claris へ戻すための AI 整理用データだと分かる名前にする。

```json
{
  "clarisExportType": "memo_ai_summary_request",
  "version": 1,
  "memoId": "対象メモID",
  "title": "対象メモタイトル",
  "body": "本文",
  "transcript": "文字起こし",
  "createdAt": "2026-05-20T00:00:00.000Z",
  "updatedAt": "2026-05-20T00:00:00.000Z",
  "instruction": "返答は必ず expectedImportFormat と同じ形式の .json ファイルだけにしてください。",
  "expectedImportFormat": {
    "clarisImportType": "memo_ai_summary",
    "version": 1,
    "memoId": "対象メモID",
    "title": "対象メモタイトル",
    "agendas": [],
    "policies": [],
    "actions": []
  }
}
```

`instruction` では、外部 LLM の返答を必ず `.json` ファイルとし、説明文、補足文、Markdown、コードブロックを含めないことを明記する。`agendas` / `policies` / `actions` は文字列配列のみ許可する。

### 3.2 AI 整理結果インポート JSON

外部 LLM から手動で貼り付ける JSON は次の形式だけを許可する。

```json
{
  "clarisImportType": "memo_ai_summary",
  "version": 1,
  "memoId": "対象メモID",
  "title": "対象メモタイトル",
  "agendas": [],
  "policies": [],
  "actions": []
}
```

検証仕様:

- `clarisImportType` は `"memo_ai_summary"` のみ許可する。
- `version` は `1` のみ許可する。
- `memoId` は現在開いているメモ ID と一致必須とする。
- `agendas`、`policies`、`actions` は文字列配列のみ許可する。
- `title` は任意であり、取り込み必須条件にしない。
- JSON の前後に説明文やコードブロック記号が混ざる場合は、安全に単一 JSON オブジェクトを抽出できる場合だけ解析する。曖昧な場合はエラーにする。
- `.json` ファイル選択時は FileReader で読み込んだ内容を同じ検証経路へ渡す。前後の空白と BOM は除去してよいが、スマートクォートは JSON として無効な入力として扱う。
- 不正 JSON、別メモ ID、配列でない値、文字列以外の配列要素では保存データを変更しない。

反映先:

- `agendas` -> 内部キー `agenda`
- `policies` -> 内部キー `decisions`
- `actions` -> 内部キー `nextActions`

表示ラベルは「議題」「方針」「行動」に統一する。反映時は議題の各行に `■`、方針の各行に `●`、行動の各行に `・` を付ける。文章は文末に `。` がなければ補い、単語だけの項目には無理に句点を付けない。既存内容がある場合は上書き確認を出し、取り込み成功時は通常のメモ保存と同じ経路で `updatedAt` と同期メタ情報を更新する。

## 4. 最小同期 API 案

### GET /api/sync/pull

サーバー側の最新データ、または指定日時以降の差分を取得する。

2026-05-22 現行実装では、PC側 `data/backups/` の最新バックアップを返す最小実装とする。レスポンスは `{ ok, backup, state }` で、`state` は最新バックアップの `payloadJson` を復元したオブジェクトである。細かい差分配信、競合一覧、複数端末のマージは未実装。

クエリ案:

- `since`: 最終同期日時。省略時はサーバー側スナップショットを返す。
- `deviceId`: 端末識別子。

レスポンス案:

```json
{
  "ok": true,
  "serverTime": "2026-05-19T00:00:00.000Z",
  "lastSyncAt": "2026-05-19T00:00:00.000Z",
  "schemaVersion": 2,
  "changes": {
    "tasks": [],
    "memos": [],
    "policies": [],
    "attachments": [],
    "departments": [],
    "deletedItems": []
  }
}
```

注意:

- pull 前にもローカル側で `before-sync` バックアップを作成する。
- サーバーデータでローカルデータを即時上書きしない。
- 判断が難しい差分は `conflict` として残す。
- `deletedItems` は当面、`deletedAt` を持つ削除トゥームストーンとして扱う。

### POST /api/sync/push

ローカル側の未同期変更をサーバーへ送信する。

2026-05-22 現行実装では、`POST /api/backup` と同じ保存処理を使い、受け取った `backup` または `state` を `scheduled` 相当のPCバックアップJSONとして保存する。差分マージではなく、最後にPCへ送れたスナップショットを復元元として残す。

リクエスト案:

```json
{
  "deviceId": "iphone-local",
  "clientTime": "2026-05-19T00:00:00.000Z",
  "lastSyncAt": "2026-05-18T00:00:00.000Z",
  "schemaVersion": 2,
  "changes": {
    "tasks": [],
    "memos": [],
    "policies": [],
    "attachments": [],
    "departments": [],
    "deletedItems": []
  }
}
```

レスポンス案:

```json
{
  "ok": true,
  "serverTime": "2026-05-19T00:00:00.000Z",
  "acceptedIds": [],
  "conflicts": []
}
```

注意:

- push 前に `before-sync` バックアップを作成する。
- 成功したデータは `syncStatus: "synced"` にする。
- 失敗したデータは `syncStatus: "pending"` のまま残す。
- 初回同期時は `local-only` もアップロード候補に含めるが、通常の差分送信では `pending` を優先する。

同期対象レコードの最小形:

```json
{
  "id": "task_xxx",
  "createdAt": "2026-05-19T00:00:00.000Z",
  "updatedAt": "2026-05-19T00:00:00.000Z",
  "deletedAt": null,
  "syncStatus": "pending",
  "deviceId": "00000000-0000-4000-8000-000000000000",
  "version": 1
}
```

添付レコードの最小形:

```json
{
  "id": "attachment_xxx",
  "ownerType": "task",
  "ownerId": "task_xxx",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 123456,
  "createdAt": "2026-05-20T00:00:00.000Z",
  "updatedAt": "2026-05-20T00:00:00.000Z",
  "deletedAt": null,
  "syncStatus": "pending",
  "deviceId": "00000000-0000-4000-8000-000000000000",
  "version": 1,
  "dataUrl": "data:image/jpeg;base64,..."
}
```

`ownerType` は `"task"`、`"memo"`、`"policy"` のいずれかとする。初期ローカル実装では `dataUrl` を優先するが、将来 API 化する時は `blob` または別アップロード方式へ置き換えられるよう、メタ情報と本体データを分離して扱える設計にする。削除は `deletedAt` 付きの論理削除を基本とし、同期判断が難しい場合に自動で完全削除しない。

削除トゥームストーンの最小形:

```json
{
  "id": "deleted_xxx",
  "kind": "tasks",
  "title": "削除済みタスク",
  "deletedAt": "2026-05-19T00:00:00.000Z",
  "updatedAt": "2026-05-19T00:00:00.000Z",
  "syncStatus": "pending",
  "deviceId": "00000000-0000-4000-8000-000000000000",
  "version": 2,
  "item": {
    "id": "task_xxx",
    "deletedAt": "2026-05-19T00:00:00.000Z",
    "syncStatus": "pending",
    "version": 2
  }
}
```

## 5. 最小バックアップ API 案

標準4ファイルでは、バックアップ API は次の単数形パスを標準案とする。過去資料や旧たたき台に複数形パスが残っている場合も、今後の新規設計ではこの案を優先する。

### POST /api/backup

バックアップを作成する。

2026-05-22 現行実装では、リクエスト `{ backup, state, requestedAt }` を受け取り、`data/backups/claris-backup-YYYYMMDD-HHMMSS-<id>.json` に保存する。`payloadJson` がない場合は `state` から生成する。レスポンスは `{ ok, backup, backups }`。

リクエスト案:

```json
{
  "deviceId": "iphone-local",
  "reason": "before-sync",
  "schemaVersion": 2,
  "createdAt": "2026-05-19T00:00:00.000Z",
  "counts": {
    "tasks": 0,
    "memos": 0,
    "policies": 0,
    "departments": 0,
    "deletedItems": 0
  },
  "state": {}
}
```

レスポンス案:

```json
{
  "ok": true,
  "backupId": "backup_20260519_000000",
  "createdAt": "2026-05-19T00:00:00.000Z"
}
```

### GET /api/backup

復元可能なバックアップ一覧を取得する。

2026-05-22 現行実装では、`data/backups/` のJSONを読み、`id`、`backupId`、`type`、`createdAt`、`appVersion`、`schemaVersion`、`deviceId`、`counts`、`fileName` を返す。`index.json` も更新するが、バックアップ本体は静的配信しない。

レスポンス案:

```json
{
  "ok": true,
  "backups": [
    {
      "backupId": "backup_20260519_000000",
      "createdAt": "2026-05-19T00:00:00.000Z",
      "reason": "before-sync",
      "schemaVersion": 2,
      "counts": {
        "tasks": 0,
        "memos": 0,
        "policies": 0
      }
    }
  ]
}
```

注意:

- 初期案では最大10世代程度を返す。
- 手動バックアップを自動削除対象から外せる余地を残す。
- メタ情報移行前の自動バックアップは `before-metadata-migration` として保存する。

### POST /api/restore

指定バックアップから復元する。

2026-05-22 現行実装では、リクエスト `{ backupId, restoreRequestedAt }` を受け取り、対応するバックアップの `{ ok, backup, state, restoredAt }` を返す。PWA側は復元前に `before-restore` ローカルバックアップを作成してから `state` を取り込む。

リクエスト案:

```json
{
  "deviceId": "iphone-local",
  "backupId": "backup_20260519_000000",
  "restoreRequestedAt": "2026-05-19T00:00:00.000Z"
}
```

レスポンス案:

```json
{
  "ok": true,
  "backupId": "backup_20260519_000000",
  "restoredAt": "2026-05-19T00:00:00.000Z",
  "state": {}
}
```

注意:

- restore 前に、現在データを `before-restore` バックアップとして保存する。
- 復元したデータは、次回同期でサーバーへ反映できる状態にする。

## 6. 競合レスポンス案

競合が発生した場合は、自動で完全削除せず、次の形式で返す。

```json
{
  "id": "task_xxx",
  "collection": "tasks",
  "reason": "updated_at_conflict",
  "occurredAt": "2026-05-19T00:00:00.000Z",
  "local": {},
  "server": {},
  "selected": null
}
```

初期実装では競合解決 UI は後回しでもよい。ただし API とデータ構造は conflict を保持できる形にする。

## 7. 認証

初期 API 案では認証方式を固定しない。

将来候補:

- passkey
- ローカル端末識別
- 簡易 PIN
- セッション管理

passkey は現時点では必須にしない。同期前バックアップとデータ消失防止を優先する。

## 8. 未確定事項

- 差分同期の細かいデータ形式。
- バックアップ保存先。
- サーバー側で `local-only` を初回同期済みにするタイミング。
- `deletedItems` を正式な tombstone コレクションへ分離するかどうか。
- サーバー側永続化をいつ導入するか。
