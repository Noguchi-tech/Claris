(() => {
  "use strict";

  const DB_NAME = "claris-local-db";
  const DB_VERSION = 1;
  const STORE = "app";
  const STATE_KEY = "state";
  const BUNDLED_TASK_IMPORT_URL = "./data/claris-master-2026-05-17.json";
  const SINGLE_SLOT_PRIORITIES = ["P1", "P2", "P3"];
  const PERIOD_LINE_CLASS_COUNT = 6;
  const CLASSIFICATION_LABEL = "分類";

  const priorityMeta = {
    P1: { label: "最優先", className: "priority-p1" },
    P2: { label: "2次優先", className: "priority-p2" },
    P3: { label: "3次優先", className: "priority-p3" },
    SUB: { label: "サブタスク", className: "priority-sub" },
    NONE: { label: "未設定", className: "priority-none" }
  };
  const entryKindMeta = {
    all: "すべて",
    task: "タスク",
    memo: "メモ",
    policy: "方針"
  };

  const tabs = {
    calendar: "カレンダー",
    today: "今日",
    entries: "一覧"
  };
  const legacyEntryTabs = new Set(["tasks", "memos", "policies"]);
  const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
  const recurrenceLabels = {
    none: "なし",
    weekly: "週次",
    "monthly-day": "毎月日付",
    "monthly-nth": "第n曜日",
    "monthly-end": "月末",
    custom: "カスタム"
  };

  // `departmentId` is kept as the durable storage key. The user-facing label is "分類".
  const defaultDepartments = [
    ["dept_store", "庶務", ""],
    ["dept_food", "食品", ""],
    ["dept_clothing", "衣服", ""],
    ["dept_life", "H＆B", ""],
    ["dept_houseware", "ハウス", ""],
    ["dept_kitchen", "ステー", ""],
    ["dept_large", "大型", ""],
    ["dept_other", "その他", ""]
  ];
  const defaultDepartmentNamesById = new Map(defaultDepartments.map(([id, name]) => [id, name]));
  const defaultDepartmentOrderById = new Map(defaultDepartments.map(([id], index) => [id, index + 1]));
  const legacyDefaultDepartmentNamesById = new Map([
    ["dept_store", "店舗全体"],
    ["dept_life", "生活"],
    ["dept_kitchen", "キッチン"],
    ["dept_houseware", "ハウスウェア"]
  ]);
  const legacyDefaultDepartmentIdsByName = new Map([...legacyDefaultDepartmentNamesById].map(([id, name]) => [name, id]));

  const app = {
    state: null,
    db: null,
    pendingConflict: null,
    mediaRecorder: null,
    recordingChunks: [],
    recordingStartedAt: 0,
    recordingBaseText: "",
    recordingTranscript: "",
    recordingInterimTranscript: "",
    recordingStream: null,
    pendingRecordings: [],
    pendingRecordingTranscript: "",
    recordingStopPromise: null,
    recordingStopResolve: null,
    recognition: null,
    toastTimer: 0
  };

  const entityDialog = document.getElementById("entityDialog");
  const conflictDialog = document.getElementById("conflictDialog");
  const view = document.getElementById("view");
  const viewTitle = document.getElementById("viewTitle");
  const appName = document.getElementById("appName");
  const headerDate = document.getElementById("headerDate");
  const bottomNav = document.querySelector(".bottom-nav");
  const toast = document.getElementById("toast");

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    app.db = await openDatabase();
    app.state = await loadState();
    await applyBundledTaskImport();
    applyStartupUiPolicy();
    render();
    registerServiceWorker();
  }

  function bindEvents() {
    document.body.addEventListener("click", handleClick);
    document.body.addEventListener("change", handleChange);
    document.body.addEventListener("input", handleInput);
    document.body.addEventListener("keydown", handleKeydown);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stopAudioCaptureImmediately();
    });
    window.addEventListener("pagehide", stopAudioCaptureImmediately);
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbGet(key) {
    return new Promise((resolve, reject) => {
      const tx = app.db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbPut(key, value) {
    return new Promise((resolve, reject) => {
      const tx = app.db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadState() {
    const saved = await dbGet(STATE_KEY);
    if (!saved) return createDefaultState();
    return normalizeState(saved);
  }

  function applyStartupUiPolicy() {
    app.state.ui.activeTab = "today";
    if (!app.state.ui.selectedDate) app.state.ui.selectedDate = todayIso();
    if (!app.state.ui.calendarMonth) app.state.ui.calendarMonth = monthKey(new Date());
  }

  async function saveState() {
    app.state.updatedAt = nowIso();
    await dbPut(STATE_KEY, app.state);
  }

  function createDefaultState() {
    const createdAt = nowIso();
    return {
      schemaVersion: 1,
      createdAt,
      updatedAt: createdAt,
      settings: {
        workerName: "",
        showCompleted: true,
        showLinkedMemos: true,
        appliedTaskImportId: ""
      },
      ui: {
        activeTab: "today",
        taskFilter: "all",
        entryKind: "all",
        entryFilter: "all",
        entrySearch: "",
        calendarMonth: monthKey(new Date()),
        selectedDate: todayIso()
      },
      tasks: [],
      memos: [],
      policies: [],
      departments: defaultDepartments.map(([id, name, parentId], index) => ({
        id,
        name,
        parentId,
        sortOrder: index + 1,
        createdAt,
        updatedAt: createdAt
      })),
      projects: [],
      deletedItems: []
    };
  }

  function normalizeState(saved) {
    const base = createDefaultState();
    const merged = {
      ...base,
      ...saved,
      settings: { ...base.settings, ...(saved.settings || {}) },
      ui: { ...base.ui, ...(saved.ui || {}) },
      tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
      memos: Array.isArray(saved.memos) ? saved.memos : [],
      policies: Array.isArray(saved.policies) ? saved.policies : [],
      departments: normalizeDepartments(saved.departments, base.departments),
      projects: Array.isArray(saved.projects) ? saved.projects : [],
      deletedItems: Array.isArray(saved.deletedItems) ? saved.deletedItems : []
    };
    merged.tasks = merged.tasks.map(normalizeTask);
    merged.memos = merged.memos.map(normalizeMemo);
    merged.policies = merged.policies.map(normalizePolicy);
    merged.deletedItems = merged.deletedItems.map(normalizeDeletedItem);
    return merged;
  }

  function normalizeDepartments(departments, fallback = []) {
    const source = Array.isArray(departments) && departments.length ? departments : fallback;
    const now = nowIso();
    return source.map((department, index) => {
      const id = department.id || uid("dept");
      const defaultSort = defaultDepartmentOrderById.get(id);
      return {
        id,
        name: normalizeDepartmentName(id, department.name),
        parentId: "",
        sortOrder: defaultSort || Number(department.sortOrder || index + 1),
        createdAt: department.createdAt || now,
        updatedAt: department.updatedAt || now
      };
    }).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  }

  function normalizeDepartmentName(id, name) {
    const text = String(name || "").trim();
    const currentDefault = defaultDepartmentNamesById.get(id);
    const legacyDefault = legacyDefaultDepartmentNamesById.get(id);
    if (currentDefault && (!text || text === legacyDefault)) return currentDefault;
    return text || currentDefault || "未名称";
  }

  function normalizeTask(task) {
    return {
      id: task.id || uid("task"),
      title: task.title || "",
      description: task.description || "",
      assignee: task.assignee || "",
      actionDate: task.actionDate || "",
      dueDate: task.dueDate || "",
      priority: priorityMeta[task.priority] ? task.priority : "NONE",
      status: task.status || "active",
      departmentId: task.departmentId || "",
      projectId: task.projectId || "",
      estimatedMinutes: Number(task.estimatedMinutes || 0),
      memoIds: Array.isArray(task.memoIds) ? task.memoIds : [],
      showLinkedMemos: task.showLinkedMemos !== false,
      recurrence: normalizeRecurrence(task.recurrence),
      completedDates: normalizeDateList(task.completedDates),
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso(),
      completedAt: task.completedAt || null
    };
  }

  function normalizeRecurrence(recurrence = {}) {
    const type = recurrenceLabels[recurrence.type] ? recurrence.type : "none";
    return {
      type,
      interval: clampNumber(recurrence.interval, 1, 24, 1),
      weekdays: normalizeWeekdays(recurrence.weekdays),
      monthDay: clampNumber(recurrence.monthDay, 1, 31, 1),
      ordinal: clampNumber(recurrence.ordinal, 1, 5, 2),
      weekday: clampNumber(recurrence.weekday, 0, 6, 0),
      customDates: normalizeDateList(recurrence.customDates)
    };
  }

  function normalizeMemo(memo) {
    return {
      id: memo.id || uid("memo"),
      title: memo.title || firstLine(memo.body) || "メモ",
      body: memo.body || "",
      agenda: memo.agenda || "",
      decisions: memo.decisions || "",
      nextActions: memo.nextActions || "",
      transcript: memo.transcript || "",
      dueDate: memo.dueDate || "",
      priority: priorityMeta[memo.priority] ? memo.priority : "NONE",
      departmentId: memo.departmentId || "",
      projectId: memo.projectId || "",
      taskIds: Array.isArray(memo.taskIds) ? memo.taskIds : [],
      recordings: Array.isArray(memo.recordings) ? memo.recordings : [],
      createdAt: memo.createdAt || nowIso(),
      updatedAt: memo.updatedAt || nowIso()
    };
  }

  function normalizePolicy(policy) {
    return {
      ...policy,
      id: policy.id || uid("policy"),
      title: policy.title || "方針",
      type: normalizePolicyType(policy.type || "方針"),
      periodStart: policy.periodStart || "",
      periodEnd: policy.periodEnd || "",
      departmentId: policy.departmentId || "",
      background: policy.background || "",
      policy: policy.policy || "",
      actions: policy.actions || "",
      notes: policy.notes || "",
      taskIds: Array.isArray(policy.taskIds) ? policy.taskIds : [],
      memoIds: Array.isArray(policy.memoIds) ? policy.memoIds : [],
      createdAt: policy.createdAt || nowIso(),
      updatedAt: policy.updatedAt || nowIso()
    };
  }

  function normalizePolicyType(type) {
    const text = String(type || "").trim();
    if (text === "部門") return CLASSIFICATION_LABEL;
    return text || "方針";
  }

  function normalizeDeletedItem(item) {
    return {
      id: item.id || uid("deleted"),
      kind: item.kind || "item",
      title: item.title || "削除済み",
      deletedAt: item.deletedAt || nowIso(),
      item: item.item || {}
    };
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      showToast("オフライン用キャッシュの登録に失敗しました。通常利用は可能です。");
    }
  }

  function render() {
    const activeTab = normalizeActiveTab(app.state.ui.activeTab || "today");
    app.state.ui.activeTab = activeTab;
    viewTitle.textContent = tabs[activeTab] || "今日";
    if (appName) appName.textContent = "Claris / クラリス";
    if (headerDate) headerDate.textContent = formatHeaderDate(todayIso());
    renderNav(activeTab);
    if (activeTab === "calendar") renderCalendarView();
    if (activeTab === "today") renderTodayView();
    if (activeTab === "entries") renderEntriesView();
  }

  function renderNav(activeTab) {
    const navIndex = ["calendar", "today", "entries"].indexOf(activeTab);
    if (bottomNav) {
      const offsets = ["0px", "calc(100% + 4px)", "calc(200% + 8px)"];
      bottomNav.style.setProperty("--nav-offset", offsets[Math.max(navIndex, 0)] || offsets[1]);
      bottomNav.classList.toggle("is-today-active", activeTab === "today");
    }
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === activeTab);
    });
  }

  function normalizeActiveTab(tab) {
    if (legacyEntryTabs.has(tab)) return "entries";
    return tabs[tab] ? tab : "today";
  }

  function buildHeaderAssigneeLabel() {
    const names = [...new Set(app.state.tasks
      .filter((task) => task.status === "active" && task.actionDate === todayIso() && task.assignee)
      .map((task) => task.assignee.trim())
      .filter(Boolean))];
    if (names.length) return `今日の担当: ${names.slice(0, 3).join(" / ")}${names.length > 3 ? " ほか" : ""}`;
    return "担当者はタスクごとに設定します";
  }

  function renderTodayView() {
    const date = todayIso();
    const activeTasks = app.state.tasks.filter((task) => task.status === "active");
    const todayTasks = sortTasks(activeTasks.filter((task) => taskOccursOnDate(task, date) && !isTaskCompletedForDate(task, date)));
    const overdue = sortTasks(activeTasks.filter((task) => task.dueDate && task.dueDate < date && !taskOccursOnDate(task, date)));
    const completedToday = sortTasks(app.state.tasks.filter((task) => isTaskCompletedForDate(task, date)));
    const relatedPolicies = app.state.policies.filter((policy) => isDateInPolicy(date, policy));

    view.innerHTML = `
      <section class="dashboard-grid" aria-label="今日の数">
        ${renderStat("実施", todayTasks.length, "tasks")}
        ${renderStat("DL超過", overdue.length, "overdue")}
        ${renderStat("メモ", app.state.memos.length, "memos")}
        ${renderStat("方針", relatedPolicies.length, "policies")}
      </section>
      ${overdue.length ? renderTaskSection("DL超過", overdue, "DLが過ぎています") : ""}
      ${["P1", "P2", "P3", "SUB"].map((priority) => {
        const tasks = todayTasks.filter((task) => task.priority === priority);
        const emptyAction = priority === "SUB" ? "" : `<button class="mini-button" type="button" data-action="add-task-slot" data-priority="${priority}" data-date="${date}">この枠に追加</button>`;
        return renderTaskSection(priorityMeta[priority].label, tasks, "空き", emptyAction, date);
      }).join("")}
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">今日に関係する方針</h2>
          <span class="section-count">${relatedPolicies.length}件</span>
        </div>
        <div class="policy-list">
          ${relatedPolicies.length ? relatedPolicies.map(renderPolicyCard).join("") : renderEmpty("今日の方針・施策はありません。", "方針を追加")}
        </div>
      </section>
      ${app.state.settings.showCompleted ? renderTaskSection("今日完了", completedToday, "今日完了したタスクはありません", "", date) : ""}
    `;
  }

  function renderTasksView() {
    const filter = app.state.ui.taskFilter || "all";
    const activeTasks = app.state.tasks.filter((task) => task.status === "active");
    const completed = sortTasksByActionDate(app.state.tasks.filter((task) => task.status === "completed"));
    const filtered = sortTasksByActionDate(activeTasks.filter((task) => {
      if (filter === "today") return task.actionDate === todayIso();
      if (filter === "no-date") return !task.actionDate;
      if (filter === "due") return Boolean(task.dueDate);
      if (filter.startsWith("dept:")) return task.departmentId === filter.slice(5);
      if (filter.startsWith("project:")) return task.projectId === filter.slice(8);
      return true;
    }));

    view.innerHTML = `
      <section class="toolbar">
        <label for="taskFilter">フィルター</label>
        <select id="taskFilter">
          <option value="all"${selected(filter, "all")}>すべて</option>
          <option value="today"${selected(filter, "today")}>今日</option>
          <option value="no-date"${selected(filter, "no-date")}>実施日なし</option>
          <option value="due"${selected(filter, "due")}>DLあり</option>
          ${app.state.departments.map((department) => `<option value="dept:${escapeAttr(department.id)}"${selected(filter, `dept:${department.id}`)}>${CLASSIFICATION_LABEL}: ${escapeHtml(department.name)}</option>`).join("")}
          ${app.state.projects.map((project) => `<option value="project:${escapeAttr(project.id)}"${selected(filter, `project:${project.id}`)}>PJ: ${escapeHtml(project.name)}</option>`).join("")}
        </select>
      </section>
      ${renderTaskSection("未完了", filtered, "該当するタスクはありません")}
      ${app.state.settings.showCompleted ? renderTaskSection("完了済み", completed, "完了済みタスクはありません") : ""}
    `;
  }

  function renderEntriesView() {
    const kind = entryKindMeta[app.state.ui.entryKind] ? app.state.ui.entryKind : "all";
    const filter = app.state.ui.entryFilter || "all";
    const query = app.state.ui.entrySearch || "";
    const activeTasks = sortTasksByActionDate(app.state.tasks.filter((task) =>
      task.status === "active" && matchesEntryItem(task, "task", filter, query)
    ));
    const completed = sortTasksByActionDate(app.state.tasks.filter((task) =>
      task.status === "completed" && matchesEntryItem(task, "task", filter, query)
    ));
    const memos = app.state.memos
      .filter((memo) => matchesEntryItem(memo, "memo", filter, query))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const policies = app.state.policies
      .filter((policy) => matchesEntryItem(policy, "policy", filter, query))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const showTasks = kind === "all" || kind === "task";
    const showMemos = kind === "all" || kind === "memo";
    const showPolicies = kind === "all" || kind === "policy";

    view.innerHTML = `
      <section class="toolbar entries-toolbar">
        ${Object.entries(entryKindMeta).map(([value, label]) => `
          <button class="mini-button ${kind === value ? "is-active" : ""}" type="button" data-action="set-entry-kind" data-kind="${value}">${label}</button>
        `).join("")}
      </section>
      <section class="toolbar entry-filter-bar">
        <input id="entrySearch" type="search" value="${escapeAttr(query)}" placeholder="検索" autocomplete="off">
        <select id="entryFilter" aria-label="一覧フィルター">
          ${renderEntryFilterOptions(filter)}
        </select>
      </section>
      ${showTasks ? renderTaskSection("タスク", activeTasks, "該当するタスクはありません。") : ""}
      ${showTasks && app.state.settings.showCompleted ? renderTaskSection("完了済み", completed, "該当する完了済みタスクはありません") : ""}
      ${showMemos ? renderQuickCapture() : ""}
      ${showMemos ? `<section class="section">
        <div class="section-head">
          <h2 class="section-title">メモ</h2>
          <span class="section-count">${memos.length}件</span>
        </div>
        <div class="memo-list">
          ${memos.length ? memos.map(renderMemoCard).join("") : renderEmpty("該当するメモはありません。", "メモを追加")}
        </div>
      </section>` : ""}
      ${showPolicies ? `<section class="section">
        <div class="section-head">
          <h2 class="section-title">方針</h2>
          <span class="section-count">${policies.length}件</span>
        </div>
        <div class="policy-list">
          ${policies.length ? policies.map(renderPolicyCard).join("") : renderEmpty("該当する方針はありません。", "方針を追加")}
        </div>
      </section>` : ""}
    `;
    updateTranscriptPreview(getRecordingPreviewText());
    updateRecordingButtons();
  }

  function renderCalendarView() {
    const current = parseMonthKey(app.state.ui.calendarMonth || monthKey(new Date()));
    const selectedDate = app.state.ui.selectedDate || todayIso();
    const filter = "all";
    const days = buildCalendarDays(current.year, current.month);
    const selectedTasks = sortCalendarTasks(app.state.tasks.filter((task) =>
      matchesCalendarTaskFilter(task, filter) &&
      ((task.status === "active" && taskOccursOnDate(task, selectedDate)) || task.dueDate === selectedDate)
    ));
    const selectedPolicies = app.state.policies.filter((policy) =>
      matchesCalendarPolicyFilter(policy, filter) && isDateInPolicy(selectedDate, policy)
    );

    view.innerHTML = `
      <section class="calendar-shell">
        <div class="calendar-header">
          <button class="mini-button" type="button" data-action="month-prev">前月</button>
          <h2 class="section-title">${current.year}年${current.month + 1}月</h2>
          <button class="mini-button" type="button" data-action="month-next">翌月</button>
        </div>
        ${renderCalendarPeriodSummary(selectedDate)}
        <div class="calendar-grid" aria-label="カレンダー">
          ${["月", "火", "水", "木", "金", "土", "日"].map((day) => `<div class="weekday">${day}</div>`).join("")}
          ${days.map((day) => renderDayCell(day, selectedDate, filter)).join("")}
        </div>
        <div class="calendar-day-detail">
          <div class="section-head">
            <h2 class="section-title">${formatLongDate(selectedDate)}の予定</h2>
            <button class="mini-button" type="button" data-action="add-task-slot" data-priority="P2" data-date="${selectedDate}">追加</button>
          </div>
          ${selectedTasks.length ? `<div class="task-list">${selectedTasks.map((task) => renderTaskCard(task, selectedDate)).join("")}</div>` : `<p class="body-preview">この日の作業またはDLタスクはありません。</p>`}
          ${selectedPolicies.length ? `<div class="policy-list">${selectedPolicies.map(renderPolicyCard).join("")}</div>` : ""}
        </div>
      </section>
    `;
  }

  function renderDayCell(day, selectedDate, filter) {
    const iso = toDateInputValue(day.date);
    const actionTasks = app.state.tasks.filter((task) =>
      task.status === "active" && taskOccursOnDate(task, iso) && !isTaskCompletedForDate(task, iso) && matchesCalendarTaskFilter(task, filter)
    );
    const dueTasks = app.state.tasks.filter((task) =>
      task.status === "active" && task.dueDate === iso && matchesCalendarTaskFilter(task, filter)
    );
    const classes = [
      "day-cell",
      day.inMonth ? "" : "is-muted",
      calendarDateClass(day.date),
      iso === todayIso() ? "is-today" : "",
      iso === selectedDate ? "is-selected" : "",
      dueTasks.length ? "has-due" : ""
    ].filter(Boolean).join(" ");
    return `
      <button class="${classes}" type="button" data-action="select-day" data-date="${iso}">
        <span class="day-head">
          <span class="day-number">${day.date.getDate()}</span>
          ${renderCalendarDayBadges(iso, dueTasks.length, filter)}
        </span>
        ${renderDayPrioritySummary(actionTasks)}
      </button>
    `;
  }

  function renderCalendarDayBadges(isoDate, dueCount, filter) {
    const periods = getCalendarPeriodsForDate(isoDate, filter).slice(0, 3);
    const badges = [];
    if (dueCount) {
      badges.push(`<span class="day-badge day-badge-due" title="DL ${dueCount}件">DL${dueCount > 1 ? dueCount : ""}</span>`);
    }
    periods.forEach((period) => {
      const classes = [
        "day-badge",
        "day-badge-period",
        `period-line-${stableIndex(period.id, PERIOD_LINE_CLASS_COUNT)}`
      ].join(" ");
      badges.push(`<span class="${classes}" title="${escapeAttr(`${period.type}: ${period.title}`)}">${escapeHtml(compactPeriodType(period.type))}</span>`);
    });
    return badges.length ? `<span class="day-badge-stack" aria-label="日付の予定">${badges.join("")}</span>` : "";
  }

  function compactPeriodType(type) {
    const text = String(type || "期");
    if (/週/.test(text)) return "週";
    if (/月/.test(text)) return "月";
    if (/半期/.test(text)) return "半";
    if (/プロジェクト|PJ/i.test(text)) return "PJ";
    return truncate(text, 2);
  }

  function renderDayPrioritySummary(actionTasks) {
    const count = (priority) => actionTasks.filter((task) => task.priority === priority).length;
    const tokens = [
      ["P1", "最"],
      ["P2", "2"],
      ["P3", "3"]
    ];
    return `
      <span class="day-priority-row" aria-label="作業優先度">
        ${tokens.map(([priority, label]) => {
          const total = count(priority);
          return `<span class="day-priority-token ${total ? "is-active" : "is-muted"} ${priorityMeta[priority].className}" title="${priorityMeta[priority].label}: ${total}件">${label}</span>`;
        }).join("")}
      </span>
    `;
  }

  function renderCalendarPeriodLines(isoDate, filter) {
    const periods = getCalendarPeriodsForDate(isoDate, filter).slice(0, 3);
    if (!periods.length) return "";
    return `
      <span class="period-lines" aria-label="方針・施策">
        ${periods.map((period) => {
          const classes = [
            "period-line",
            `period-line-${stableIndex(period.id, PERIOD_LINE_CLASS_COUNT)}`,
            isoDate === period.start ? "is-start" : "",
            isoDate === period.end ? "is-end" : ""
          ].filter(Boolean).join(" ");
          return `<span class="${classes}" title="${escapeAttr(period.title)}"></span>`;
        }).join("")}
      </span>
    `;
  }

  function renderCalendarDueLine(count) {
    if (!count) return "";
    return `
      <span class="due-lines" aria-label="DL ${count}件">
        <span class="due-line" title="DL ${count}件"></span>
      </span>
    `;
  }

  function renderCalendarPeriodSummary(date) {
    const periods = getCalendarPeriodsForDate(date, "all").slice(0, 4);
    return `
      <section class="calendar-period-summary" aria-label="選択日の方針・施策">
        <span class="period-summary-label">方針・施策</span>
        <div class="period-summary-list">
          ${periods.length ? periods.map((period) => {
            const classes = [
              "period-summary-item",
              `period-line-${stableIndex(period.id, PERIOD_LINE_CLASS_COUNT)}`
            ].join(" ");
            const action = period.source === "project" ? "edit-project-period" : "edit-policy";
            const summary = compactPeriodSummary(period);
            return `
              <button class="${classes}" type="button" data-action="${action}" data-id="${escapeAttr(period.id)}" title="${escapeAttr(`${period.type || "方針"}: ${summary}`)}">
                <strong>${escapeHtml(period.type || "方針")}</strong>
                <span>${escapeHtml(summary)}</span>
              </button>
            `;
          }).join("") : `<span class="period-summary-empty">方針・施策なし</span>`}
        </div>
      </section>
    `;
  }

  function compactPeriodSummary(period) {
    const title = truncate(period.title || period.type || "方針", 16);
    const detail = truncate(period.summary || "", 28);
    if (!detail || detail === title) return title;
    return `${title}: ${detail}`;
  }

  function renderCalendarPolicyFocus(date, filter) {
    const policies = app.state.policies.filter((policy) =>
      matchesCalendarPolicyFilter(policy, filter) && isDateInPolicy(date, policy)
    );
    if (!policies.length) return "";
    const groups = [
      ["週次", policies.filter((policy) => /週/.test(policy.type || ""))],
      ["月次", policies.filter((policy) => /月/.test(policy.type || ""))],
      ["半期", policies.filter((policy) => /半期/.test(policy.type || ""))]
    ].filter(([, items]) => items.length);
    const other = policies.filter((policy) => !/(週|月|半期)/.test(policy.type || ""));
    return `
      <section class="calendar-policy-focus" aria-label="選択日の方針">
        ${groups.map(([label, items]) => `
          <div class="policy-focus-card" data-card-action="edit-policy" data-id="${escapeAttr(items[0].id)}" tabindex="0">
            <span class="policy-focus-label">${label}</span>
            <strong>${escapeHtml(items[0].title)}</strong>
            ${items[0].policy ? `<span>${escapeHtml(truncate(items[0].policy, 46))}</span>` : ""}
          </div>
        `).join("")}
        ${other.slice(0, 2).map((policy) => `
          <div class="policy-focus-card" data-card-action="edit-policy" data-id="${escapeAttr(policy.id)}" tabindex="0">
            <span class="policy-focus-label">${escapeHtml(policy.type || "方針")}</span>
            <strong>${escapeHtml(policy.title)}</strong>
            ${policy.policy ? `<span>${escapeHtml(truncate(policy.policy, 46))}</span>` : ""}
          </div>
        `).join("")}
      </section>
    `;
  }

  function renderMemosView() {
    const memos = [...app.state.memos].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    view.innerHTML = `
      ${renderQuickCapture()}
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">メモ一覧</h2>
          <span class="section-count">${memos.length}件</span>
        </div>
        <div class="memo-list">
          ${memos.length ? memos.map(renderMemoCard).join("") : renderEmpty("メモはまだありません。", "メモを追加")}
        </div>
      </section>
    `;
    updateTranscriptPreview(getRecordingPreviewText());
    updateRecordingButtons();
  }

  function renderQuickCapture() {
    return `
      <section class="quick-capture">
        <div class="section-head">
          <h2 class="section-title">走り書きメモ</h2>
          <span class="recording-status" id="recordingStatus" data-recording-status>録音待機中</span>
        </div>
        <textarea id="quickMemoText" placeholder="とっさの話し合い、指示、気づきをそのまま入力"></textarea>
        <div id="recordingTranscriptPreview" class="transcript-preview hidden" data-recording-transcript-preview aria-live="polite"></div>
        <div class="recording-bar">
          <button class="solid-button compact" type="button" data-action="save-quick-memo">保存</button>
          <button class="ghost-button compact" type="button" data-action="start-recording">録音</button>
          <button class="ghost-button compact" type="button" data-action="stop-recording" disabled>停止</button>
        </div>
      </section>
    `;
  }

  function renderPoliciesView() {
    const policies = [...app.state.policies].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    view.innerHTML = `
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">方針</h2>
          <span class="section-count">${policies.length}件</span>
        </div>
        <div class="policy-list">
          ${policies.length ? policies.map(renderPolicyCard).join("") : renderEmpty("方針はまだありません。", "方針を追加")}
        </div>
      </section>
    `;
  }

  function renderStat(label, value, summary) {
    return `
      <button class="stat-tile" type="button" data-action="open-today-summary" data-summary="${escapeAttr(summary || "")}">
        <div class="stat-value">${value}</div>
        <div class="stat-label">${escapeHtml(label)}</div>
      </button>
    `;
  }

  function openTodaySummaryDialog(kind) {
    const date = todayIso();
    const activeTasks = app.state.tasks.filter((task) => task.status === "active");
    const todayTasks = sortTasks(activeTasks.filter((task) => taskOccursOnDate(task, date) && !isTaskCompletedForDate(task, date)));
    const overdue = sortTasks(activeTasks.filter((task) => task.dueDate && task.dueDate < date && !taskOccursOnDate(task, date)));
    const memos = [...app.state.memos].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const policies = app.state.policies.filter((policy) => isDateInPolicy(date, policy));
    const summary = {
      tasks: {
        title: "今日の実施",
        subtitle: `${formatLongDate(date)}に実施するタスク`,
        html: todayTasks.length ? `<div class="task-list">${todayTasks.map((task) => renderTaskCard(task, date)).join("")}</div>` : renderEmpty("今日の実施タスクはありません。")
      },
      overdue: {
        title: "DL超過",
        subtitle: "DLを過ぎている未完了タスク",
        html: overdue.length ? `<div class="task-list">${overdue.map((task) => renderTaskCard(task)).join("")}</div>` : renderEmpty("DL超過タスクはありません。")
      },
      memos: {
        title: "メモ",
        subtitle: "保存済みメモ",
        html: memos.length ? `<div class="memo-list">${memos.map(renderMemoCard).join("")}</div>` : renderEmpty("メモはありません。", "メモを追加")
      },
      policies: {
        title: "今日の方針",
        subtitle: `${formatLongDate(date)}の方針・施策`,
        html: policies.length ? `<div class="policy-list">${policies.map(renderPolicyCard).join("")}</div>` : renderEmpty("今日の方針・施策はありません。", "方針を追加")
      }
    }[kind] || null;
    if (!summary) return;
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(summary.title, summary.subtitle)}
        ${summary.html}
      </div>
    `);
  }

  function renderTaskSection(title, tasks, emptyText, actionHtml = "", contextDate = "") {
    return `
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <span class="section-count">${tasks.length}件</span>
        </div>
        <div class="task-list">
          ${tasks.length ? tasks.map((task) => renderTaskCard(task, contextDate)).join("") : renderEmpty(emptyText, "", actionHtml)}
        </div>
      </section>
    `;
  }

  function renderEmpty(text, addLabel = "", actionHtml = "") {
    const addButton = addLabel ? `<button class="mini-button" type="button" data-action="open-add">${escapeHtml(addLabel)}</button>` : "";
    return `<div class="empty-state"><p>${escapeHtml(text)}</p><div class="card-actions">${actionHtml}${addButton}</div></div>`;
  }

  function renderTaskCard(task, contextDate = "") {
    const priority = priorityMeta[task.priority] || priorityMeta.NONE;
    const department = findById(app.state.departments, task.departmentId);
    const project = findById(app.state.projects, task.projectId);
    const linkedMemos = getLinkedMemos(task);
    const memoSummary = shouldShowMemos(task, linkedMemos)
      ? `<div class="memo-summary">${linkedMemos.map((memo) => `
          <button class="memo-link-button" type="button" data-action="edit-memo" data-id="${escapeAttr(memo.id)}">
            <strong>${escapeHtml(memo.title || "メモ")}</strong>
            <span>${escapeHtml(summarizeMemo(memo))}</span>
          </button>
        `).join("")}</div>`
      : "";
    const completed = isTaskCompletedForDate(task, contextDate);
    const recurrence = recurrenceLabel(task);
    const dateAttr = contextDate ? ` data-date="${escapeAttr(contextDate)}"` : "";
    return `
      <article class="task-card ${completed ? "completed" : ""}" data-card-action="edit-task" data-id="${escapeAttr(task.id)}" tabindex="0">
        <button class="complete-button ${completed ? "is-completed" : ""}" type="button" data-action="toggle-task" data-id="${escapeAttr(task.id)}"${dateAttr} aria-label="完了切替"></button>
        <div class="task-main">
          <div class="task-title-row">
            <h3 class="task-title"><button class="title-button" type="button" data-action="edit-task" data-id="${escapeAttr(task.id)}">${escapeHtml(task.title)}</button></h3>
            <span class="priority-pill ${priority.className}">${priority.label}</span>
          </div>
          <div class="meta-row">
            ${task.actionDate ? `<span class="tag">実施 ${formatShortDate(task.actionDate)}</span>` : ""}
            ${task.dueDate ? `<span class="tag">DL ${formatShortDate(task.dueDate)}</span>` : ""}
            ${task.assignee ? `<span class="tag">担当 ${escapeHtml(task.assignee)}</span>` : ""}
            ${department ? `<span class="tag">${escapeHtml(department.name)}</span>` : ""}
            ${project ? `<span class="tag">${escapeHtml(project.name)}</span>` : ""}
            ${linkedMemos.length ? `<span class="tag">メモ ${linkedMemos.length}</span>` : ""}
            ${recurrence ? `<span class="tag">${escapeHtml(recurrence)}</span>` : ""}
          </div>
          ${memoSummary}
          <div class="card-actions">
            <button class="mini-button" type="button" data-action="move-today" data-id="${escapeAttr(task.id)}">今日</button>
            <button class="mini-button" type="button" data-action="duplicate-task" data-id="${escapeAttr(task.id)}">複製</button>
            <button class="mini-button" type="button" data-action="delete-task" data-id="${escapeAttr(task.id)}">削除</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderMemoCard(memo) {
    const department = findById(app.state.departments, memo.departmentId);
    const project = findById(app.state.projects, memo.projectId);
    const linkedTasks = memo.taskIds.map((id) => findById(app.state.tasks, id)).filter(Boolean);
    const recordings = memo.recordings || [];
    const previewText = getMemoPreviewText(memo);
    return `
      <article class="memo-card" data-card-action="edit-memo" data-id="${escapeAttr(memo.id)}" tabindex="0">
        <div class="section-head">
          <h3><button class="title-button" type="button" data-action="edit-memo" data-id="${escapeAttr(memo.id)}">${escapeHtml(memo.title || "メモ")}</button></h3>
          <span class="priority-pill ${(priorityMeta[memo.priority] || priorityMeta.NONE).className}">${(priorityMeta[memo.priority] || priorityMeta.NONE).label}</span>
        </div>
        <div class="meta-row">
          ${memo.dueDate ? `<span class="tag">DL ${formatShortDate(memo.dueDate)}</span>` : ""}
          ${department ? `<span class="tag">${escapeHtml(department.name)}</span>` : ""}
          ${project ? `<span class="tag">${escapeHtml(project.name)}</span>` : ""}
          ${linkedTasks.length ? `<span class="tag">関連タスク ${linkedTasks.length}</span>` : ""}
          ${recordings.length ? `<span class="tag">録音 ${recordings.length}</span>` : ""}
        </div>
        ${previewText ? `<button class="body-preview body-preview-button" type="button" data-action="edit-memo" data-id="${escapeAttr(memo.id)}">${escapeHtml(previewText)}</button>` : ""}
        <div class="card-actions">
          <button class="mini-button" type="button" data-action="memo-to-task" data-id="${escapeAttr(memo.id)}">タスク化</button>
          <button class="mini-button" type="button" data-action="delete-memo" data-id="${escapeAttr(memo.id)}">削除</button>
        </div>
      </article>
    `;
  }

  function renderRecording(recording) {
    const url = recording.blob instanceof Blob ? URL.createObjectURL(recording.blob) : "";
    if (!url) return "";
    return `
      <div>
        <audio controls src="${url}"></audio>
        <span class="recording-status">${escapeHtml(recording.name || "録音")}</span>
      </div>
    `;
  }

  function renderPolicyCard(policy) {
    const department = findById(app.state.departments, policy.departmentId);
    return `
      <article class="policy-card" data-card-action="edit-policy" data-id="${escapeAttr(policy.id)}" tabindex="0">
        <div class="section-head">
          <h3>${escapeHtml(policy.title)}</h3>
          <span class="status-pill">${escapeHtml(policy.type || "方針")}</span>
        </div>
        <div class="meta-row">
          ${policy.periodStart ? `<span class="tag">${formatShortDate(policy.periodStart)}</span>` : ""}
          ${policy.periodEnd ? `<span class="tag">- ${formatShortDate(policy.periodEnd)}</span>` : ""}
          ${department ? `<span class="tag">${escapeHtml(department.name)}</span>` : ""}
        </div>
        ${policy.policy ? `<p class="body-preview">${escapeHtml(truncate(policy.policy, 150))}</p>` : ""}
        <div class="card-actions">
          <button class="mini-button" type="button" data-action="edit-policy" data-id="${escapeAttr(policy.id)}">編集</button>
          <button class="mini-button" type="button" data-action="delete-policy" data-id="${escapeAttr(policy.id)}">削除</button>
        </div>
      </article>
    `;
  }

  async function handleClick(event) {
    const tabButton = event.target.closest("[data-tab]");
    if (tabButton) {
      app.state.ui.activeTab = normalizeActiveTab(tabButton.dataset.tab);
      await saveState();
      render();
      return;
    }

    if (activateCardFromEvent(event)) return;

    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;

    if (action === "open-add") openAddForCurrentContext();
    if (action === "add-task-slot") openTaskForm(null, { actionDate: button.dataset.date, priority: button.dataset.priority });
    if (action === "open-settings") openSettings();
    if (action === "quick-import") openImportDialog();
    if (action === "close-dialog") closeDialogs();
    if (action === "open-kind") openKind(button.dataset.kind);
    if (action === "set-entry-kind") await setEntryKind(button.dataset.kind);
    if (action === "open-today-summary") openTodaySummaryDialog(button.dataset.summary);
    if (action === "select-priority-slot") selectPrioritySlot(button);
    if (action === "edit-task") openTaskForm(findById(app.state.tasks, id));
    if (action === "edit-memo") openMemoForm(findById(app.state.memos, id));
    if (action === "edit-policy") openPolicyForm(findById(app.state.policies, id));
    if (action === "toggle-task") await toggleTask(id, button.dataset.date || "");
    if (action === "move-today") await moveTaskToToday(id);
    if (action === "assign-today-priority") await assignTaskToToday(id, button.dataset.priority);
    if (action === "duplicate-task") await duplicateTask(id);
    if (action === "delete-task") openTaskDeleteConfirm(id);
    if (action === "confirm-delete-task") {
      closeDialogs();
      await deleteEntity("tasks", id, "タスクを削除しました");
    }
    if (action === "delete-memo") await deleteMemo(id);
    if (action === "delete-policy") await deleteEntity("policies", id, "方針を削除しました");
    if (action === "classify-memo-form") classifyMemoForm();
    if (action === "memo-to-task") openTaskFromMemo(id);
    if (action === "restore-deleted-item") await restoreDeletedItem(id);
    if (action === "purge-deleted-item") await purgeDeletedItem(id);
    if (action === "save-quick-memo") await saveQuickMemo();
    if (action === "start-recording") await startRecording();
    if (action === "stop-recording") stopRecording();
    if (action === "start-transcription") startTranscription();
    if (action === "stop-transcription") stopTranscription();
    if (action === "month-prev") await changeMonth(-1);
    if (action === "month-next") await changeMonth(1);
    if (action === "select-day") await selectDay(button.dataset.date);
    if (action === "edit-project-period") openSettings();
    if (action === "resolve-conflict") await resolveConflict(button.dataset.mode);
    if (action === "back-to-task-form") reopenPendingTaskForm();
    if (action === "export-json") exportJson();
    if (action === "export-master-json") exportMasterJson();
    if (action === "run-import") await runImportFromDialog();
    if (action === "add-department") addSettingsRow("department");
    if (action === "add-project") addSettingsRow("project");
    if (action === "remove-settings-row") button.closest(".list-row")?.remove();
  }

  function handleKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (activateCardFromEvent(event)) {
      event.preventDefault();
    }
  }

  function activateCardFromEvent(event) {
    if (event.target.closest("button, a, input, textarea, select, label, audio, video")) return false;
    const card = event.target.closest("[data-card-action]");
    if (!card) return false;
    return activateCard(card.dataset.cardAction, card.dataset.id);
  }

  function activateCard(action, id) {
    if (action === "edit-task") {
      const task = findById(app.state.tasks, id);
      if (!task) return false;
      openTaskForm(task);
    } else if (action === "edit-memo") {
      const memo = findById(app.state.memos, id);
      if (!memo) return false;
      openMemoForm(memo);
    } else if (action === "edit-policy") {
      const policy = findById(app.state.policies, id);
      if (!policy) return false;
      openPolicyForm(policy);
    } else if (action === "edit-project-period") {
      openSettings();
      showToast("プロジェクトの方針・施策は設定で編集できます。");
    } else {
      return false;
    }
    return true;
  }

  async function handleChange(event) {
    if (event.target.id === "settingsImportFile") {
      await readImportFile(event.target);
      return;
    }
    if (event.target.id === "taskRecurrenceType") {
      updateRecurrenceForm(event.target.closest("form"));
      return;
    }
    if (event.target.id === "taskActionDate" || event.target.id === "taskPriority") {
      updateTaskPriorityPreview(event.target.closest("form"));
      return;
    }
    if (event.target.id === "conflictMoveDate" || event.target.id === "conflictMovePriority") {
      updateConflictMovePreview();
      return;
    }
    if (event.target.id === "taskFilter") {
      app.state.ui.taskFilter = event.target.value;
      await saveState();
      render();
    }
    if (event.target.id === "entryFilter") {
      app.state.ui.entryFilter = event.target.value;
      await saveState();
      render();
    }
  }

  function handleInput(event) {
    if (event.target.matches("[data-task-search]")) {
      filterTaskPicker(event.target);
    }
    if (event.target.id === "entrySearch") {
      const cursor = event.target.selectionStart || 0;
      app.state.ui.entrySearch = event.target.value;
      saveState();
      renderEntriesView();
      const search = document.getElementById("entrySearch");
      if (search) {
        search.focus();
        search.setSelectionRange(cursor, cursor);
      }
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (form.id === "taskForm") await handleTaskSubmit(form);
    if (form.id === "memoForm") await handleMemoSubmit(form);
    if (form.id === "policyForm") await handlePolicySubmit(form);
    if (form.id === "settingsForm") await handleSettingsSubmit(form);
    if (form.id === "importForm") await handleImportSubmit(form);
  }

  function openKind(kind) {
    if (kind === "task") openTaskForm(null, defaultTaskForCurrentContext());
    if (kind === "memo") openMemoForm();
    if (kind === "policy") openPolicyForm();
    if (kind === "project") openProjectForm();
    if (kind === "department") openDepartmentForm();
  }

  async function setEntryKind(kind) {
    app.state.ui.entryKind = entryKindMeta[kind] ? kind : "all";
    await saveState();
    render();
  }

  function selectPrioritySlot(button) {
    const priority = button.dataset.priority || "";
    if (!priorityMeta[priority]) return;
    const conflictTarget = button.closest("#conflictMoveAvailability");
    if (conflictTarget) {
      const input = document.getElementById("conflictMovePriority");
      if (input) input.value = input.value === priority ? "NONE" : priority;
      updateConflictMovePreview();
      return;
    }
    const form = button.closest("form");
    const input = form?.elements.priority;
    if (!input) return;
    input.value = input.value === priority ? "NONE" : priority;
    updateTaskPriorityPreview(form);
  }

  function openAddForCurrentContext() {
    openAddChoice(defaultAddKind());
  }

  function defaultAddKind() {
    const activeTab = normalizeActiveTab(app.state.ui.activeTab || "today");
    return activeTab === "entries" ? "task" : "task";
  }

  function openAddChoice(active = "task") {
    openSheet(`
      <div class="sheet sheet-compact">
        ${renderSheetHeader("追加", "追加する内容を選んでください。")}
        ${renderKindButtons(active)}
      </div>
    `);
  }

  function defaultTaskForCurrentContext() {
    if (app.state.ui.activeTab === "today") return { actionDate: todayIso(), priority: "P2" };
    if (app.state.ui.activeTab === "calendar") return { actionDate: app.state.ui.selectedDate || todayIso(), priority: "P2" };
    return { priority: "NONE" };
  }

  function openTaskForm(task = null, defaults = {}) {
    const existing = task ? normalizeTask(task) : null;
    const value = {
      id: existing?.id || "",
      title: existing?.title || "",
      description: existing?.description || "",
      assignee: existing?.assignee || "",
      actionDate: existing?.actionDate || defaults.actionDate || "",
      dueDate: existing?.dueDate || "",
      priority: existing?.priority || defaults.priority || "NONE",
      departmentId: existing?.departmentId || "",
      projectId: existing?.projectId || "",
      estimatedMinutes: existing?.estimatedMinutes || "",
      memoIds: existing?.memoIds || [],
      showLinkedMemos: existing?.showLinkedMemos !== false,
      recurrence: normalizeRecurrence(existing?.recurrence || defaults.recurrence || {})
    };
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(existing ? "タスク編集" : "タスク追加", "実施日とDLは別々に管理します。")}
        <form id="taskForm" class="form-grid" data-id="${escapeAttr(value.id)}" data-original-action-date="${escapeAttr(existing?.actionDate || "")}" data-original-priority="${escapeAttr(existing?.priority || "")}">
          <div class="field">
            <label for="taskTitle">タスク名</label>
            <input id="taskTitle" name="title" required value="${escapeAttr(value.title)}" autocomplete="off">
          </div>
          <div class="field-inline task-date-row">
            <div class="field">
              <label for="taskActionDate">実施</label>
              <input id="taskActionDate" name="actionDate" type="date" value="${escapeAttr(value.actionDate)}">
            </div>
            <div class="field">
              <label for="taskDueDate">DL</label>
              <input id="taskDueDate" name="dueDate" type="date" value="${escapeAttr(value.dueDate)}">
            </div>
          </div>
          <div class="field-inline">
            <div class="field">
              <label>優先度の空き状況</label>
              <input id="taskPriority" name="priority" type="hidden" value="${escapeAttr(value.priority)}">
              <div id="priorityAvailability" class="priority-availability" aria-live="polite"></div>
            </div>
            <div class="field">
              <label for="taskAssignee">担当者</label>
              <input id="taskAssignee" name="assignee" value="${escapeAttr(value.assignee)}" autocomplete="off" placeholder="任意">
            </div>
            <div class="field">
              <label for="taskDepartment">${CLASSIFICATION_LABEL}</label>
              <select id="taskDepartment" name="departmentId">${renderDepartmentOptions(value.departmentId)}</select>
            </div>
            <div class="field">
              <label for="taskProject">プロジェクト</label>
              <select id="taskProject" name="projectId">${renderProjectOptions(value.projectId)}</select>
            </div>
            <div class="field">
              <label for="taskEstimate">見積分</label>
              <input id="taskEstimate" name="estimatedMinutes" type="number" min="0" step="5" value="${escapeAttr(value.estimatedMinutes)}">
            </div>
          </div>
          ${renderRecurrenceFields(value.recurrence)}
          <div class="field">
            <label for="taskMemos">関連メモ</label>
            <select id="taskMemos" name="memoIds" multiple size="4">${renderMemoOptions(value.memoIds)}</select>
          </div>
          <label class="toolbar">
            <input name="showLinkedMemos" type="checkbox" ${value.showLinkedMemos ? "checked" : ""}>
            このタスクではメモ要約を表示
          </label>
          <div class="form-actions">
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
    updateRecurrenceForm(document.getElementById("taskForm"));
    updateTaskPriorityPreview(document.getElementById("taskForm"));
  }

  function openMemoForm(memo = null) {
    const existing = memo ? normalizeMemo(memo) : null;
    resetRecordingDraft();
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(existing ? "メモ編集" : "メモ追加", "走り書きから始めて、後で議題や決定事項を整えられます。")}
        <form id="memoForm" class="form-grid" data-id="${escapeAttr(existing?.id || "")}">
          <div class="field">
            <label for="memoTitle">タイトル</label>
            <input id="memoTitle" name="title" value="${escapeAttr(existing?.title || "")}" autocomplete="off">
          </div>
          <section class="memo-recording-panel">
            <div class="section-head">
              <h2 class="section-title">録音</h2>
              <span class="recording-status" data-recording-status>録音待機中</span>
            </div>
            <div class="recording-bar">
              <button class="ghost-button compact" type="button" data-action="start-recording">録音</button>
              <button class="ghost-button compact" type="button" data-action="stop-recording" disabled>停止</button>
            </div>
            <div class="transcript-preview hidden" data-recording-transcript-preview aria-live="polite"></div>
          </section>
          <div class="field">
            <label for="memoBody">本文</label>
            <textarea id="memoBody" name="body" required>${escapeHtml(existing?.body || "")}</textarea>
          </div>
          <div class="toolbar">
            <button class="ghost-button compact" type="button" data-action="classify-memo-form">本文から自動判定</button>
          </div>
          <div class="field-inline">
            <div class="field">
              <label for="memoAgenda">議題</label>
              <textarea id="memoAgenda" name="agenda">${escapeHtml(existing?.agenda || "")}</textarea>
            </div>
            <div class="field">
              <label for="memoDecisions">決まったこと</label>
              <textarea id="memoDecisions" name="decisions">${escapeHtml(existing?.decisions || "")}</textarea>
            </div>
            <div class="field">
              <label for="memoNextActions">ネクストアクション</label>
              <textarea id="memoNextActions" name="nextActions">${escapeHtml(existing?.nextActions || "")}</textarea>
            </div>
          </div>
          <div class="field">
            <label for="memoTranscript">文字起こし</label>
            <textarea id="memoTranscript" name="transcript" placeholder="録音時の文字起こしや、別アプリで起こした全文をここに保存">${escapeHtml(existing?.transcript || "")}</textarea>
          </div>
          ${existing?.recordings?.length ? `
            <div class="field">
              <label>録音</label>
              <div class="audio-list">${existing.recordings.map(renderRecording).join("")}</div>
            </div>
          ` : ""}
          <div class="field-inline">
            <div class="field">
              <label for="memoDueDate">DL</label>
              <input id="memoDueDate" name="dueDate" type="date" value="${escapeAttr(existing?.dueDate || "")}">
            </div>
            <div class="field">
              <label for="memoPriority">優先度</label>
              <select id="memoPriority" name="priority">${renderPriorityOptions(existing?.priority || "NONE")}</select>
            </div>
            <div class="field">
              <label for="memoDepartment">${CLASSIFICATION_LABEL}</label>
              <select id="memoDepartment" name="departmentId">${renderDepartmentOptions(existing?.departmentId || "")}</select>
            </div>
          </div>
          <div class="field">
            <label for="memoProject">プロジェクト</label>
            <select id="memoProject" name="projectId">${renderProjectOptions(existing?.projectId || "")}</select>
          </div>
          <div class="field">
            <label for="memoTasks">関連タスク</label>
            ${renderTaskPicker(existing?.taskIds || [])}
          </div>
          <div class="form-actions">
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
    updateTranscriptPreview("");
    updateRecordingButtons();
  }

  function openPolicyForm(policy = null) {
    const existing = policy || {};
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(policy ? "方針編集" : "方針追加", "タスクではない判断材料を残します。")}
        <form id="policyForm" class="form-grid" data-id="${escapeAttr(existing.id || "")}">
          <div class="field">
            <label for="policyTitle">タイトル</label>
            <input id="policyTitle" name="title" required value="${escapeAttr(existing.title || "")}" autocomplete="off">
          </div>
          <div class="field-inline">
            <div class="field">
              <label for="policyType">種別</label>
              <select id="policyType" name="type">
                ${["月次", "週次", "半期", "分類", "施策", "イベント", "在庫", "売場", "商売計画"].map((type) => `<option value="${type}"${selected(existing.type, type)}>${type}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="periodStart">開始</label>
              <input id="periodStart" name="periodStart" type="date" value="${escapeAttr(existing.periodStart || "")}">
            </div>
            <div class="field">
              <label for="periodEnd">終了</label>
              <input id="periodEnd" name="periodEnd" type="date" value="${escapeAttr(existing.periodEnd || "")}">
            </div>
          </div>
          <div class="field">
            <label for="policyDepartment">${CLASSIFICATION_LABEL}</label>
            <select id="policyDepartment" name="departmentId">${renderDepartmentOptions(existing.departmentId || "")}</select>
          </div>
          <div class="field">
            <label for="policyBackground">背景</label>
            <textarea id="policyBackground" name="background">${escapeHtml(existing.background || "")}</textarea>
          </div>
          <div class="field">
            <label for="policyText">方針</label>
            <textarea id="policyText" name="policy">${escapeHtml(existing.policy || "")}</textarea>
          </div>
          <div class="field">
            <label for="policyActions">やること</label>
            <textarea id="policyActions" name="actions">${escapeHtml(existing.actions || "")}</textarea>
          </div>
          <div class="field">
            <label for="policyNotes">注意点</label>
            <textarea id="policyNotes" name="notes">${escapeHtml(existing.notes || "")}</textarea>
          </div>
          <div class="form-actions">
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
  }

  function openProjectForm() {
    const createdAt = nowIso();
    const id = uid("project");
    app.state.projects.push({
      id,
      name: "新しいプロジェクト",
      purpose: "",
      departmentId: "",
      startDate: "",
      endDate: "",
      status: "active",
      createdAt,
      updatedAt: createdAt
    });
    saveState().then(() => {
      closeDialogs();
      openSettings();
      showToast("プロジェクトを追加しました。設定で名前を変更できます。");
    });
  }

  function openDepartmentForm() {
    const createdAt = nowIso();
    app.state.departments.push({
      id: uid("dept"),
      name: "新しい分類",
      parentId: "",
      sortOrder: app.state.departments.length + 1,
      createdAt,
      updatedAt: createdAt
    });
    saveState().then(() => {
      closeDialogs();
      openSettings();
      showToast("分類を追加しました。設定で名前を変更できます。");
    });
  }

  function renderKindButtons(active) {
    const items = [
      ["task", "タスク", "実施とDL"],
      ["memo", "メモ", "走り書き"],
      ["policy", "方針", "判断材料"]
    ];
    return `
      <div class="choice-grid" aria-label="追加種別">
        ${items.map(([kind, label, sub]) => `
          <button class="choice-button ${active === kind ? "is-active" : ""}" type="button" data-action="open-kind" data-kind="${kind}">
            <strong>${label}</strong>
            <span>${sub}</span>
          </button>
        `).join("")}
      </div>
    `;
  }

  function renderRecurrenceFields(recurrence) {
    const value = normalizeRecurrence(recurrence);
    return `
      <section class="recurrence-panel">
        <div class="field-inline recurrence-head">
          <div class="field">
            <label for="taskRecurrenceType">繰り返し</label>
            <select id="taskRecurrenceType" name="recurrenceType">
              ${Object.entries(recurrenceLabels).map(([type, label]) =>
                `<option value="${type}"${selected(value.type, type)}>${label}</option>`
              ).join("")}
            </select>
          </div>
          <div class="field recurrence-section" data-recurrence-section="weekly monthly-day monthly-nth monthly-end custom">
            <label for="taskRecurrenceInterval">間隔</label>
            <input id="taskRecurrenceInterval" name="recurrenceInterval" type="number" min="1" max="24" step="1" value="${escapeAttr(value.interval)}">
          </div>
        </div>
        <div class="recurrence-section recurrence-weekdays" data-recurrence-section="weekly">
          ${weekdayLabels.map((label, index) => `
            <label class="weekday-choice">
              <input type="checkbox" name="recurrenceWeekdays" value="${index}" ${value.weekdays.includes(index) ? "checked" : ""}>
              <span>${label}</span>
            </label>
          `).join("")}
        </div>
        <div class="field recurrence-section" data-recurrence-section="monthly-day">
          <label for="taskRecurrenceMonthDay">毎月の日付</label>
          <input id="taskRecurrenceMonthDay" name="recurrenceMonthDay" type="number" min="1" max="31" step="1" value="${escapeAttr(value.monthDay)}">
        </div>
        <div class="field-inline recurrence-section" data-recurrence-section="monthly-nth">
          <div class="field">
            <label for="taskRecurrenceOrdinal">第</label>
            <select id="taskRecurrenceOrdinal" name="recurrenceOrdinal">
              ${[1, 2, 3, 4, 5].map((ordinal) => `<option value="${ordinal}"${selected(value.ordinal, ordinal)}>${ordinal}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="taskRecurrenceWeekday">曜日</label>
            <select id="taskRecurrenceWeekday" name="recurrenceWeekday">
              ${weekdayLabels.map((label, index) => `<option value="${index}"${selected(value.weekday, index)}>${label}曜日</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="field recurrence-section" data-recurrence-section="custom">
          <label for="taskRecurrenceCustomDates">カスタム日付</label>
          <textarea id="taskRecurrenceCustomDates" name="recurrenceCustomDates" placeholder="2026-05-16&#10;2026-06-15">${escapeHtml(value.customDates.join("\n"))}</textarea>
        </div>
      </section>
    `;
  }

  function updateRecurrenceForm(form) {
    if (!form) return;
    const type = form.elements.recurrenceType?.value || "none";
    form.querySelectorAll("[data-recurrence-section]").forEach((section) => {
      const visible = section.dataset.recurrenceSection.split(" ").includes(type);
      section.classList.toggle("hidden", !visible);
    });
  }

  function recurrenceFromForm(data) {
    return normalizeRecurrence({
      type: String(data.get("recurrenceType") || "none"),
      interval: Number(data.get("recurrenceInterval") || 1),
      weekdays: data.getAll("recurrenceWeekdays").map(Number),
      monthDay: Number(data.get("recurrenceMonthDay") || 1),
      ordinal: Number(data.get("recurrenceOrdinal") || 2),
      weekday: Number(data.get("recurrenceWeekday") || 0),
      customDates: String(data.get("recurrenceCustomDates") || "")
        .split(/[\n,、\s]+/)
        .map((date) => date.trim())
        .filter(Boolean)
    });
  }

  function updateTaskPriorityPreview(form) {
    if (!form) return;
    const target = form.querySelector("#priorityAvailability");
    if (!target) return;
    const date = String(form.elements.actionDate?.value || "");
    if (!date && form.elements.priority) form.elements.priority.value = "NONE";
    const selectedPriority = String(form.elements.priority?.value || "");
    const currentId = form.dataset.id || "";
    target.innerHTML = renderPrioritySelector(date, currentId, selectedPriority);
  }

  function renderPrioritySelector(date, excludeId = "", selectedPriority = "", extraExcludeIds = []) {
    const selected = priorityMeta[selectedPriority] ? selectedPriority : "NONE";
    if (!date) {
      return `
        <div class="availability-row availability-row-empty">
          <span class="availability-note">実施日を選ぶと、その日の優先度の空き状況を表示します。</span>
        </div>
      `;
    }
    const excludeIds = [excludeId].concat(extraExcludeIds).filter(Boolean);
    const rows = ["P1", "P2", "P3", "SUB"].map((priority) => {
      const occupants = getPriorityOccupants(date, priority, excludeIds);
      const occupied = occupants.length && priority !== "SUB";
      const label = priorityMeta[priority].label;
      const detail = priority === "SUB"
        ? `${occupants.length}件`
        : (occupied ? truncate(occupants[0].title || "登録済み", 16) : "空き");
      return renderPrioritySlotButton(priority, label, detail, selected === priority, occupied, occupants.length);
    }).join("");
    return `
      <div class="availability-row">${rows}</div>
      <p class="availability-note">未選択: 未設定</p>
    `;
  }

  function renderPrioritySlotButton(priority, label, detail, selectedPriority, occupied, count) {
    const classes = [
      "availability-pill",
      occupied ? "is-occupied" : "is-open",
      selectedPriority ? "is-selected" : "",
      priority === "NONE" ? "is-none" : ""
    ].filter(Boolean).join(" ");
    return `
      <button class="${classes}" type="button" data-action="select-priority-slot" data-priority="${priority}" aria-pressed="${selectedPriority ? "true" : "false"}">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(detail)}${occupied && count > 1 ? ` ほか${count - 1}` : ""}</small>
      </button>
    `;
  }

  async function handleTaskSubmit(form) {
    const data = new FormData(form);
    const id = form.dataset.id || uid("task");
    const existing = findById(app.state.tasks, id);
    const now = nowIso();
    const task = normalizeTask({
      ...existing,
      id,
      title: String(data.get("title") || "").trim(),
      description: "",
      assignee: String(data.get("assignee") || "").trim(),
      actionDate: String(data.get("actionDate") || ""),
      dueDate: String(data.get("dueDate") || ""),
      priority: String(data.get("priority") || "NONE"),
      departmentId: String(data.get("departmentId") || ""),
      projectId: String(data.get("projectId") || ""),
      estimatedMinutes: Number(data.get("estimatedMinutes") || 0),
      memoIds: data.getAll("memoIds").map(String),
      showLinkedMemos: data.get("showLinkedMemos") === "on",
      recurrence: recurrenceFromForm(data),
      completedDates: existing?.completedDates || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status: existing?.status || "active",
      completedAt: existing?.completedAt || null
    });
    closeDialogs();
    await saveTaskWithConflict(task, {
      originalActionDate: form.dataset.originalActionDate || "",
      originalPriority: form.dataset.originalPriority || ""
    });
  }

  async function saveTaskWithConflict(task, context, mode = "") {
    const conflicts = findPriorityConflicts(task);
    if (conflicts.length && !mode) {
      app.pendingConflict = { task, context, conflicts };
      openConflictDialog(task, conflicts);
      return;
    }

    if (mode && conflicts.length) {
      const resolved = applyConflictMode(task, conflicts, context, mode);
      if (!resolved) return;
    }
    upsertById(app.state.tasks, task);
    syncMemoLinksForTask(task);
    await saveState();
    render();
    showToast("タスクを保存しました。");
  }

  function openConflictDialog(task, conflicts) {
    const existingLabel = conflicts.length > 1 ? `既存 ${conflicts.length}件` : "既存";
    const availablePriority = findAvailablePriority(task.actionDate, task.id, [task.priority]);
    conflictDialog.innerHTML = `
      <div class="sheet">
        ${renderSheetHeader("優先度の入れ替え", `${formatShortDate(task.actionDate)} の ${priorityMeta[task.priority].label} には既存タスクがあります。`)}
        <div class="conflict-compare">
          <section class="conflict-panel conflict-task-panel conflict-new">
            <span class="conflict-label">入れたいタスク</span>
            <strong>${escapeHtml(task.title)}</strong>
            <span>${formatConflictSlot(task)}</span>
          </section>
          <section class="conflict-panel conflict-task-panel conflict-existing">
            <span class="conflict-label">${existingLabel}タスク</span>
            ${conflicts.map((item) => `
              <div class="conflict-existing-item">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${formatConflictSlot(item)}</span>
              </div>
            `).join("")}
          </section>
        </div>
        <div class="conflict-actions">
          <button class="choice-button conflict-action-button" type="button" data-action="resolve-conflict" data-mode="new-available">
            <strong>新規を空き枠へ</strong>
            <span>${priorityMeta[availablePriority].label} に新規タスクを保存する</span>
          </button>
          <section class="conflict-move-box">
            <button class="choice-button conflict-action-button" type="button" data-action="resolve-conflict" data-mode="move-existing">
              <strong>既存を移動して入れる</strong>
              <span>既存タスクを下の移動先へ移し、新規タスクを選択中の枠へ入れる</span>
            </button>
            <div class="conflict-move-controls">
              <div class="field">
                <label for="conflictMoveDate">既存の移動日</label>
                <input id="conflictMoveDate" type="date" value="${escapeAttr(task.actionDate)}">
              </div>
              <div class="field">
                <label>移動先の空き状況</label>
                <input id="conflictMovePriority" type="hidden" value="${escapeAttr(availablePriority)}">
                <div id="conflictMoveAvailability" class="priority-availability"></div>
              </div>
            </div>
          </section>
          <button class="choice-button conflict-back-button" type="button" data-action="back-to-task-form">
            <strong>戻って修正</strong>
            <span>日付や優先度を自分で選び直す</span>
          </button>
        </div>
      </div>
    `;
    conflictDialog.showModal();
    updateConflictMovePreview();
  }

  async function resolveConflict(mode) {
    if (!app.pendingConflict) return;
    const { task, context } = app.pendingConflict;
    const conflicts = findPriorityConflicts(task);
    if (mode === "move-existing") {
      const moveDate = document.getElementById("conflictMoveDate")?.value || "";
      const movePriority = document.getElementById("conflictMovePriority")?.value || "NONE";
      if (!moveDate || !priorityMeta[movePriority]) {
        showToast("既存タスクの移動日を選んでください。");
        return;
      }
      const blocked = SINGLE_SLOT_PRIORITIES.includes(movePriority) && getPriorityOccupants(moveDate, movePriority, conflicts.map((item) => item.id).concat(task.id)).length;
      if (blocked) {
        showToast("移動先の優先度は埋まっています。別の日付か優先度を選んでください。");
        return;
      }
      context.moveDate = moveDate;
      context.movePriority = movePriority;
    }
    app.pendingConflict = null;
    closeDialogs();
    await saveTaskWithConflict(task, context, mode || "new-available");
  }

  function updateConflictMovePreview() {
    if (!conflictDialog.open || !app.pendingConflict) return;
    const target = document.getElementById("conflictMoveAvailability");
    const date = document.getElementById("conflictMoveDate")?.value || "";
    const priority = document.getElementById("conflictMovePriority")?.value || "";
    const excludeIds = app.pendingConflict.conflicts.map((item) => item.id).concat(app.pendingConflict.task.id);
    if (target) target.innerHTML = renderPrioritySelector(date, "", priority, excludeIds);
  }

  function reopenPendingTaskForm() {
    if (!app.pendingConflict) return;
    const task = app.pendingConflict.task;
    app.pendingConflict = null;
    closeDialogs();
    openTaskForm(task);
  }

  function formatConflictSlot(task) {
    const priority = priorityMeta[task.priority]?.label || "未設定";
    const date = task.actionDate ? formatShortDate(task.actionDate) : "実施日なし";
    return `${date} / ${priority}`;
  }

  function applyConflictMode(task, conflicts, context, mode) {
    if (mode === "new-available") {
      task.priority = findAvailablePriority(task.actionDate, task.id, [task.priority]);
      return true;
    }
    if (mode === "move-existing") {
      conflicts.forEach((existing) => {
        existing.actionDate = context.moveDate;
        existing.priority = context.movePriority;
        existing.updatedAt = nowIso();
      });
      return true;
    }
    return false;
  }

  function findPriorityConflicts(task) {
    if (!task.actionDate || !SINGLE_SLOT_PRIORITIES.includes(task.priority) || task.status !== "active") return [];
    return getPriorityOccupants(task.actionDate, task.priority, [task.id]);
  }

  function findAvailablePriority(actionDate, excludeId, extraUsed = []) {
    const used = new Set(app.state.tasks.filter((task) =>
      task.id !== excludeId &&
      task.status === "active" &&
      taskOccursOnDate(task, actionDate) &&
      SINGLE_SLOT_PRIORITIES.includes(task.priority)
    ).map((task) => task.priority));
    extraUsed.forEach((priority) => used.add(priority));
    return SINGLE_SLOT_PRIORITIES.find((priority) => !used.has(priority)) || "SUB";
  }

  function getPriorityOccupants(actionDate, priority, excludeIds = []) {
    const excluded = new Set(excludeIds.filter(Boolean));
    return app.state.tasks.filter((task) =>
      !excluded.has(task.id) &&
      task.status === "active" &&
      task.priority === priority &&
      taskOccursOnDate(task, actionDate)
    );
  }

  async function handleMemoSubmit(form) {
    await ensureRecordingStopped();
    const data = new FormData(form);
    const id = form.dataset.id || uid("memo");
    const existing = findById(app.state.memos, id);
    const body = String(data.get("body") || "").trim();
    const transcript = appendText(String(data.get("transcript") || "").trim(), app.pendingRecordingTranscript.trim()).trim();
    const recordings = [...(existing?.recordings || []), ...app.pendingRecordings];
    const now = nowIso();
    const memo = normalizeMemo({
      ...existing,
      id,
      title: String(data.get("title") || "").trim() || firstLine(body) || "メモ",
      body,
      agenda: String(data.get("agenda") || "").trim(),
      decisions: String(data.get("decisions") || "").trim(),
      nextActions: String(data.get("nextActions") || "").trim(),
      transcript,
      dueDate: String(data.get("dueDate") || ""),
      priority: String(data.get("priority") || "NONE"),
      departmentId: String(data.get("departmentId") || ""),
      projectId: String(data.get("projectId") || ""),
      taskIds: data.getAll("taskIds").map(String),
      recordings,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
    upsertById(app.state.memos, memo);
    syncTaskLinksForMemo(memo);
    await saveState();
    closeDialogs();
    render();
    showToast("メモを保存しました。");
  }

  async function handlePolicySubmit(form) {
    const data = new FormData(form);
    const id = form.dataset.id || uid("policy");
    const existing = findById(app.state.policies, id);
    const now = nowIso();
    upsertById(app.state.policies, {
      ...existing,
      id,
      title: String(data.get("title") || "").trim(),
      type: normalizePolicyType(data.get("type") || "方針"),
      periodStart: String(data.get("periodStart") || ""),
      periodEnd: String(data.get("periodEnd") || ""),
      departmentId: String(data.get("departmentId") || ""),
      background: String(data.get("background") || "").trim(),
      policy: String(data.get("policy") || "").trim(),
      actions: String(data.get("actions") || "").trim(),
      notes: String(data.get("notes") || "").trim(),
      taskIds: existing?.taskIds || [],
      memoIds: existing?.memoIds || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
    await saveState();
    closeDialogs();
    render();
    showToast("方針を保存しました。");
  }

  async function toggleTask(id, date = "") {
    const task = findById(app.state.tasks, id);
    if (!task) return;
    if (hasRecurrence(task) && date && taskOccursOnDate(task, date)) {
      const dates = new Set(task.completedDates || []);
      if (dates.has(date)) dates.delete(date);
      else dates.add(date);
      task.completedDates = [...dates].sort();
      task.updatedAt = nowIso();
      await saveState();
      render();
      return;
    }
    if (task.status === "completed") {
      task.status = "active";
      task.completedAt = null;
    } else {
      task.status = "completed";
      task.completedAt = nowIso();
    }
    task.updatedAt = nowIso();
    await saveState();
    render();
  }

  function openTaskDeleteConfirm(id) {
    const task = findById(app.state.tasks, id);
    if (!task) return;
    openSheet(`
      <div class="sheet sheet-compact">
        ${renderSheetHeader("タスク削除", "このタスクを削除します。削除済みから戻すことはできます。")}
        <p class="body-preview">${escapeHtml(task.title || "タスク")}</p>
        <div class="form-actions">
          <button class="text-button" type="button" data-action="close-dialog">キャンセル</button>
          <button class="danger-button" type="button" data-action="confirm-delete-task" data-id="${escapeAttr(id)}">削除</button>
        </div>
      </div>
    `);
  }

  async function moveTaskToToday(id) {
    const task = findById(app.state.tasks, id);
    if (!task) return;
    if (!SINGLE_SLOT_PRIORITIES.includes(task.priority) && task.priority !== "SUB") {
      openTodayPriorityDialog(task);
      return;
    }
    await assignTaskToToday(id, task.priority || "SUB");
  }

  function openTodayPriorityDialog(task) {
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader("今日の優先度を選択", "今日のタスクに入れるため、優先度を選んでください。")}
        <div class="choice-grid">
          ${["P1", "P2", "P3", "SUB"].map((priority) => `
            <button class="choice-button" type="button" data-action="assign-today-priority" data-id="${escapeAttr(task.id)}" data-priority="${priority}">
              <strong>${priorityMeta[priority].label}</strong>
              <span>${escapeHtml(task.title)}</span>
            </button>
          `).join("")}
        </div>
      </div>
    `);
  }

  async function assignTaskToToday(id, priority) {
    const existing = findById(app.state.tasks, id);
    if (!existing) return;
    const task = normalizeTask({
      ...existing,
      actionDate: todayIso(),
      priority: priorityMeta[priority] ? priority : "SUB",
      updatedAt: nowIso()
    });
    closeDialogs();
    await saveTaskWithConflict(task, {
      originalActionDate: existing.actionDate || "",
      originalPriority: existing.priority || ""
    });
  }

  async function duplicateTask(id) {
    const task = findById(app.state.tasks, id);
    if (!task) return;
    const now = nowIso();
    const copy = normalizeTask({
      ...task,
      id: uid("task"),
      title: `${task.title} コピー`,
      status: "active",
      completedAt: null,
      createdAt: now,
      updatedAt: now
    });
    app.state.tasks.push(copy);
    await saveState();
    render();
    showToast("タスクを複製しました。");
  }

  async function deleteEntity(collection, id, message) {
    const item = findById(app.state[collection], id);
    if (!item) return;
    addDeletedItem(collection, item);
    app.state[collection] = app.state[collection].filter((item) => item.id !== id);
    if (collection === "tasks") {
      app.state.memos.forEach((memo) => {
        memo.taskIds = memo.taskIds.filter((taskId) => taskId !== id);
      });
    }
    await saveState();
    render();
    showToast(message);
  }

  async function deleteMemo(id) {
    const memo = findById(app.state.memos, id);
    if (!memo) return;
    addDeletedItem("memos", memo);
    app.state.memos = app.state.memos.filter((memo) => memo.id !== id);
    app.state.tasks.forEach((task) => {
      task.memoIds = task.memoIds.filter((memoId) => memoId !== id);
    });
    await saveState();
    render();
    showToast("メモを削除しました。");
  }

  function addDeletedItem(kind, item) {
    app.state.deletedItems.unshift(normalizeDeletedItem({
      id: uid("deleted"),
      kind,
      title: entityTitle(kind, item),
      deletedAt: nowIso(),
      item: cloneForStorage(item)
    }));
    app.state.deletedItems = app.state.deletedItems.slice(0, 200);
  }

  async function restoreDeletedItem(id) {
    const deleted = findById(app.state.deletedItems, id);
    if (!deleted) return;
    const kind = deleted.kind;
    if (kind === "tasks") {
      const task = normalizeTask(deleted.item);
      upsertById(app.state.tasks, task);
      syncMemoLinksForTask(task);
    }
    if (kind === "memos") {
      const memo = normalizeMemo(deleted.item);
      upsertById(app.state.memos, memo);
      syncTaskLinksForMemo(memo);
    }
    if (kind === "policies") {
      upsertById(app.state.policies, normalizePolicy(deleted.item));
    }
    app.state.deletedItems = app.state.deletedItems.filter((item) => item.id !== id);
    await saveState();
    closeDialogs();
    render();
    openSettings();
    showToast("削除済みから戻しました。");
  }

  async function purgeDeletedItem(id) {
    app.state.deletedItems = app.state.deletedItems.filter((item) => item.id !== id);
    await saveState();
    closeDialogs();
    render();
    openSettings();
    showToast("削除済み項目を完全削除しました。");
  }

  function entityTitle(kind, item) {
    if (kind === "projects") return item.name || "プロジェクト";
    if (kind === "departments") return item.name || CLASSIFICATION_LABEL;
    return item.title || item.name || "項目";
  }

  function cloneForStorage(item) {
    if (typeof structuredClone === "function") return structuredClone(item);
    return JSON.parse(JSON.stringify(item));
  }

  function classifyMemoForm() {
    const form = document.getElementById("memoForm");
    if (!form) return;
    const body = String(form.elements.body?.value || "");
    const transcript = String(form.elements.transcript?.value || "");
    const organized = organizeText([body, transcript].filter(Boolean).join("\n"));
    if (!form.elements.title.value.trim()) form.elements.title.value = organized.title;
    form.elements.agenda.value = organized.agenda;
    form.elements.decisions.value = organized.decisions;
    form.elements.nextActions.value = organized.nextActions;
    showToast("本文と文字起こしから判定しました。保存前に確認してください。");
  }

  function openTaskFromMemo(id) {
    const memo = findById(app.state.memos, id);
    if (!memo) return;
    openTaskForm(null, {
      title: memo.nextActions || memo.title,
      dueDate: memo.dueDate,
      priority: memo.priority,
      departmentId: memo.departmentId,
      projectId: memo.projectId,
      memoIds: [memo.id]
    });
    const form = document.getElementById("taskForm");
    if (!form) return;
    form.elements.title.value = memo.nextActions || memo.title || "メモから作成";
    form.elements.dueDate.value = memo.dueDate || "";
    form.elements.priority.value = memo.priority || "NONE";
    form.elements.departmentId.value = memo.departmentId || "";
    form.elements.projectId.value = memo.projectId || "";
    [...form.elements.memoIds.options].forEach((option) => {
      option.selected = option.value === memo.id;
    });
    updateTaskPriorityPreview(form);
  }

  async function saveQuickMemo() {
    await ensureRecordingStopped();
    const textarea = document.getElementById("quickMemoText");
    const body = textarea?.value.trim() || "";
    const transcript = app.pendingRecordingTranscript.trim();
    const recordings = [...app.pendingRecordings];
    if (!body && !transcript && !recordings.length) {
      showToast("本文または録音を入力してください。");
      return;
    }
    const now = nowIso();
    app.state.memos.unshift(normalizeMemo({
      id: uid("memo"),
      title: firstLine(body) || firstLine(transcript) || "録音メモ",
      body,
      transcript,
      recordings,
      createdAt: now,
      updatedAt: now
    }));
    textarea.value = "";
    app.pendingRecordings = [];
    app.pendingRecordingTranscript = "";
    updateTranscriptPreview("");
    await saveState();
    render();
    showToast("走り書きメモを保存しました。");
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      showToast("このブラウザでは録音に対応していません。");
      return;
    }
    try {
      app.recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      app.recordingChunks = [];
      app.mediaRecorder = new MediaRecorder(app.recordingStream);
      app.recordingStartedAt = Date.now();
      const textarea = document.getElementById("quickMemoText") || document.getElementById("memoBody") || document.getElementById("memoTranscript");
      app.recordingBaseText = textarea?.value.trim() || "";
      app.recordingTranscript = "";
      app.recordingInterimTranscript = "";
      updateTranscriptPreview(getRecordingPreviewText());
      app.mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) app.recordingChunks.push(event.data);
      });
      app.recordingStopPromise = new Promise((resolve) => {
        app.recordingStopResolve = resolve;
      });
      app.mediaRecorder.addEventListener("stop", finalizeStoppedRecording);
      app.mediaRecorder.start();
      const transcriptionStarted = startTranscription({ recording: true });
      updateRecordingButtons(transcriptionStarted ? "録音中 / 文字起こし中" : "録音中（文字起こし非対応）");
    } catch {
      showToast("録音を開始できませんでした。マイク権限を確認してください。");
    }
  }

  async function stopRecording() {
    stopTranscription();
    if (app.mediaRecorder && app.mediaRecorder.state !== "inactive") {
      try {
        app.mediaRecorder.requestData?.();
      } catch {}
      app.mediaRecorder.stop();
      stopRecordingStream();
      updateRecordingButtons("録音を停止しています");
      return app.recordingStopPromise;
    }
    stopRecordingStream();
    return app.recordingStopPromise || Promise.resolve();
  }

  async function ensureRecordingStopped() {
    if (app.mediaRecorder && app.mediaRecorder.state !== "inactive") {
      await stopRecording();
      return;
    }
    if (app.recordingStopPromise) await app.recordingStopPromise;
  }

  async function finalizeStoppedRecording() {
    await wait(300);
    const mimeType = app.mediaRecorder?.mimeType || "audio/webm";
    const blob = new Blob(app.recordingChunks, { type: mimeType });
    const transcript = appendText(app.recordingTranscript, app.recordingInterimTranscript).trim();
    const durationSeconds = Math.round((Date.now() - app.recordingStartedAt) / 1000);
    if (blob.size) {
      app.pendingRecordings.push({
        id: uid("audio"),
        name: `${formatLongDate(todayIso())} ${durationSeconds}秒`,
        mimeType,
        durationSeconds,
        blob,
        createdAt: nowIso()
      });
    }
    if (transcript) {
      app.pendingRecordingTranscript = appendText(app.pendingRecordingTranscript, transcript);
    }
    stopRecordingStream();
    app.mediaRecorder = null;
    app.recordingChunks = [];
    app.recordingStartedAt = 0;
    app.recordingBaseText = "";
    app.recordingTranscript = "";
    app.recordingInterimTranscript = "";
    updateTranscriptPreview(getRecordingPreviewText());
    updateRecordingButtons(app.pendingRecordings.length ? "録音停止済み（保存待ち）" : "");
    app.recordingStopResolve?.();
    app.recordingStopPromise = null;
    app.recordingStopResolve = null;
    showToast("録音を停止しました。保存するとメモに入ります。");
  }

  function startTranscription(options = {}) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast("このブラウザでは文字起こしに対応していません。iPhoneの音声入力も使えます。");
      updateRecordingButtons(app.mediaRecorder ? "録音中（文字起こし非対応）" : "");
      return false;
    }
    const textarea = document.getElementById("quickMemoText") || document.getElementById("memoBody") || document.getElementById("memoTranscript");
    const recognition = new SpeechRecognition();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.addEventListener("result", (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const text = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalText += text;
        else interimText += text;
      }
      if (finalText && textarea) {
        if (options.recording) {
          app.recordingTranscript = appendText(app.recordingTranscript, finalText);
          app.recordingInterimTranscript = "";
          updateTranscriptPreview(getRecordingPreviewText());
        } else {
          textarea.value = `${textarea.value}${textarea.value ? "\n" : ""}${finalText}`;
        }
      }
      if (options.recording) {
        app.recordingInterimTranscript = interimText.trim();
        updateTranscriptPreview(getRecordingPreviewText());
      }
      updateRecordingButtons(options.recording
        ? (interimText ? `録音中: ${interimText}` : "録音中 / 文字起こし中")
        : (interimText ? `文字起こし中: ${interimText}` : "文字起こし中"));
    });
    recognition.addEventListener("end", () => {
      if (app.recognition === recognition) app.recognition = null;
      updateRecordingButtons();
    });
    try {
      recognition.start();
      app.recognition = recognition;
      updateRecordingButtons(options.recording ? "録音中 / 文字起こし中" : "文字起こし中");
      return true;
    } catch {
      app.recognition = null;
      updateRecordingButtons(app.mediaRecorder ? "録音中（文字起こし開始失敗）" : "");
      showToast("文字起こしを開始できませんでした。");
      return false;
    }
  }

  function stopTranscription(options = {}) {
    const recognition = app.recognition;
    app.recognition = null;
    if (recognition) {
      try {
        if (options.abort && typeof recognition.abort === "function") recognition.abort();
        else recognition.stop();
      } catch {}
    }
    updateRecordingButtons();
  }

  function updateRecordingButtons(status = "") {
    const isRecording = app.mediaRecorder && app.mediaRecorder.state !== "inactive";
    const isRecognizing = Boolean(app.recognition);
    document.querySelectorAll('[data-action="start-recording"]').forEach((button) => { button.disabled = isRecording; });
    document.querySelectorAll('[data-action="stop-recording"]').forEach((button) => { button.disabled = !isRecording; });
    document.querySelectorAll('[data-action="start-transcription"]').forEach((button) => { button.disabled = isRecognizing; });
    document.querySelectorAll('[data-action="stop-transcription"]').forEach((button) => { button.disabled = !isRecognizing; });
    const hasPendingRecording = app.pendingRecordings.length || app.pendingRecordingTranscript.trim();
    document.querySelectorAll("[data-recording-status]").forEach((statusEl) => {
      statusEl.textContent = status || (isRecording ? "録音中 / 文字起こし中" : (hasPendingRecording ? "録音停止済み（保存待ち）" : "録音待機中"));
    });
  }

  function updateTranscriptPreview(text) {
    const clean = String(text || "").trim();
    document.querySelectorAll("[data-recording-transcript-preview]").forEach((preview) => {
      preview.textContent = clean ? `文字起こし: ${truncate(clean, 260)}` : "";
      preview.classList.toggle("hidden", !clean);
    });
  }

  function resetRecordingDraft() {
    stopTranscription({ abort: true });
    stopRecordingStream();
    app.mediaRecorder = null;
    app.recordingChunks = [];
    app.recordingStartedAt = 0;
    app.recordingBaseText = "";
    app.recordingTranscript = "";
    app.recordingInterimTranscript = "";
    app.pendingRecordings = [];
    app.pendingRecordingTranscript = "";
    app.recordingStopPromise = null;
    app.recordingStopResolve = null;
    updateTranscriptPreview("");
    updateRecordingButtons();
  }

  function stopRecordingStream() {
    app.recordingStream?.getTracks().forEach((track) => track.stop());
    app.recordingStream = null;
  }

  function stopAudioCaptureImmediately() {
    if (app.recognition) stopTranscription({ abort: true });
    if (app.mediaRecorder && app.mediaRecorder.state !== "inactive") {
      try {
        app.mediaRecorder.requestData?.();
        app.mediaRecorder.stop();
      } catch {}
    }
    stopRecordingStream();
  }

  function appendText(base, addition) {
    const left = String(base || "").trim();
    const right = String(addition || "").trim();
    if (!left) return right;
    if (!right) return left;
    return `${left}\n${right}`;
  }

  function getRecordingPreviewText() {
    return appendText(appendText(app.pendingRecordingTranscript, app.recordingTranscript), app.recordingInterimTranscript);
  }

  function getMemoPreviewText(memo) {
    return memo.body || memo.transcript || memo.decisions || memo.nextActions || memo.agenda || "";
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function changeMonth(delta) {
    const current = parseMonthKey(app.state.ui.calendarMonth || monthKey(new Date()));
    const next = new Date(current.year, current.month + delta, 1);
    app.state.ui.calendarMonth = monthKey(next);
    await saveState();
    render();
  }

  async function selectDay(date) {
    app.state.ui.selectedDate = date;
    await saveState();
    render();
  }

  function openSettings() {
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader("設定", "設定は下部タブから外し、今日を中央に固定しています。")}
        <form id="settingsForm" class="settings-grid">
          <section class="settings-block">
            <label class="toolbar">
              <input name="showCompleted" type="checkbox" ${app.state.settings.showCompleted ? "checked" : ""}>
              完了済みを表示
            </label>
            <label class="toolbar">
              <input name="showLinkedMemos" type="checkbox" ${app.state.settings.showLinkedMemos ? "checked" : ""}>
              タスクにメモ要約を表示
            </label>
          </section>
          <section class="settings-block">
            <div class="section-head">
              <h2 class="section-title">${CLASSIFICATION_LABEL}</h2>
              <button class="mini-button" type="button" data-action="add-department">追加</button>
            </div>
            <div class="list-editor" id="departmentRows">
              ${app.state.departments.map((department) => renderDepartmentRow(department)).join("")}
            </div>
          </section>
          <section class="settings-block">
            <div class="section-head">
              <h2 class="section-title">プロジェクト</h2>
              <button class="mini-button" type="button" data-action="add-project">追加</button>
            </div>
            <div class="list-editor" id="projectRows">
              ${app.state.projects.map((project) => renderProjectRow(project)).join("")}
            </div>
          </section>
          <section class="settings-block">
            <div class="section-head">
              <h2 class="section-title">データ</h2>
              <div class="card-actions">
                <button class="mini-button" type="button" data-action="export-json">バックアップJSON</button>
                <button class="mini-button" type="button" data-action="export-master-json">マスター上書き用JSON</button>
              </div>
            </div>
            <p class="body-preview">マスターJSONを選択または貼り付けると、この端末のローカルデータへ上書き反映できます。公開データファイル自体の更新は、ホスティング先へ配置し直します。</p>
            <div class="file-import-row">
              <label class="file-import-button" for="settingsImportFile">JSONファイルを選択</label>
              <input id="settingsImportFile" type="file" accept=".json,.csv,.txt,application/json,text/plain,text/csv">
            </div>
            <textarea id="settingsImportText" name="settingsImportText" placeholder="JSON / CSV / テキストを貼り付け"></textarea>
            <button class="ghost-button" type="button" data-action="run-import">内容を取り込む</button>
          </section>
          <section class="settings-block">
            <div class="section-head">
              <h2 class="section-title">削除済み</h2>
              <span class="section-count">${app.state.deletedItems.length}件</span>
            </div>
            ${renderDeletedItems()}
          </section>
          <div class="form-actions">
            <button class="solid-button" type="submit">設定を保存</button>
          </div>
        </form>
      </div>
    `);
  }

  function renderDeletedItems() {
    if (!app.state.deletedItems.length) return `<p class="body-preview">削除したタスク、メモ、方針はここにまとまります。</p>`;
    return `
      <div class="deleted-list">
        ${app.state.deletedItems.slice(0, 40).map((deleted) => `
          <div class="deleted-row">
            <div>
              <strong>${escapeHtml(deleted.title)}</strong>
              <span>${escapeHtml(deletedKindLabel(deleted.kind))} / ${formatLongDate(deleted.deletedAt.slice(0, 10))}</span>
            </div>
            <div class="card-actions">
              <button class="mini-button" type="button" data-action="restore-deleted-item" data-id="${escapeAttr(deleted.id)}">戻す</button>
              <button class="mini-button" type="button" data-action="purge-deleted-item" data-id="${escapeAttr(deleted.id)}">完全削除</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function deletedKindLabel(kind) {
    return ({ tasks: "タスク", memos: "メモ", policies: "方針" })[kind] || "項目";
  }

  function renderDepartmentRow(department) {
    return `
      <div class="list-row" data-row="department" data-id="${escapeAttr(department.id)}">
        <input name="departmentName" value="${escapeAttr(department.name)}" aria-label="分類名">
        <button class="mini-button" type="button" data-action="remove-settings-row">削除</button>
      </div>
    `;
  }

  function renderProjectRow(project) {
    return `
      <div class="list-row" data-row="project" data-id="${escapeAttr(project.id)}">
        <input name="projectName" value="${escapeAttr(project.name)}" aria-label="プロジェクト名">
        <button class="mini-button" type="button" data-action="remove-settings-row">削除</button>
      </div>
    `;
  }

  function addSettingsRow(type) {
    if (type === "department") {
      document.getElementById("departmentRows")?.insertAdjacentHTML("beforeend", renderDepartmentRow({ id: uid("dept"), name: "新しい分類" }));
    }
    if (type === "project") {
      document.getElementById("projectRows")?.insertAdjacentHTML("beforeend", renderProjectRow({ id: uid("project"), name: "新しいプロジェクト" }));
    }
  }

  async function handleSettingsSubmit(form) {
    const data = new FormData(form);
    const now = nowIso();
    app.state.settings.showCompleted = data.get("showCompleted") === "on";
    app.state.settings.showLinkedMemos = data.get("showLinkedMemos") === "on";
    app.state.departments = [...form.querySelectorAll('[data-row="department"]')].map((row, index) => ({
      id: row.dataset.id || uid("dept"),
      name: row.querySelector("input")?.value.trim() || "未名称",
      parentId: "",
      sortOrder: index + 1,
      createdAt: findById(app.state.departments, row.dataset.id)?.createdAt || now,
      updatedAt: now
    }));
    app.state.projects = [...form.querySelectorAll('[data-row="project"]')].map((row) => ({
      id: row.dataset.id || uid("project"),
      name: row.querySelector("input")?.value.trim() || "未名称",
      purpose: findById(app.state.projects, row.dataset.id)?.purpose || "",
      departmentId: findById(app.state.projects, row.dataset.id)?.departmentId || "",
      startDate: findById(app.state.projects, row.dataset.id)?.startDate || "",
      endDate: findById(app.state.projects, row.dataset.id)?.endDate || "",
      status: "active",
      createdAt: findById(app.state.projects, row.dataset.id)?.createdAt || now,
      updatedAt: now
    }));
    await saveState();
    closeDialogs();
    render();
    showToast("設定を保存しました。");
  }

  function openImportDialog() {
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader("貼り付け取り込み", "マスターJSONは上書き同期、それ以外のJSON / CSV / テキストは追加取り込みします。")}
        <form id="importForm" class="form-grid">
          <div class="field">
            <label for="importText">追加内容</label>
            <textarea id="importText" name="importText" required placeholder="JSON / CSV / Microsoft To Do のエクスポートテキスト"></textarea>
          </div>
          <div class="form-actions">
            <button class="solid-button" type="submit">取り込む</button>
          </div>
        </form>
      </div>
    `);
  }

  async function handleImportSubmit(form) {
    const text = String(new FormData(form).get("importText") || "");
    const result = await importText(text);
    closeDialogs();
    render();
    showToast(`${result.tasks}件のタスク、${result.memos}件のメモ、${result.policies || 0}件の方針を取り込みました。`);
  }

  async function runImportFromDialog() {
    const textarea = document.getElementById("settingsImportText");
    const text = textarea?.value || "";
    if (!text.trim()) {
      showToast("取り込む内容を貼り付けてください。");
      return;
    }
    const result = await importText(text);
    if (textarea) textarea.value = "";
    closeDialogs();
    render();
    showToast(`${result.tasks}件のタスク、${result.memos}件のメモ、${result.policies || 0}件の方針を取り込みました。`);
  }

  async function readImportFile(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const textarea = document.getElementById("settingsImportText");
      if (textarea) {
        textarea.value = text;
        textarea.focus();
      }
      showToast(`${file.name}を読み込みました。内容を確認して取り込めます。`);
    } catch (error) {
      showToast(`ファイルの読み込みに失敗しました: ${error.message}`);
    } finally {
      input.value = "";
    }
  }

  async function applyBundledTaskImport() {
    try {
      const response = await fetch(BUNDLED_TASK_IMPORT_URL, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const importId = String(payload.importId || "");
      if (!importId || app.state.settings.appliedTaskImportId === importId) return;

      if (payload.fullSync) {
        replaceStateFromMasterPayload(payload, importId);
        app.state.settings.appliedTaskImportId = importId;
        await saveState();
        showToast("マスターJSONでローカルデータを同期しました。");
        return;
      }

      const imported = importJson(JSON.stringify(payload));
      if (!imported.tasks.length) return;
      replaceTasksFromImport(imported.tasks, importId);
      upsertPoliciesFromImport(imported.policies);
      app.state.settings.appliedTaskImportId = importId;
      await saveState();
      showToast(`${imported.tasks.length}件のタスクを指定ファイルで上書きし、${imported.policies.length}件の方針を同期しました。`);
    } catch {
      // 同梱インポートは初期投入用。失敗しても通常利用は止めない。
    }
  }

  async function importText(raw) {
    const text = raw.trim();
    if (!text) return { tasks: 0, memos: 0 };
    let imported = { tasks: [], memos: [], policies: [] };
    try {
      if (/^[{[]/.test(text)) {
        const parsed = JSON.parse(text);
        if (isFullSyncMasterPayload(parsed)) {
          const importId = String(parsed.importId || `manual-${Date.now()}`);
          replaceStateFromMasterPayload(parsed, importId);
          app.state.settings.appliedTaskImportId = importId;
          await saveState();
          return {
            tasks: app.state.tasks.length,
            memos: app.state.memos.length,
            policies: app.state.policies.length
          };
        }
        imported = importJsonPayload(parsed);
      } else if (looksLikeCsv(text)) imported = importCsv(text);
      else imported = importTodoText(text);
    } catch (error) {
      showToast(`取り込みに失敗しました: ${error.message}`);
      return { tasks: 0, memos: 0 };
    }
    const now = nowIso();
    app.state.tasks.push(...normalizeImportedTasks(imported.tasks, now));
    imported.memos.forEach((memo) => app.state.memos.push(normalizeMemo({ ...memo, id: uid("memo"), createdAt: now, updatedAt: now })));
    upsertPoliciesFromImport(imported.policies, now);
    await saveState();
    return { tasks: imported.tasks.length, memos: imported.memos.length, policies: imported.policies.length };
  }

  function isFullSyncMasterPayload(payload) {
    return Boolean(
      payload &&
      !Array.isArray(payload) &&
      payload.fullSync === true &&
      (
        Array.isArray(payload.tasks) ||
        Array.isArray(payload.memos) ||
        Array.isArray(payload.policies) ||
        Array.isArray(payload.departments)
      )
    );
  }

  function replaceTasksFromImport(tasks, importId) {
    const now = nowIso();
    app.state.lastTaskImportBackup = {
      importId,
      createdAt: now,
      tasks: app.state.tasks,
      memoTaskIds: app.state.memos
        .filter((memo) => memo.taskIds?.length)
        .map((memo) => ({ memoId: memo.id, taskIds: [...memo.taskIds] }))
    };
    app.state.tasks = normalizeImportedTasks(tasks, now);
    app.state.memos.forEach((memo) => {
      if (!memo.taskIds?.length) return;
      memo.taskIds = [];
      memo.updatedAt = now;
    });
  }

  function upsertPoliciesFromImport(policies, now = nowIso()) {
    policies.forEach((policy) => {
      const normalized = {
        ...policy,
        id: policy.id || uid("policy"),
        title: policy.title || "方針",
        type: normalizePolicyType(policy.type || "方針"),
        periodStart: policy.periodStart || "",
        periodEnd: policy.periodEnd || "",
        departmentId: policy.departmentId || "",
        background: policy.background || "",
        policy: policy.policy || "",
        actions: policy.actions || "",
        notes: policy.notes || "",
        taskIds: Array.isArray(policy.taskIds) ? policy.taskIds : [],
        memoIds: Array.isArray(policy.memoIds) ? policy.memoIds : [],
        createdAt: policy.createdAt || now,
        updatedAt: now
      };
      const existing = app.state.policies.find((item) => item.title === normalized.title && item.type === normalized.type);
      if (existing) upsertById(app.state.policies, { ...existing, ...normalized, id: existing.id, createdAt: existing.createdAt || normalized.createdAt });
      else app.state.policies.push(normalized);
    });
  }

  function replaceStateFromMasterPayload(payload, importId) {
    const now = nowIso();
    app.state.lastFullSyncBackup = {
      importId,
      createdAt: now,
      tasks: app.state.tasks,
      memos: app.state.memos,
      policies: app.state.policies,
      departments: app.state.departments,
      projects: app.state.projects
    };
    if (payload.settings && typeof payload.settings === "object") {
      app.state.settings = {
        ...app.state.settings,
        ...payload.settings,
        appliedTaskImportId: importId
      };
    }
    app.state.tasks = Array.isArray(payload.tasks) ? payload.tasks.map(normalizeTask) : app.state.tasks;
    app.state.memos = Array.isArray(payload.memos) ? payload.memos.map(normalizeMemo) : app.state.memos;
    app.state.policies = Array.isArray(payload.policies) ? payload.policies.map(normalizePolicy) : app.state.policies;
    app.state.departments = normalizeDepartments(payload.departments, app.state.departments);
    app.state.projects = Array.isArray(payload.projects) ? payload.projects : app.state.projects;
    app.state.deletedItems = Array.isArray(payload.deletedItems) ? payload.deletedItems.map(normalizeDeletedItem) : app.state.deletedItems;
    app.state.updatedAt = now;
  }

  function normalizeImportedTasks(tasks, now) {
    return tasks.map((task) => normalizeTask({
      ...task,
      id: uid("task"),
      status: task.status || "active",
      completedAt: task.status === "completed" ? (task.completedAt || now) : (task.completedAt || null),
      createdAt: now,
      updatedAt: now
    }));
  }

  function importJson(text) {
    return importJsonPayload(JSON.parse(text));
  }

  function importJsonPayload(parsed) {
    const source = Array.isArray(parsed) ? { tasks: parsed } : parsed;
    return {
      tasks: (source.tasks || []).map((task) => ({
        title: task.title || task.name || task.task || "",
        description: task.description || task.body || task.content || "",
        assignee: task.assignee || task.owner || task["担当者"] || "",
        actionDate: toDateInputValueFromUnknown(task.actionDate || task.date || task.実施日),
        dueDate: toDateInputValueFromUnknown(task.dueDate || task.dl || task.DL || task.期限日),
        priority: normalizePriority(task.priority || task.優先度),
        status: task.status || task.状態 || "active",
        completedAt: task.completedAt || null,
        departmentId: matchDepartmentId(task.department || task.departmentName || task.category || task.categoryName || task.分類 || task.部門),
        projectId: matchProjectId(task.project || task.projectName || task.プロジェクト)
      })).filter((task) => task.title),
      memos: (source.memos || source.notes || []).map((memo) => ({
        title: memo.title || firstLine(memo.body || memo.content) || "メモ",
        body: memo.body || memo.content || "",
        agenda: memo.agenda || memo.議題 || "",
        decisions: memo.decisions || memo.決定 || "",
        nextActions: memo.nextActions || memo.次 || "",
        transcript: memo.transcript || memo.文字起こし || "",
        dueDate: toDateInputValueFromUnknown(memo.dueDate || memo.DL || memo.期限),
        priority: normalizePriority(memo.priority || memo.優先度),
        departmentId: matchDepartmentId(memo.department || memo.departmentName || memo.category || memo.categoryName || memo.分類 || memo.部門),
        projectId: matchProjectId(memo.project || memo.projectName || memo.プロジェクト)
      })).filter((memo) => memo.body || memo.title),
      policies: (source.policies || []).map((policy) => ({
        title: policy.title || policy.name || policy.タイトル || "方針",
        type: normalizePolicyType(policy.type || policy.種別 || "方針"),
        periodStart: toDateInputValueFromUnknown(policy.periodStart || policy.start || policy.開始),
        periodEnd: toDateInputValueFromUnknown(policy.periodEnd || policy.end || policy.終了),
        departmentId: matchDepartmentId(policy.department || policy.departmentName || policy.category || policy.categoryName || policy.分類 || policy.部門),
        background: policy.background || policy.背景 || "",
        policy: policy.policy || policy.body || policy.content || policy.方針 || "",
        actions: policy.actions || policy.やること || "",
        notes: policy.notes || policy.注意点 || ""
      })).filter((policy) => policy.title || policy.policy)
    };
  }

  function importCsv(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift()).map((header) => header.trim());
    const tasks = lines.map((line) => {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
      return {
        title: row.title || row.タスク名 || row.name || row.件名,
        description: row.description || row.内容 || "",
        assignee: row.assignee || row.owner || row["担当者"] || "",
        actionDate: toDateInputValueFromUnknown(row.actionDate || row.実施日 || row.date),
        dueDate: toDateInputValueFromUnknown(row.dueDate || row.DL || row.期限日),
        priority: normalizePriority(row.priority || row.優先度),
        departmentId: matchDepartmentId(row.department || row.category || row.分類 || row.部門),
        projectId: matchProjectId(row.project || row.プロジェクト)
      };
    }).filter((task) => task.title);
    return { tasks, memos: [], policies: [] };
  }

  function importTodoText(text) {
    const tasks = [];
    const policies = [];
    let current = null;
    text.split(/\r?\n/).forEach((line) => {
      const taskMatch = line.match(/^\s*([◯○✔✓])\s*(.+)$/);
      const childMatch = line.match(/^\s*[◦・]\s*(.+)$/);
      if (taskMatch) {
        current = parseTodoLine(taskMatch[2]);
        if (looksLikePolicyLine(current.title)) {
          policies.push(policyFromTodoLine(current));
          current = null;
          return;
        }
        if (/[✔✓]/.test(taskMatch[1])) {
          current.status = "completed";
          current.completedAt = nowIso();
        }
        tasks.push(current);
        return;
      }
      if (childMatch && current) {
        current.description = `${current.description ? `${current.description}\n` : ""}${childMatch[1].trim()}`;
      }
    });
    return { tasks, memos: [], policies };
  }

  function parseTodoLine(rawTitle) {
    let title = rawTitle.replace(/\s*★\s*$/g, "").trim();
    const finalDate = title.match(/\s*[（(]((?:今日|明日|昨日)|\d{1,2}月\d{1,2}日?)(?:[（(][^）)]*[）)])?[）)]\s*$/u);
    let actionDate = "";
    if (finalDate) {
      actionDate = parseJapaneseDate(finalDate[1]);
      title = title.slice(0, finalDate.index).trim();
    }
    const dueToken = title.match(/\bDL[:：]?\s*(\d{4}|\d{1,2}[\/月]\d{1,2}|\d{1,2}月\d{1,2}日?)(?:[（(][^）)]*[）)])?/i);
    const dueParts = dueToken ? parseDueToken(dueToken[1]) : null;
    const dueDate = dueParts ? dateFromMonthDay(dueParts.month, dueParts.day) : "";
    if (dueToken) title = title.replace(dueToken[0], "").trim();
    const priority = normalizePriority(title);
    title = title.replace(/^(最優先|2次優先|3次優先|サブタスク)\s*/u, "").trim();
    return {
      title,
      description: "",
      actionDate,
      dueDate,
      priority
    };
  }

  function looksLikePolicyLine(title) {
    return /方針|で進める|判断材料|商売計画|売場/.test(String(title || ""));
  }

  function policyFromTodoLine(item) {
    const text = item.title || "";
    const split = text.match(/^(.+?方針)\s+(.+)$/u);
    const title = split ? split[1].trim() : text;
    const policy = split ? split[2].trim() : text;
    return {
      title,
      type: /在庫|倉庫/.test(text) ? "在庫" : (/エンド|売場|フェイス/.test(text) ? "売場" : "方針"),
      periodStart: item.actionDate || "",
      periodEnd: /今後2か月/.test(text) ? addMonths(item.actionDate || todayIso(), 2) : "",
      policy,
      actions: "",
      notes: ""
    };
  }

  function parseDueToken(token) {
    const compact = String(token).match(/^(\d{2})(\d{2})$/);
    if (compact) return { month: compact[1], day: compact[2] };
    const separated = String(token).match(/^(\d{1,2})[\/月](\d{1,2})/);
    if (separated) return { month: separated[1], day: separated[2] };
    return null;
  }

  function looksLikeCsv(text) {
    const first = text.split(/\r?\n/)[0] || "";
    return first.includes(",") && /(title|タスク|件名|name|実施|DL|期限)/i.test(first);
  }

  function parseCsvLine(line) {
    const values = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current);
    return values;
  }

  function exportJson() {
    downloadJson(buildPortableState(), `claris-export-${todayIso()}.json`);
  }

  function exportMasterJson() {
    downloadJson({
      ...buildPortableState(),
      importId: `manual-${Date.now()}`,
      fullSync: true
    }, `claris-master-${todayIso()}.json`);
  }

  function buildPortableState() {
    return {
      ...app.state,
      memos: app.state.memos.map((memo) => ({
        ...memo,
        recordings: (memo.recordings || []).map((recording) => ({
          id: recording.id,
          name: recording.name,
          mimeType: recording.mimeType,
          durationSeconds: recording.durationSeconds,
          createdAt: recording.createdAt,
          blobOmitted: true
        }))
      })),
      deletedItems: app.state.deletedItems.map((deleted) => ({
        ...deleted,
        item: sanitizePortableEntity(deleted.item)
      }))
    };
  }

  function sanitizePortableEntity(item) {
    if (!item || typeof item !== "object") return item;
    if (!Array.isArray(item.recordings)) return item;
    return {
      ...item,
      recordings: item.recordings.map((recording) => ({
        id: recording.id,
        name: recording.name,
        mimeType: recording.mimeType,
        durationSeconds: recording.durationSeconds,
        createdAt: recording.createdAt,
        blobOmitted: true
      }))
    };
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function openSheet(html) {
    entityDialog.innerHTML = html;
    if (!entityDialog.open) entityDialog.showModal();
  }

  function renderSheetHeader(title, subtitle = "") {
    return `
      <div class="sheet-header">
        <div>
          <h2 class="sheet-title">${escapeHtml(title)}</h2>
          ${subtitle ? `<p class="sheet-subtitle">${escapeHtml(subtitle)}</p>` : ""}
        </div>
        <button class="icon-button" type="button" data-action="close-dialog" aria-label="閉じる">×</button>
      </div>
    `;
  }

  function closeDialogs() {
    if (entityDialog.open && entityDialog.querySelector("#memoForm")) {
      stopAudioCaptureImmediately();
      resetRecordingDraft();
    }
    if (entityDialog.open) entityDialog.close();
    if (conflictDialog.open) conflictDialog.close();
  }

  function renderPriorityOptions(current) {
    return Object.entries(priorityMeta).map(([value, meta]) =>
      `<option value="${value}"${selected(current, value)}>${meta.label}</option>`
    ).join("");
  }

  function renderDepartmentOptions(current) {
    return `<option value="">未設定</option>${app.state.departments.map((department) =>
      `<option value="${escapeAttr(department.id)}"${selected(current, department.id)}>${escapeHtml(department.name)}</option>`
    ).join("")}`;
  }

  function renderEntryFilterOptions(current) {
    return `
      <option value="all"${selected(current, "all")}>すべて</option>
      <option value="today"${selected(current, "today")}>今日</option>
      <option value="no-date"${selected(current, "no-date")}>実施日なし</option>
      <option value="due"${selected(current, "due")}>DLあり</option>
      <option value="no-dept"${selected(current, "no-dept")}>分類未設定</option>
      ${app.state.departments.map((department) =>
        `<option value="dept:${escapeAttr(department.id)}"${selected(current, `dept:${department.id}`)}>${CLASSIFICATION_LABEL}: ${escapeHtml(department.name)}</option>`
      ).join("")}
      ${app.state.projects.map((project) =>
        `<option value="project:${escapeAttr(project.id)}"${selected(current, `project:${project.id}`)}>PJ: ${escapeHtml(project.name)}</option>`
      ).join("")}
    `;
  }

  function renderProjectOptions(current) {
    return `<option value="">未設定</option>${app.state.projects.map((project) =>
      `<option value="${escapeAttr(project.id)}"${selected(current, project.id)}>${escapeHtml(project.name)}</option>`
    ).join("")}`;
  }

  function renderMemoOptions(currentIds) {
    return app.state.memos.map((memo) =>
      `<option value="${escapeAttr(memo.id)}"${currentIds.includes(memo.id) ? " selected" : ""}>${escapeHtml(memo.title)}</option>`
    ).join("");
  }

  function renderTaskOptions(currentIds) {
    return app.state.tasks.map((task) =>
      `<option value="${escapeAttr(task.id)}"${currentIds.includes(task.id) ? " selected" : ""}>${escapeHtml(task.title)}</option>`
    ).join("");
  }

  function renderTaskPicker(currentIds) {
    const current = new Set(currentIds || []);
    const tasks = sortTasksByActionDate(app.state.tasks).sort((a, b) =>
      Number(current.has(b.id)) - Number(current.has(a.id))
    );
    return `
      <div class="task-picker">
        <input id="memoTaskSearch" type="search" data-task-search placeholder="タスク名で検索（ひらがな/カタカナ対応）" autocomplete="off">
        <div class="task-picker-list" data-task-picker-list>
          ${tasks.map((task) => {
            const meta = [
              task.actionDate ? `実施 ${formatShortDate(task.actionDate)}` : "",
              task.dueDate ? `DL ${formatShortDate(task.dueDate)}` : "",
              task.assignee ? `担当 ${task.assignee}` : ""
            ].filter(Boolean).join(" / ");
            return `
              <label class="task-picker-item ${current.has(task.id) ? "is-linked" : ""}" data-search-text="${escapeAttr(normalizeSearchText(`${task.title} ${meta}`))}">
                <input type="checkbox" name="taskIds" value="${escapeAttr(task.id)}"${current.has(task.id) ? " checked" : ""}>
                <span>
                  <strong>${escapeHtml(task.title)}</strong>
                  ${current.has(task.id) ? `<small>現在紐付け中</small>` : ""}
                  ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
                </span>
              </label>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function filterTaskPicker(input) {
    const picker = input.closest(".task-picker");
    const query = normalizeSearchText(input.value);
    picker?.querySelectorAll("[data-search-text]").forEach((item) => {
      const matches = !query || item.dataset.searchText.includes(query);
      item.classList.toggle("hidden", !matches);
    });
  }

  function selected(current, value) {
    return String(current || "") === String(value || "") ? " selected" : "";
  }

  function sortTasks(tasks) {
    const order = { P1: 1, P2: 2, P3: 3, SUB: 4, NONE: 5 };
    return [...tasks].sort((a, b) =>
      (order[a.priority] || 9) - (order[b.priority] || 9) ||
      String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31")) ||
      String(a.createdAt).localeCompare(String(b.createdAt))
    );
  }

  function sortTasksByActionDate(tasks) {
    const order = { P1: 1, P2: 2, P3: 3, SUB: 4, NONE: 5 };
    return [...tasks].sort((a, b) =>
      String(a.actionDate || "9999-12-31").localeCompare(String(b.actionDate || "9999-12-31")) ||
      (order[a.priority] || 9) - (order[b.priority] || 9) ||
      String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31")) ||
      String(a.createdAt).localeCompare(String(b.createdAt))
    );
  }

  function sortCalendarTasks(tasks) {
    return sortTasksByActionDate(tasks).sort((a, b) =>
      Number(Boolean(b.dueDate)) - Number(Boolean(a.dueDate))
    );
  }

  function hasRecurrence(task) {
    return task?.recurrence?.type && task.recurrence.type !== "none";
  }

  function taskOccursOnDate(task, date) {
    if (task.actionDate === date) return true;
    if (!hasRecurrence(task)) return false;
    return recurrenceMatchesDate(task, date);
  }

  function isTaskCompletedForDate(task, date = "") {
    if (hasRecurrence(task) && date && taskOccursOnDate(task, date)) {
      return (task.completedDates || []).includes(date);
    }
    if (task.status !== "completed") return false;
    if (!date) return true;
    return task.completedAt?.startsWith(date) || task.actionDate === date;
  }

  function recurrenceMatchesDate(task, date) {
    const recurrence = normalizeRecurrence(task.recurrence);
    if (recurrence.type === "none") return false;
    if (recurrence.type === "custom") return recurrence.customDates.includes(date);

    const start = task.actionDate || task.createdAt?.slice(0, 10) || todayIso();
    if (!isIsoDate(start) || !isIsoDate(date) || date < start) return false;
    const target = dateObject(date);
    const startDate = dateObject(start);

    if (recurrence.type === "weekly") {
      const weekdays = recurrence.weekdays.length ? recurrence.weekdays : [startDate.getDay()];
      if (!weekdays.includes(target.getDay())) return false;
      return Math.floor(daysBetween(start, date) / 7) % recurrence.interval === 0;
    }

    const monthDistance = monthsBetween(start, date);
    if (monthDistance % recurrence.interval !== 0) return false;

    if (recurrence.type === "monthly-day") {
      return target.getDate() === recurrence.monthDay;
    }
    if (recurrence.type === "monthly-end") {
      return target.getDate() === lastDayOfMonth(target.getFullYear(), target.getMonth());
    }
    if (recurrence.type === "monthly-nth") {
      return target.getDay() === recurrence.weekday && nthWeekdayOfMonth(target) === recurrence.ordinal;
    }
    return false;
  }

  function recurrenceLabel(task) {
    if (!hasRecurrence(task)) return "";
    const recurrence = normalizeRecurrence(task.recurrence);
    if (recurrence.type === "weekly") {
      const days = (recurrence.weekdays.length ? recurrence.weekdays : [dateObject(task.actionDate || todayIso()).getDay()])
        .map((day) => weekdayLabels[day])
        .join("");
      return `${recurrence.interval > 1 ? `${recurrence.interval}週ごと ` : ""}${days}曜`;
    }
    if (recurrence.type === "monthly-day") return `毎月${recurrence.monthDay}日`;
    if (recurrence.type === "monthly-end") return "毎月月末";
    if (recurrence.type === "monthly-nth") return `毎月第${recurrence.ordinal}${weekdayLabels[recurrence.weekday]}曜`;
    if (recurrence.type === "custom") return `カスタム${recurrence.customDates.length}日`;
    return recurrenceLabels[recurrence.type] || "";
  }

  function getLinkedMemos(task) {
    const ids = new Set(task.memoIds || []);
    return app.state.memos.filter((memo) => ids.has(memo.id) || memo.taskIds?.includes(task.id));
  }

  function shouldShowMemos(task, linkedMemos) {
    return linkedMemos.length && app.state.settings.showLinkedMemos && task.showLinkedMemos !== false;
  }

  function summarizeMemo(memo) {
    return memo.nextActions || memo.decisions || memo.agenda || truncate(memo.body, 70);
  }

  function syncMemoLinksForTask(task) {
    app.state.memos.forEach((memo) => {
      const has = task.memoIds.includes(memo.id);
      const includes = memo.taskIds.includes(task.id);
      if (has && !includes) memo.taskIds.push(task.id);
      if (!has && includes) memo.taskIds = memo.taskIds.filter((id) => id !== task.id);
    });
  }

  function syncTaskLinksForMemo(memo) {
    app.state.tasks.forEach((task) => {
      const has = memo.taskIds.includes(task.id);
      const includes = task.memoIds.includes(memo.id);
      if (has && !includes) task.memoIds.push(memo.id);
      if (!has && includes) task.memoIds = task.memoIds.filter((id) => id !== memo.id);
    });
  }

  function organizeText(body) {
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const decisions = [];
    const nextActions = [];
    const agenda = [];
    lines.forEach((line) => {
      if (/(決定|決ま|することに|方針|で進める)/.test(line)) decisions.push(line);
      else if (/(→|対応|確認|依頼|作成|送る|提出|DL|まで|次回|やる)/i.test(line)) nextActions.push(line);
      else agenda.push(line);
    });
    return {
      title: firstLine(body) || "メモ",
      agenda: agenda.slice(0, 3).join("\n"),
      decisions: decisions.join("\n"),
      nextActions: nextActions.join("\n")
    };
  }

  function isDateInPolicy(date, policy) {
    if (!policy.periodStart && !policy.periodEnd) return false;
    const start = policy.periodStart || "0000-01-01";
    const end = policy.periodEnd || "9999-12-31";
    return date >= start && date <= end;
  }

  function matchesCalendarTaskFilter(task, filter = "all") {
    if (!filter || filter === "all") return true;
    if (filter === "no-dept") return !task.departmentId;
    if (filter.startsWith("dept:")) return task.departmentId === filter.slice(5);
    if (filter.startsWith("project:")) return task.projectId === filter.slice(8);
    return true;
  }

  function matchesEntryItem(item, kind, filter = "all", query = "") {
    if (!matchesEntryFilter(item, kind, filter)) return false;
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return true;
    return normalizeSearchText(entrySearchText(item, kind)).includes(normalizedQuery);
  }

  function matchesEntryFilter(item, kind, filter = "all") {
    if (!filter || filter === "all") return true;
    if (filter === "today") {
      if (kind === "task") return item.actionDate === todayIso() || item.dueDate === todayIso();
      if (kind === "memo") return item.dueDate === todayIso();
      if (kind === "policy") return isDateInPolicy(todayIso(), item);
    }
    if (filter === "no-date") return kind === "task" ? !item.actionDate : true;
    if (filter === "due") return kind === "task" || kind === "memo" ? Boolean(item.dueDate) : false;
    if (filter === "no-dept") return !item.departmentId;
    if (filter.startsWith("dept:")) return item.departmentId === filter.slice(5);
    if (filter.startsWith("project:")) return kind !== "policy" && item.projectId === filter.slice(8);
    return true;
  }

  function entrySearchText(item, kind) {
    if (kind === "task") {
      return [item.title, item.description, item.assignee, item.actionDate, item.dueDate].filter(Boolean).join(" ");
    }
    if (kind === "memo") {
      return [item.title, item.body, item.agenda, item.decisions, item.nextActions, item.transcript].filter(Boolean).join(" ");
    }
    return [item.title, item.type, item.background, item.policy, item.actions, item.notes].filter(Boolean).join(" ");
  }

  function matchesCalendarPolicyFilter(policy, filter = "all") {
    if (!filter || filter === "all") return true;
    if (filter === "no-dept") return !policy.departmentId;
    if (filter.startsWith("dept:")) return policy.departmentId === filter.slice(5);
    if (filter.startsWith("project:")) return false;
    return true;
  }

  function matchesCalendarPeriodFilter(period, filter = "all") {
    if (!filter || filter === "all") return true;
    if (filter === "no-dept") return !period.departmentId;
    if (filter.startsWith("dept:")) return period.departmentId === filter.slice(5);
    if (filter.startsWith("project:")) return period.projectId === filter.slice(8);
    return true;
  }

  function getCalendarPeriodsForDate(date, filter = "all") {
    return getCalendarPeriods()
      .filter((period) => matchesCalendarPeriodFilter(period, filter))
      .filter((period) => date >= period.start && date <= period.end)
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title));
  }

  function getCalendarPeriods() {
    const policyPeriods = app.state.policies
      .filter((policy) => policy.periodStart || policy.periodEnd)
      .map((policy) => ({
        id: policy.id,
        title: policy.title,
        start: policy.periodStart || policy.periodEnd,
        end: policy.periodEnd || policy.periodStart,
        type: normalizePolicyType(policy.type || "方針"),
        summary: firstNonEmpty(policy.policy, policy.actions, policy.background, policy.notes, policy.title),
        source: "policy",
        departmentId: policy.departmentId || "",
        projectId: ""
      }));
    const projectPeriods = app.state.projects
      .filter((project) => project.startDate || project.endDate)
      .map((project) => ({
        id: project.id,
        title: project.name,
        start: project.startDate || project.endDate,
        end: project.endDate || project.startDate,
        type: "プロジェクト",
        summary: firstNonEmpty(project.purpose, project.name),
        source: "project",
        departmentId: project.departmentId || "",
        projectId: project.id
      }));
    return [...policyPeriods, ...projectPeriods].filter((period) => period.start && period.end);
  }

  function firstNonEmpty(...values) {
    return values.map((value) => String(value || "").trim()).find(Boolean) || "";
  }

  function stableIndex(value, modulo) {
    const text = String(value || "");
    let sum = 0;
    for (let index = 0; index < text.length; index += 1) sum += text.charCodeAt(index);
    return sum % modulo;
  }

  function buildCalendarDays(year, month) {
    const first = new Date(year, month, 1);
    const mondayBasedOffset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - mondayBasedOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return { date, inMonth: date.getMonth() === month };
    });
  }

  function parseMonthKey(key) {
    const [year, month] = key.split("-").map(Number);
    return { year, month: month - 1 };
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function todayIso() {
    return toDateInputValue(new Date());
  }

  function toDateInputValue(date) {
    const value = date instanceof Date ? date : new Date(date);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }

  function calendarDateClass(date) {
    const day = date.getDay();
    if (day === 0 || isJapaneseHoliday(date)) return "is-holiday";
    if (day === 6) return "is-saturday";
    return "is-weekday";
  }

  function isJapaneseHoliday(date) {
    return Boolean(getJapaneseHolidayName(date));
  }

  function getJapaneseHolidayName(value) {
    const date = value instanceof Date ? value : dateObject(value);
    if (Number.isNaN(date.getTime())) return "";
    return getBaseJapaneseHolidayName(date) || getSubstituteHolidayName(date) || getCitizensHolidayName(date);
  }

  function getBaseJapaneseHolidayName(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if (month === 1 && day === 1) return "元日";
    if (month === 1 && day === nthWeekdayDateOfMonth(year, 0, 1, 2)) return "成人の日";
    if (month === 2 && day === 11) return "建国記念の日";
    if (month === 2 && day === 23) return "天皇誕生日";
    if (month === 3 && day === springEquinoxDay(year)) return "春分の日";
    if (month === 4 && day === 29) return "昭和の日";
    if (month === 5 && day === 3) return "憲法記念日";
    if (month === 5 && day === 4) return "みどりの日";
    if (month === 5 && day === 5) return "こどもの日";
    if (month === 7 && day === nthWeekdayDateOfMonth(year, 6, 1, 3)) return "海の日";
    if (month === 8 && day === 11) return "山の日";
    if (month === 9 && day === nthWeekdayDateOfMonth(year, 8, 1, 3)) return "敬老の日";
    if (month === 9 && day === autumnEquinoxDay(year)) return "秋分の日";
    if (month === 10 && day === nthWeekdayDateOfMonth(year, 9, 1, 2)) return "スポーツの日";
    if (month === 11 && day === 3) return "文化の日";
    if (month === 11 && day === 23) return "勤労感謝の日";
    return "";
  }

  function getSubstituteHolidayName(date) {
    if (date < new Date("1973-04-12T00:00:00")) return "";
    const cursor = new Date(date);
    cursor.setDate(cursor.getDate() - 1);
    let hasSundayHoliday = false;
    while (getBaseJapaneseHolidayName(cursor)) {
      if (cursor.getDay() === 0) hasSundayHoliday = true;
      cursor.setDate(cursor.getDate() - 1);
    }
    return hasSundayHoliday ? "振替休日" : "";
  }

  function getCitizensHolidayName(date) {
    if (date.getFullYear() < 1985) return "";
    if (getBaseJapaneseHolidayName(date) || getSubstituteHolidayName(date)) return "";
    const previous = new Date(date);
    const next = new Date(date);
    previous.setDate(previous.getDate() - 1);
    next.setDate(next.getDate() + 1);
    return holidayNameWithoutCitizens(previous) && holidayNameWithoutCitizens(next) ? "国民の休日" : "";
  }

  function holidayNameWithoutCitizens(date) {
    return getBaseJapaneseHolidayName(date) || getSubstituteHolidayName(date);
  }

  function nthWeekdayDateOfMonth(year, monthIndex, weekday, nth) {
    const first = new Date(year, monthIndex, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    return 1 + offset + (nth - 1) * 7;
  }

  function springEquinoxDay(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function autumnEquinoxDay(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  function toDateInputValueFromUnknown(value) {
    if (!value) return "";
    const text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const slash = text.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
    if (slash) return `${slash[1]}-${String(slash[2]).padStart(2, "0")}-${String(slash[3]).padStart(2, "0")}`;
    const md = text.match(/^(\d{1,2})[\/月](\d{1,2})/);
    if (md) return dateFromMonthDay(md[1], md[2]);
    return "";
  }

  function parseJapaneseDate(text) {
    const cleaned = text.trim();
    if (cleaned === "今日") return todayIso();
    if (cleaned === "明日") return addDays(todayIso(), 1);
    if (cleaned === "昨日") return addDays(todayIso(), -1);
    const match = cleaned.match(/(\d{1,2})月(\d{1,2})日/);
    if (match) return dateFromMonthDay(match[1], match[2]);
    return "";
  }

  function dateFromMonthDay(month, day) {
    const year = new Date().getFullYear();
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function addMonths(isoDate, amount) {
    const date = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return "";
    date.setMonth(date.getMonth() + amount);
    return toDateInputValue(date);
  }

  function addDays(isoDate, amount) {
    const date = isoDate ? new Date(`${isoDate}T00:00:00`) : new Date();
    date.setDate(date.getDate() + amount);
    return toDateInputValue(date);
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function dateObject(isoDate) {
    return new Date(`${isoDate}T00:00:00`);
  }

  function daysBetween(start, end) {
    return Math.floor((dateObject(end) - dateObject(start)) / 86400000);
  }

  function monthsBetween(start, end) {
    const a = dateObject(start);
    const b = dateObject(end);
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }

  function lastDayOfMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function nthWeekdayOfMonth(date) {
    return Math.floor((date.getDate() - 1) / 7) + 1;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function normalizeWeekdays(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))]
      .sort((a, b) => a - b);
  }

  function normalizeDateList(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map(String)
      .map((value) => value.trim())
      .filter(isIsoDate))]
      .sort();
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function formatLongDate(isoDate) {
    const date = new Date(`${isoDate}T00:00:00`);
    return new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "long" }).format(date);
  }

  function formatHeaderDate(isoDate) {
    const date = new Date(`${isoDate}T00:00:00`);
    const weekday = new Intl.DateTimeFormat("ja-JP", { weekday: "short" }).format(date);
    return `${date.getMonth() + 1}月${date.getDate()}日(${weekday})`;
  }

  function formatShortDate(isoDate) {
    if (!isoDate) return "";
    const date = new Date(`${isoDate}T00:00:00`);
    return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(date);
  }

  function normalizePriority(value) {
    const text = String(value || "");
    if (/最優先|P1/i.test(text)) return "P1";
    if (/2次|二次|P2/i.test(text)) return "P2";
    if (/3次|三次|P3/i.test(text)) return "P3";
    if (/サブ|SUB/i.test(text)) return "SUB";
    return "NONE";
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
      .replace(/\s+/g, "");
  }

  function matchDepartmentId(name) {
    if (!name) return "";
    const text = String(name).trim();
    const found = app.state.departments.find((department) => department.name === text);
    if (found) return found.id;
    const legacyId = legacyDefaultDepartmentIdsByName.get(text);
    return legacyId && findById(app.state.departments, legacyId) ? legacyId : "";
  }

  function matchProjectId(name) {
    if (!name) return "";
    const found = app.state.projects.find((project) => project.name === name);
    return found?.id || "";
  }

  function findById(collection, id) {
    return collection.find((item) => item.id === id);
  }

  function upsertById(collection, item) {
    const index = collection.findIndex((current) => current.id === item.id);
    if (index >= 0) collection[index] = item;
    else collection.push(item);
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function firstLine(text = "") {
    return String(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  }

  function truncate(text, length) {
    const clean = String(text || "").trim();
    return clean.length > length ? `${clean.slice(0, length)}…` : clean;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function showToast(message) {
    window.clearTimeout(app.toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    app.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
  }
})();
