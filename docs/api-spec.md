# Claris API 仕様書

更新日: 2026-05-19  
対象: `Claris_app/server.mjs` と将来同期 API

この文書は Claris の標準 API 入口である。現時点の `server.mjs` は静的配信と確認 API のみを担当し、データ書き込みや同期は行わない。

## 1. 現在実装済み API

### GET /api/health

ローカル開発サーバーの起動確認。

レスポンス例:

```json
{
  "ok": true,
  "app": "Claris",
  "mode": "local-dev",
  "startedAt": "2026-05-19T00:00:00.000Z"
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

この API は予定状態の表示用であり、同期やバックアップを実行しない。

## 2. 将来 API の基本方針

- API は静的 PWA を壊さず、必要になった段階で追加する。
- 初期段階では IndexedDB を正とし、サーバーはバックアップ・同期先として扱う。
- メモ AI 整理は当面サーバー API を使わず、保存済みメモの本文と文字起こしから手動貼り付け用プロンプトをコピーし、外部 LLM の JSON 回答をメモ画面で検証して取り込む。
- 将来 API 化する場合も、クライアント側の `memo_ai_summary` JSON 形式、`agendas` / `policies` / `actions` 配列、メモ ID 検証を維持する。
- 同期前には必ずローカルバックアップを作成する。
- オフライン時は API 呼び出しに失敗してもローカル保存を優先する。
- 認証方式は初期 API 仕様では固定しない。
- Express / SQLite / Drizzle ORM を前提にしすぎない。
- ローカルデータには API 実装前から `deviceId`、`version`、`updatedAt`、`deletedAt`、`syncStatus` を保持する。

## 3. 最小同期 API 案

### GET /api/sync/pull

サーバー側の最新データ、または指定日時以降の差分を取得する。

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

## 4. 最小バックアップ API 案

標準4ファイルでは、バックアップ API は次の単数形パスを標準案とする。過去資料や旧たたき台に複数形パスが残っている場合も、今後の新規設計ではこの案を優先する。

### POST /api/backup

バックアップを作成する。

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

## 5. 競合レスポンス案

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

## 6. 認証

初期 API 案では認証方式を固定しない。

将来候補:

- passkey
- ローカル端末識別
- 簡易 PIN
- セッション管理

passkey は現時点では必須にしない。同期前バックアップとデータ消失防止を優先する。

## 7. 未確定事項

- 差分同期の細かいデータ形式。
- バックアップ保存先。
- サーバー側で `local-only` を初回同期済みにするタイミング。
- `deletedItems` を正式な tombstone コレクションへ分離するかどうか。
- サーバー側永続化をいつ導入するか。
