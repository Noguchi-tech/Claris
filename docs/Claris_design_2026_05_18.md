# Claris 設計書

更新日: 2026-05-18  
対象: `Claris_app`

## 1. 全体構成

Claris は依存ライブラリを増やさない静的 PWA とする。

- `index.html`: アプリ外枠、PWA メタ情報、下部タブ、ダイアログ。
- `styles.css`: iPhone16 向けレイアウト、下部ナビ、フォーム、カレンダー、ドラッグ UI。
- `app.js`: IndexedDB、状態正規化、描画、イベント処理、録音、文字起こし、LLM 連携。
- `sw.js`: オフラインキャッシュ。
- `docs/`: 要件定義書、設計書、仕様書、引き継ぎ書。

## 2. 状態管理

IndexedDB `claris-local-db` の `app` ストアに `state` を保存する。主要コレクションは `tasks`、`memos`、`policies`、`departments`、`deletedItems`、`settings`、`ui` とする。

互換性維持のため、内部キー `departmentId`、`agenda`、`decisions`、`nextActions`、`policies` は残す。表示ラベルはそれぞれ「分類」「論点」「方針」「行動」「運営情報」とする。

## 3. 下部ナビ設計

下部ナビは3分割固定とし、中央の今日タブも枠内に収める。

- インジケーターは実ボタン幅から内側余白を引いた幅で表示する。
- 今日タブだけを外へ膨らませず、同じ高さの中でアイコンと背景で強調する。
- `overflow: hidden` によりリキッドグラス風の擬似要素がタブ外へはみ出さないようにする。
- ナビは画面下端へ接地させ、safe area を自身の padding として持つ。下端の空白から背面カードへタップが抜ける状態を作らない。

## 4. 今日画面設計

今日画面は上から集計、優先タスク、サブタスク、運営情報、完了済みの順に表示する。

- 優先タスクは最優先、2次優先、3次優先の専用スロットとして表示する。
- サブタスクは通常のタスク一覧として分ける。
- 空き優先枠には、その枠へ追加するボタンを置く。

## 5. カレンダー設計

カレンダーは月曜始まり42セル固定とする。運営情報は `getCalendarPeriodsForDate()` で日付ごとに取得し、日付セルでは種別単位に集約して表示する。

- 種別略称は `compactPeriodType()` で作る。
- 同種別が複数ある場合は `半2` のように件数を付ける。
- カレンダー上部サマリは全件を折り返し表示し、件数が多いときは `compactPeriodSummary()` でタイトルと本文を短くする。
- DL 日は濃い背景で表示し、2型3色覚モードでは斜線パターンで意味を補強する。
- 選択日の詳細では従来通りカード単位で編集できる。

## 6. フォーム設計

フォーム下部の保存領域は sticky のまま維持し、余白を圧縮する。期間選択は hidden input の保存値と dataset のドラフト値を分ける。

- `data-draft-start` / `data-draft-end`: カレンダー上の編集中期間。
- `periodStart` / `periodEnd`: 保存済み期間。
- 期間保存ボタン押下で hidden input と saved dataset を更新する。
- 期間表示は `formatPolicyPeriodRange()` で `5/18-6/30` 形式にする。

## 7. 分類・種別編集設計

設定画面の分類と種別は `.list-row` とドラッグハンドルで並び替える。

- Pointer Events を使い、iPhone のタッチ操作に合わせる。
- ドラッグ中の行をポインタ位置の行前後へ移動する。
- 保存時に DOM 順を `sortOrder` と `settings.policyTypes` へ反映する。

運営情報フォームの種別 select には `＋ 新しい種別を追加` を置き、選択時に prompt で追加する。

## 8. 検索・アクセシビリティ設計

検索キーは `normalizeSearchText()` で NFKC 正規化、カタカナのひらがな化、ローマ字化、主要な業務語の別表記追加を行う。汎用の漢字読み変換ライブラリは増やさず、Claris 内で使う分類名、優先度、DL、運営情報、メモ項目を辞書化する。

色覚補正は `settings.colorVisionMode` で保持し、`data-color-vision="deutan"` の CSS 変数で配色を切り替える。DL と P1 は色だけでなくパターンも加える。

## 9. メモ・文字起こし設計

録音中の文字起こしは `pendingRecordingTranscript`、録音中ドラフト、非表示 input の3経路で保持する。

- プレビューは `updateTranscriptPreview()` で更新する。
- 保存時は `appendUniqueText()` で重複を避けて本文と文字起こし欄へ反映する。
- 文字起こし API が使えない場合でも録音ファイルは保存待ちにできる。

## 10. LLM 連携設計

メモの自動判定は `classifyMemoForm()` から実行する。

- 入力元はタイトル、本文、文字起こし。
- `settings.llmEndpoint` が設定されていれば POST する。
- 戻り値は `title`、`agenda`、`decisions`、`nextActions` または `論点`、`方針`、`行動` を受け付ける。
- 通信失敗時は `organizeText()` のローカル判定へフォールバックする。
- 設定画面では `integration-flow` でメモ、LLM、整理の流れを図示し、データ連携でも端末、JSON、反映の流れを同じ部品で示す。

## 11. 配置設計

要件定義書、設計書、仕様書は `Claris_app/docs/` に置く。`Claris_app` は Git リポジトリのため、GitHub へ push すれば Windows 側で pull できる。
