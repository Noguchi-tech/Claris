# Claris 仕様書

更新日: 2026-05-18  
対象: `Claris_app`

## 1. 起動仕様

- `DOMContentLoaded` で `init()` を実行する。
- `openDatabase()` で IndexedDB を開く。
- `loadState()` と `normalizeState()` で保存済み state を補正する。
- `applyBundledTaskImport()` で `data/claris-master-2026-05-18.json` を確認する。
- `applyStartupUiPolicy()` で起動タブを `today` にする。
- `render()` 後に Service Worker を登録する。

## 2. 下部タブ仕様

- タブは `calendar`、`today`、`entries` の3つ。
- `updateNavIndicator()` は対象ボタンの実測位置から `--nav-indicator-x` と `--nav-indicator-width` を更新する。
- インジケーターはナビの内側に 3px 余白を取り、外へはみ出さない。
- 今日タブの高さは他タブと同じ 56px とし、背景とアイコンで強調する。
- `.bottom-nav` は `bottom: 0` で画面下端まで覆い、safe area を padding に含める。

## 3. 今日タブ仕様

- `renderTodayPriorityFocus()` で最優先、2次優先、3次優先を専用スロット表示する。
- 各スロットは先頭タスク、DL、担当者、追加件数を表示する。
- 空きスロットは `add-task-slot` でその優先度のタスク追加フォームを開く。
- サブタスクは `renderTaskSection()` で別セクション表示する。

## 4. タスク仕様

保存項目:

- `title`
- `actionDate`
- `dueDate`
- `priority`
- `assignee`
- `departmentId`
- `estimatedMinutes`
- `memoIds`
- `recurrence`
- `completedDates`

優先度:

- `P1`: 最優先
- `P2`: 2次優先
- `P3`: 3次優先
- `SUB`: サブタスク

`normalizeTaskPriority()` は未知値を `SUB` に正規化する。

## 5. 関連メモ仕様

- タスクフォームの関連メモ欄は `renderMemoPicker()` で描画する。
- 検索入力 `data-memo-search` はタイトル、本文、文字起こし、論点、方針、行動を対象にする。
- `filterMemoPicker()` は `normalizeSearchText()` でひらがな・カタカナ差、ローマ字、主要な業務語の漢字読みを吸収する。
- 保存時は `FormData.getAll("memoIds")` を `task.memoIds` に反映し、`syncMemoLinksForTask()` でメモ側と同期する。

## 6. メモ仕様

- 表示ラベルは「論点」「方針」「行動」。
- 内部キーは互換性のため `agenda`、`decisions`、`nextActions` を維持する。
- 録音中の文字起こしは `app.recordingTranscript`、`app.recordingInterimTranscript`、`app.pendingRecordingTranscript`、`data-recording-transcript-draft` で保持する。
- `saveQuickMemo()` と `handleMemoSubmit()` は `appendUniqueText()` で文字起こしを重複なく保存する。

## 7. 運営情報仕様

保存項目:

- `title`
- `type`
- `periodStart`
- `periodEnd`
- `departmentId`
- `policy`
- `taskIds`
- `memoIds`

種別:

- `renderPolicyTypeOptions()` は既存種別に加え `＋ 新しい種別を追加` を出す。
- 追加値は `ADD_POLICY_TYPE_VALUE`。
- 選択時は `addPolicyTypeFromSelect()` で `settings.policyTypes` に追加する。

## 8. カレンダー仕様

- `renderCalendarDayBadges()` は `getCalendarPeriodGroupsForDate()` の結果を最大3件表示する。
- グループ単位は正規化済みの `policy.type`。
- 1件なら `半`、2件以上なら `半2` のように表示する。
- DL は従来通り `DL` または `DL2` として表示する。
- `renderCalendarPeriodSummary()` は選択日に有効な運営情報を `slice()` で制限せず全件描画する。
- 件数が多い場合は `compactPeriodSummary()` の文字数上限を短くし、CSS の2行クランプで窓内に収める。
- DL 日は通常日より濃い `--due-surface` で塗り、2型3色覚モードでは斜線パターンも加える。

## 9. 期間仕様

- `renderPolicyPeriodField()` は hidden input と dataset を持つ。
- `selectPolicyPeriodDate()` はドラフト値のみ更新する。
- `savePolicyPeriod()` はドラフト値を hidden input と saved dataset へ反映する。
- 保存後は toast とインラインの軽いアニメーションで反応を返す。
- `periodSaveStateLabel()` は `formatPolicyPeriodRange()` の結果を表示し、値がなければ `期間なし` とする。

## 10. 設定仕様

- 分類と運営情報の種別は `.list-row` で表示する。
- 並び替えは `data-drag-handle` から開始する Pointer Events ドラッグで行う。
- `handleSettingsSubmit()` は DOM 順で分類の `sortOrder` と `settings.policyTypes` を保存する。
- `settings.colorVisionMode` は `standard` または `deutan` とし、`documentElement.dataset.colorVision` に反映する。
- 設定画面のデータ連携と外部 LLM 連携には `.integration-flow` の図示を出す。

## 11. LLM 自動判定仕様

- `classifyMemoForm()` は判定中にボタンを disabled にし、ステータスを表示する。
- `requestExternalMemoClassification()` は `provider`、`task`、`input`、`schema` を JSON POST する。
- 戻り値は英語キーと日本語キーを両方受け付ける。
- 静的 PWA 単体では、アプリ終了後も処理を継続するジョブ実行は仕様対象外とし、バックエンド追加時の拡張点とする。

## 12. キャッシュ仕様

- Service Worker キャッシュ名は `claris-cache-v23`。
- `index.html` と `data/` は network first、その他静的アセットは cache first とする。
