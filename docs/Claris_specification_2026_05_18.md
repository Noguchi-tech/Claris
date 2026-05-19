# Claris 仕様書

更新日: 2026-05-19  
対象: `Claris_app`

位置づけ: 詳細仕様・実装履歴。最新の標準入口は `requirements.md`、`architecture.md`、`api-spec.md`、`development-rules.md` とする。この文書に標準4ファイルと矛盾する旧表記が残る場合は、標準4ファイルを優先する。

## 1. 起動仕様

- `DOMContentLoaded` で `init()` を実行する。
- `openDatabase()` で IndexedDB を開く。
- `loadState()` と `normalizeState()` で保存済み state を補正する。
- `applyBundledTaskImport()` で `data/claris-master-2026-05-18.json` を確認する。
- `applyStartupUiPolicy()` で起動タブを `today` にし、今日集計ブロックを閉じた状態に戻す。
- `render()` 後に Service Worker を登録する。

## 2. 下部タブ仕様

- タブは `calendar`、`today`、`entries` の3つ。
- `updateNavIndicator()` は対象ボタンの実測位置から `--nav-indicator-x` と `--nav-indicator-width` を更新する。
- インジケーターはナビの内側に 3px 余白を取り、外へはみ出さない。
- 今日タブの高さは他タブと同じ 62px 以上とし、背景とアイコンで強調する。
- `.bottom-nav` は `bottom: 0` で画面下端まで覆い、safe area を padding に含める。

## 3. 今日タブ仕様

- `renderTodayView()` は今日の集計4項目を1つの折りたたみブロックとして描画する。
- `ui.todayMetricsOpen` が `false` の時は「実施」「DL超過」「メモ」「運営」の4ボタンを非表示にする。
- `ui.todayMetricsUserSet` が未設定の保存済み state は `normalizeState()` で `ui.todayMetricsOpen=false` に補正する。
- 折りたたみブロックの見出しは「今日」とし、ユーザーが開閉した状態はタブ移動後も維持する。
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
- `startTime`
- `endTime`

優先度:

- `P1`: 最優先
- `P2`: 2次優先
- `P3`: 3次優先
- `SUB`: サブタスク

`normalizeTaskPriority()` は未知値を `SUB` に正規化する。

日付選択:

- `renderTaskDatePicker()` は実施日と DL の表示欄だけを描画する。
- フォーム内の `[data-task-date-calendar]` は共通カレンダーとして1つだけ持つ。
- `toggleTaskDatePicker()` はアクティブな日付欄を切り替え、同じ欄を再タップした場合は閉じる。
- 日付カレンダー外のタップでは `closeTaskDateCalendarFromOutsideClick()` で閉じる。

時間選択:

- 開始/終了時間は `renderTaskTimePanel()` で日付欄の直下に折りたたみ表示する。
- 時間欄は hidden input と表示ボタンで構成し、開始と終了を横並びにする。
- `clearTaskTime()` は対象時間を空にし、追加の確定操作なしで時間選択パネルを閉じる。

## 5. 関連メモ仕様

- タスクフォームの関連メモ欄は `renderMemoPicker()` で描画する。
- 検索入力 `data-memo-search` はタイトル、本文、文字起こし、議題、方針、行動を対象にする。
- `filterMemoPicker()` は `normalizeSearchText()` でひらがな・カタカナ差、ローマ字、主要な業務語の漢字読みを吸収する。
- 保存時は `FormData.getAll("memoIds")` を `task.memoIds` に反映し、`syncMemoLinksForTask()` でメモ側と同期する。

## 6. メモ仕様

- 表示ラベルは「議題」「方針」「行動」。
- 内部キーは互換性のため `agenda`、`decisions`、`nextActions` を維持する。
- 保存済みメモの AI整理連携は `createMemoAiExportPrompt(memo)`、`parseMemoAiImportJson(text)`、`validateMemoAiImport(data, currentMemoId)`、`applyMemoAiSummaryToMemo(memo, summary)` に分離する。
- AI整理エクスポートは現在のメモ ID、タイトル、本文、文字起こし、作成日時、更新日時を含むプロンプトをクリップボードへコピーする。Claris 内では AI 処理を実行しない。
- AI整理インポートは `clarisImportType === "memo_ai_summary"`、`version === 1`、現在のメモ ID と一致する `memoId`、文字列配列の `agendas` / `policies` / `actions` を要求する。
- 取り込み成功時は `agendas` を `agenda`、`policies` を `decisions`、`actions` を `nextActions` へ改行区切りで保存し、`updatedAt` と同期メタ情報を通常のメモ更新と同じ経路で更新する。
- 既存の `agenda`、`decisions`、`nextActions` のいずれかに入力がある場合は、保存前に上書き確認を表示する。
- 録音中の文字起こしは `app.recordingTranscript`、`app.recordingInterimTranscript`、`app.pendingRecordingTranscript`、`data-recording-transcript-draft` で保持する。
- `saveQuickMemo()` と `handleMemoSubmit()` は `appendUniqueText()` で文字起こしを重複なく保存する。メモフォーム保存は `saveMemoFromForm()` を通す。

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
- 1種類の種別では `readablePeriodText()` でタイトルと本文の重複を避け、収まる範囲では全文寄りに表示する。
- 2種類の種別では `period-summary-list.is-stacked` で種別ごとに縦並びにする。
- 3種類以上の種別では `period-summary-list.is-condensed` と `period-summary-chip` で `半期2` のような種別別件数を横並びにする。
- 件数が多い場合は `compactPeriodSummary()` の文字数上限を短くし、CSS の行数制限で窓内に収める。
- DL 日は通常日より濃い `--due-surface` で塗る。

## 9. 期間仕様

- `renderPolicyPeriodField()` は hidden input と dataset を持つ。
- `selectPolicyPeriodDate()` はドラフト値のみ更新する。
- `savePolicyPeriod()` はドラフト値を hidden input と saved dataset へ反映する。
- 保存後は期間カレンダー上の `period-save-toast` に「期間を保存しました」と表示し、インラインの軽いアニメーションで反応を返す。
- `periodSaveStateLabel()` は `formatPolicyPeriodRange()` の結果を表示し、値がなければ `期間なし` とする。

## 10. 設定仕様

- 分類と運営情報の種別は `.list-row` で表示する。
- 並び替えは `data-drag-handle` から開始する Pointer Events ドラッグで行う。
- `handleSettingsSubmit()` は DOM 順で分類の `sortOrder` と `settings.policyTypes` を保存する。
- 色覚補正設定は持たない。
- 設定画面のデータ連携と外部 LLM 連携には装飾的な図示を出さない。

## 11. 追加フロー仕様

- 右下の `open-add` から `openKind()` でタスク、メモ、運営情報フォームを開く場合は `dialogBackTarget` に追加種別選択画面を設定する。
- フォーム右上の×または外部タップで未保存データがなければ、`returnToPreviousDialog()` で追加種別選択画面へ戻る。
- 未保存データがある場合は従来通り保存、破棄、戻るを確認し、破棄を選ぶと追加種別選択画面へ戻る。

## 12. LLM 自動判定仕様

- `classifyMemoForm()` は判定中にボタンを disabled にし、ステータスを表示する。
- `requestExternalMemoClassification()` は `provider`、`task`、`input`、`schema` を JSON POST する。
- 戻り値は英語キーと日本語キーを両方受け付ける。
- 静的 PWA 単体では、アプリ終了後も処理を継続するジョブ実行は仕様対象外とし、バックエンド追加時の拡張点とする。

## 13. キャッシュ仕様

- Service Worker キャッシュ名は `claris-cache-v33`。
- `index.html` と `data/` は network first、その他静的アセットは cache first とする。

## 14. 小型サーバー準備仕様

- `server.mjs` は静的配信に加えて `GET /api/health` を返す。
- `GET /api/capabilities` は常時同期、AI秘書化、音声常駐、Apple Watch、バックグラウンド自動処理の予定状態を JSON で返す。
- 現段階ではデータ書き込み、外部 LLM 実行、バックグラウンドジョブ実行は行わない。
