(() => {
  "use strict";

  const DB_NAME = "claris-local-db";
  const DB_VERSION = 1;
  const STORE = "app";
  const STATE_KEY = "state";
  const BUNDLED_TASK_IMPORT_URL = "./data/claris-master-2026-05-18.json";
  const SINGLE_SLOT_PRIORITIES = ["P1", "P2", "P3"];
  const PERIOD_LINE_CLASS_COUNT = 6;
  const CLASSIFICATION_LABEL = "分類";
  const OPERATIONS_LABEL = "運営情報";
  const ADD_DEPARTMENT_VALUE = "__add_department__";
  const ADD_POLICY_TYPE_VALUE = "__add_policy_type__";
  const defaultPolicyTypes = ["方針", "月次", "週次", "半期", "分類", "施策", "イベント", "応援", "在庫", "売場", "商売計画"];
  const memoFieldLabels = {
    agenda: "論点",
    decisions: "方針",
    nextActions: "行動"
  };

  const priorityMeta = {
    P1: { label: "最優先", className: "priority-p1" },
    P2: { label: "2次優先", className: "priority-p2" },
    P3: { label: "3次優先", className: "priority-p3" },
    SUB: { label: "サブタスク", className: "priority-sub" }
  };
  const entryKindMeta = {
    all: "すべて",
    task: "タスク",
    memo: "メモ",
    policy: OPERATIONS_LABEL
  };

  const tabs = {
    calendar: "カレンダー",
    today: "今日",
    entries: "一覧"
  };
  const legacyEntryTabs = new Set(["tasks", "memos", "policies"]);
  const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
  const weekdayChoiceOrder = [1, 2, 3, 4, 5, 6, 0];
  const recurrenceLabels = {
    none: "なし",
    weekly: "週次",
    "monthly-day": "月次日付",
    "monthly-nth": "月次曜日",
    "monthly-start": "月初",
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
    recognitionStopPromise: null,
    recognitionStopResolve: null,
    dialogOrigin: null,
    pendingPolicySave: null,
    settingsDrag: null,
    isComposingText: false,
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
    document.body.addEventListener("pointerdown", handleSettingsDragStart);
    document.body.addEventListener("pointermove", handleSettingsDragMove);
    document.body.addEventListener("pointerup", handleSettingsDragEnd);
    document.body.addEventListener("pointercancel", handleSettingsDragEnd);
    document.body.addEventListener("compositionstart", handleCompositionStart);
    document.body.addEventListener("compositionend", handleCompositionEnd);
    document.body.addEventListener("keydown", handleKeydown);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stopAudioCaptureImmediately();
    });
    window.addEventListener("resize", () => updateNavIndicator());
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
        policyTypes: [...defaultPolicyTypes],
        llmProvider: "",
        llmEndpoint: "",
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
      projects: [],
      deletedItems: Array.isArray(saved.deletedItems) ? saved.deletedItems : []
    };
    merged.tasks = merged.tasks.map(normalizeTask);
    merged.memos = merged.memos.map(normalizeMemo);
    merged.policies = merged.policies.map(normalizePolicy);
    merged.settings.policyTypes = normalizePolicyTypes(merged.settings.policyTypes);
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
      priority: normalizeTaskPriority(task.priority),
      status: task.status || "active",
      departmentId: task.departmentId || "",
      projectId: "",
      estimatedMinutes: Number(task.estimatedMinutes || 0),
      memoIds: Array.isArray(task.memoIds) ? task.memoIds : [],
      showLinkedMemos: true,
      recurrence: normalizeRecurrence(task.recurrence),
      completedDates: normalizeDateList(task.completedDates),
      generatedFromTaskId: task.generatedFromTaskId || "",
      generatedFromDate: task.generatedFromDate || "",
      generatedNextTaskId: task.generatedNextTaskId || "",
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
      nthOrdinals: normalizeNthOrdinals(recurrence.nthOrdinals || recurrence.ordinals || recurrence.ordinal),
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
      dueDate: "",
      priority: "SUB",
      departmentId: memo.departmentId || "",
      projectId: "",
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
      title: policy.title || OPERATIONS_LABEL,
      type: normalizePolicyType(policy.type || "方針"),
      periodStart: policy.periodStart || "",
      periodEnd: policy.periodEnd || "",
      departmentId: policy.departmentId || "",
      background: policy.background || "",
      policy: policy.policy || policy.content || "",
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

  function normalizePolicyTypes(types) {
    const source = Array.isArray(types) ? types : defaultPolicyTypes;
    const values = source
      .map((type) => normalizePolicyType(typeof type === "string" ? type : type?.name))
      .filter(Boolean);
    return [...new Set(values)].length ? [...new Set(values)] : [...defaultPolicyTypes];
  }

  function getPolicyTypes(current = "") {
    const types = normalizePolicyTypes(app.state?.settings?.policyTypes);
    const normalizedCurrent = normalizePolicyType(current || "");
    return normalizedCurrent && !types.includes(normalizedCurrent) ? types.concat(normalizedCurrent) : types;
  }

  function normalizeTaskPriority(priority) {
    const value = String(priority || "").trim();
    return priorityMeta[value] ? value : "SUB";
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
      bottomNav.dataset.activeTab = activeTab;
      bottomNav.style.setProperty("--nav-active-index", String(Math.max(navIndex, 0)));
      bottomNav.classList.toggle("is-today-active", activeTab === "today");
    }
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === activeTab);
    });
    updateNavIndicator(activeTab);
    requestAnimationFrame(() => updateNavIndicator(activeTab));
  }

  function updateNavIndicator(activeTab = app.state?.ui?.activeTab || "today") {
    if (!bottomNav) return;
    const button = [...bottomNav.querySelectorAll("[data-tab]")].find((item) => item.dataset.tab === activeTab);
    if (!button) return;
    const navRect = bottomNav.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (!navRect.width || !buttonRect.width) return;
    const inset = 3;
    const x = Math.max(inset, buttonRect.left - navRect.left + inset);
    const maxWidth = Math.max(0, navRect.width - x - inset);
    const width = Math.min(Math.max(0, buttonRect.width - inset * 2), maxWidth);
    bottomNav.style.setProperty("--nav-indicator-x", `${x}px`);
    bottomNav.style.setProperty("--nav-indicator-width", `${width}px`);
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
        ${renderStat("運営", relatedPolicies.length, "policies")}
      </section>
      ${overdue.length ? renderTaskSection("DL超過", overdue, "DLが過ぎています") : ""}
      ${renderTodayPriorityFocus(date, todayTasks)}
      ${renderTaskSection(priorityMeta.SUB.label, todayTasks.filter((task) => task.priority === "SUB"), "サブタスクはありません", "", date)}
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">今日に関係する運営情報</h2>
          <span class="section-count">${relatedPolicies.length}件</span>
        </div>
        <div class="policy-list">
          ${relatedPolicies.length ? relatedPolicies.map(renderPolicyCard).join("") : renderEmpty("今日の運営情報はありません。", "運営情報を追加")}
        </div>
      </section>
      ${app.state.settings.showCompleted ? renderTaskSection("今日完了", completedToday, "今日完了したタスクはありません", "", date) : ""}
    `;
  }

  function renderTodayPriorityFocus(date, todayTasks) {
    const priorities = ["P1", "P2", "P3"];
    return `
      <section class="section priority-focus-section" aria-label="優先タスク">
        <div class="section-head">
          <h2 class="section-title">優先タスク</h2>
          <span class="section-count">${priorities.reduce((total, priority) => total + todayTasks.filter((task) => task.priority === priority).length, 0)}件</span>
        </div>
        <div class="priority-focus-grid">
          ${priorities.map((priority) => renderTodayPrioritySlot(priority, todayTasks.filter((task) => task.priority === priority), date)).join("")}
        </div>
      </section>
    `;
  }

  function renderTodayPrioritySlot(priority, tasks, date) {
    const meta = priorityMeta[priority] || priorityMeta.SUB;
    const task = tasks[0] || null;
    const extra = Math.max(0, tasks.length - 1);
    const cardAction = task ? ` data-card-action="edit-task" data-id="${escapeAttr(task.id)}" tabindex="0"` : "";
    return `
      <article class="priority-focus-slot priority-focus-${priority.toLowerCase()} ${task ? "has-task" : "is-empty"}"${cardAction}>
        <div class="priority-focus-head">
          <strong>${escapeHtml(meta.label)}</strong>
          <span>${tasks.length}件</span>
        </div>
        ${task ? `
          <button class="title-button priority-focus-title" type="button" data-action="edit-task" data-id="${escapeAttr(task.id)}">${escapeHtml(task.title)}</button>
          <div class="meta-row">
            ${task.dueDate ? `<span class="tag">DL ${formatShortDate(task.dueDate)}</span>` : ""}
            ${task.assignee ? `<span class="tag">担当 ${escapeHtml(task.assignee)}</span>` : ""}
            ${extra ? `<span class="tag">ほか${extra}件</span>` : ""}
          </div>
        ` : `
          <p class="priority-focus-empty">空き</p>
          <button class="mini-button" type="button" data-action="add-task-slot" data-priority="${priority}" data-date="${escapeAttr(date)}">この枠に追加</button>
        `}
      </article>
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
          <h2 class="section-title">${OPERATIONS_LABEL}</h2>
          <span class="section-count">${policies.length}件</span>
        </div>
        <div class="policy-list">
          ${policies.length ? policies.map(renderPolicyCard).join("") : renderEmpty("該当する運営情報はありません。", "運営情報を追加")}
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
          <button class="mini-button month-nav-button" type="button" data-action="month-prev" aria-label="月を戻す"><span class="month-nav-chevron is-prev" aria-hidden="true"></span></button>
          <h2 class="section-title">${current.year}年${current.month + 1}月</h2>
          <button class="mini-button month-nav-button" type="button" data-action="month-next" aria-label="月を進める"><span class="month-nav-chevron is-next" aria-hidden="true"></span></button>
        </div>
        ${renderCalendarPeriodSummary(selectedDate)}
        <div class="calendar-grid" aria-label="カレンダー">
          ${["月", "火", "水", "木", "金", "土", "日"].map((day) => `<div class="weekday">${day}</div>`).join("")}
          ${days.map((day) => renderDayCell(day, selectedDate, filter)).join("")}
        </div>
        <div class="calendar-day-detail">
          <div class="section-head">
            <h2 class="section-title">${formatLongDate(selectedDate)}の予定</h2>
            <span class="section-count">${selectedTasks.length + selectedPolicies.length}件</span>
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
          ${renderCalendarDayBadges(iso, filter)}
        </span>
        ${renderDayPrioritySummary(actionTasks)}
        ${renderCalendarDueBadge(dueTasks.length)}
      </button>
    `;
  }

  function renderCalendarDayBadges(isoDate, filter) {
    const groups = getCalendarPeriodGroupsForDate(isoDate, filter).slice(0, 3);
    const badges = [];
    groups.forEach((group) => {
      const classes = [
        "day-badge",
        "day-badge-period",
        `period-line-${stableIndex(group.type, PERIOD_LINE_CLASS_COUNT)}`
      ].join(" ");
      const label = `${compactPeriodType(group.type)}${group.count > 1 ? group.count : ""}`;
      badges.push(`<span class="${classes}" title="${escapeAttr(`${group.type}: ${group.count}件`)}">${escapeHtml(label)}</span>`);
    });
    return badges.length ? `<span class="day-badge-stack" aria-label="日付の予定">${badges.join("")}</span>` : "";
  }

  function getCalendarPeriodGroupsForDate(isoDate, filter) {
    const groups = new Map();
    getCalendarPeriodsForDate(isoDate, filter).forEach((period) => {
      const type = normalizePolicyType(period.type || "方針");
      const current = groups.get(type) || {
        type,
        count: 0,
        firstStart: period.start || isoDate,
        firstTitle: period.title || ""
      };
      current.count += 1;
      groups.set(type, current);
    });
    return [...groups.values()].sort((a, b) =>
      String(a.firstStart).localeCompare(String(b.firstStart)) ||
      String(a.type).localeCompare(String(b.type)) ||
      String(a.firstTitle).localeCompare(String(b.firstTitle))
    );
  }

  function renderCalendarDueBadge(dueCount) {
    if (!dueCount) return "";
    return `
      <span class="day-due-row" aria-label="DL ${dueCount}件">
        <span class="day-badge day-badge-due" title="DL ${dueCount}件">DL${dueCount > 1 ? dueCount : ""}</span>
      </span>
    `;
  }

  function compactPeriodType(type) {
    const text = String(type || "期");
    if (/週/.test(text)) return "週";
    if (/月/.test(text)) return "月";
    if (/半期/.test(text)) return "半";
    if (/イベント/.test(text)) return "イベ";
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
      <span class="period-lines" aria-label="${OPERATIONS_LABEL}">
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
      <section class="calendar-period-summary" aria-label="選択日の${OPERATIONS_LABEL}">
        <span class="period-summary-label">${OPERATIONS_LABEL}</span>
        <div class="period-summary-list">
          ${periods.length ? periods.map((period) => {
            const classes = [
              "period-summary-item",
              `period-line-${stableIndex(period.id, PERIOD_LINE_CLASS_COUNT)}`
            ].join(" ");
            const action = "edit-policy";
            const summary = compactPeriodSummary(period);
            return `
              <button class="${classes}" type="button" data-action="${action}" data-id="${escapeAttr(period.id)}" title="${escapeAttr(`${period.type || "方針"}: ${summary}`)}">
                <strong>${escapeHtml(period.type || "方針")}</strong>
                <span>${escapeHtml(summary)}</span>
              </button>
            `;
          }).join("") : `<span class="period-summary-empty">運営情報なし</span>`}
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
      <section class="calendar-policy-focus" aria-label="選択日の${OPERATIONS_LABEL}">
        ${groups.map(([label, items]) => `
          <div class="policy-focus-card" data-card-action="edit-policy" data-id="${escapeAttr(items[0].id)}" tabindex="0">
            <span class="policy-focus-label">${label}</span>
            <strong>${escapeHtml(items[0].title)}</strong>
            ${getPolicyContent(items[0]) ? `<span>${escapeHtml(truncate(getPolicyContent(items[0]), 46))}</span>` : ""}
          </div>
        `).join("")}
        ${other.slice(0, 2).map((policy) => `
          <div class="policy-focus-card" data-card-action="edit-policy" data-id="${escapeAttr(policy.id)}" tabindex="0">
            <span class="policy-focus-label">${escapeHtml(policy.type || "方針")}</span>
            <strong>${escapeHtml(policy.title)}</strong>
            ${getPolicyContent(policy) ? `<span>${escapeHtml(truncate(getPolicyContent(policy), 46))}</span>` : ""}
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
        <input type="hidden" data-recording-transcript-draft value="">
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
          <h2 class="section-title">${OPERATIONS_LABEL}</h2>
          <span class="section-count">${policies.length}件</span>
        </div>
        <div class="policy-list">
          ${policies.length ? policies.map(renderPolicyCard).join("") : renderEmpty("運営情報はまだありません。", "運営情報を追加")}
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
        title: "今日の運営情報",
        subtitle: `${formatLongDate(date)}の${OPERATIONS_LABEL}`,
        html: policies.length ? `<div class="policy-list">${policies.map(renderPolicyCard).join("")}</div>` : renderEmpty("今日の運営情報はありません。", "運営情報を追加")
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
    const priority = priorityMeta[task.priority] || priorityMeta.SUB;
    const department = findById(app.state.departments, task.departmentId);
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
            ${linkedMemos.length ? `<span class="tag">メモ ${linkedMemos.length}</span>` : ""}
            ${recurrence ? `<span class="tag">${escapeHtml(recurrence)}</span>` : ""}
          </div>
          ${memoSummary}
          <div class="card-actions">
            <button class="mini-button" type="button" data-action="move-today" data-id="${escapeAttr(task.id)}">今日に追加</button>
            <button class="mini-button" type="button" data-action="open-convert" data-kind="task" data-id="${escapeAttr(task.id)}">変換</button>
            <button class="mini-button" type="button" data-action="duplicate-task" data-id="${escapeAttr(task.id)}">複製</button>
            <button class="mini-button" type="button" data-action="delete-task" data-id="${escapeAttr(task.id)}">削除</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderMemoCard(memo) {
    const department = findById(app.state.departments, memo.departmentId);
    const linkedTasks = memo.taskIds.map((id) => findById(app.state.tasks, id)).filter(Boolean);
    const recordings = memo.recordings || [];
    const previewText = getMemoPreviewText(memo);
    return `
      <article class="memo-card" data-card-action="edit-memo" data-id="${escapeAttr(memo.id)}" tabindex="0">
        <div class="section-head">
          <h3><button class="title-button" type="button" data-action="edit-memo" data-id="${escapeAttr(memo.id)}">${escapeHtml(memo.title || "メモ")}</button></h3>
        </div>
        <div class="meta-row">
          ${department ? `<span class="tag">${escapeHtml(department.name)}</span>` : ""}
          ${linkedTasks.length ? `<span class="tag">関連タスク ${linkedTasks.length}</span>` : ""}
          ${recordings.length ? `<span class="tag">録音 ${recordings.length}</span>` : ""}
        </div>
        ${previewText ? `<button class="body-preview body-preview-button" type="button" data-action="edit-memo" data-id="${escapeAttr(memo.id)}">${escapeHtml(previewText)}</button>` : ""}
        <div class="card-actions">
          <button class="mini-button" type="button" data-action="open-convert" data-kind="memo" data-id="${escapeAttr(memo.id)}">変換</button>
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
    const content = getPolicyContent(policy);
    const colorClass = `period-line-${stableIndex(policy.id || policy.type, PERIOD_LINE_CLASS_COUNT)}`;
    return `
      <article class="policy-card" data-card-action="edit-policy" data-id="${escapeAttr(policy.id)}" tabindex="0">
        <div class="section-head">
          <h3>${escapeHtml(policy.title)}</h3>
          <span class="status-pill ${colorClass}">${escapeHtml(policy.type || "方針")}</span>
        </div>
        <div class="meta-row">
          ${policy.periodStart ? `<span class="tag">${formatShortDate(policy.periodStart)}</span>` : ""}
          ${policy.periodEnd ? `<span class="tag">- ${formatShortDate(policy.periodEnd)}</span>` : ""}
          ${department ? `<span class="tag">${escapeHtml(department.name)}</span>` : ""}
        </div>
        ${content ? `<p class="body-preview">${escapeHtml(truncate(content, 150))}</p>` : ""}
        <div class="card-actions">
          <button class="mini-button" type="button" data-action="edit-policy" data-id="${escapeAttr(policy.id)}">編集</button>
          <button class="mini-button" type="button" data-action="open-convert" data-kind="policy" data-id="${escapeAttr(policy.id)}">変換</button>
          <button class="mini-button" type="button" data-action="delete-policy" data-id="${escapeAttr(policy.id)}">削除</button>
        </div>
      </article>
    `;
  }

  async function handleClick(event) {
    const tabButton = event.target.closest("[data-tab]");
    if (tabButton) {
      const nextTab = normalizeActiveTab(tabButton.dataset.tab);
      if (nextTab === normalizeActiveTab(app.state.ui.activeTab)) {
        scrollCurrentViewToTop();
        return;
      }
      app.state.ui.activeTab = nextTab;
      await saveState();
      render();
      return;
    }

    if (activateCardFromEvent(event)) return;

    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    setDialogOriginFromElement(button);

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
    if (action === "open-convert") openConvertChoice(button.dataset.kind, id);
    if (action === "task-to-memo") openMemoFromTask(id);
    if (action === "task-to-policy") openPolicyFromTask(id);
    if (action === "memo-to-policy") openPolicyFromMemo(id);
    if (action === "policy-to-task") openTaskFromPolicy(id);
    if (action === "policy-to-memo") openMemoFromPolicy(id);
    if (action === "period-month-prev") changePolicyPeriodMonth(button, -1);
    if (action === "period-month-next") changePolicyPeriodMonth(button, 1);
    if (action === "select-period-date") selectPolicyPeriodDate(button);
    if (action === "clear-policy-period") clearPolicyPeriod(button);
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
    if (action === "delete-policy") await deleteEntity("policies", id, "運営情報を削除しました");
    if (action === "classify-memo-form") await classifyMemoForm();
    if (action === "memo-to-task") openTaskFromMemo(id);
    if (action === "restore-deleted-item") await restoreDeletedItem(id);
    if (action === "purge-deleted-item") await purgeDeletedItem(id);
    if (action === "save-quick-memo") await saveQuickMemo();
    if (action === "start-recording") await startRecording();
    if (action === "stop-recording") await stopRecording();
    if (action === "start-transcription") startTranscription();
    if (action === "stop-transcription") await stopTranscription();
    if (action === "month-prev") await changeMonth(-1);
    if (action === "month-next") await changeMonth(1);
    if (action === "select-day") await selectDay(button.dataset.date);
    if (action === "resolve-conflict") await resolveConflict(button.dataset.mode);
    if (action === "back-to-task-form") reopenPendingTaskForm();
    if (action === "export-json") exportJson();
    if (action === "export-master-json") exportMasterJson();
    if (action === "run-import") await runImportFromDialog();
    if (action === "add-department") addSettingsRow("department");
    if (action === "add-policy-type") addSettingsRow("policyType");
    if (action === "toggle-settings-panel") toggleSettingsPanel(button);
    if (action === "move-settings-row") moveSettingsRow(button);
    if (action === "remove-settings-row") button.closest(".list-row")?.remove();
    if (action === "save-policy-period") savePolicyPeriod(button);
    if (action === "save-policy-period-mode") await savePendingPolicy(button.dataset.mode);
  }

  function scrollCurrentViewToTop() {
    const shell = document.querySelector(".app-shell");
    if (shell?.scrollIntoView) shell.scrollIntoView({ block: "start", behavior: "smooth" });
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    view?.focus?.({ preventScroll: true });
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
    setDialogOriginFromElement(card);
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
    } else {
      return false;
    }
    return true;
  }

  async function handleChange(event) {
    if (event.target.name === "departmentId") {
      await handleDepartmentSelectChange(event.target);
      return;
    }
    if (event.target.name === "type") {
      await handlePolicyTypeSelectChange(event.target);
      return;
    }
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
    if (event.target.matches("[data-memo-search]")) {
      filterMemoPicker(event.target);
    }
    if (event.target.id === "entrySearch") {
      if (app.isComposingText || event.isComposing) return;
      handleEntrySearchInput(event.target);
    }
  }

  function handleCompositionStart(event) {
    if (event.target.matches("input, textarea")) app.isComposingText = true;
  }

  function handleCompositionEnd(event) {
    app.isComposingText = false;
    if (event.target.id === "entrySearch") handleEntrySearchInput(event.target);
  }

  function handleEntrySearchInput(input) {
    const cursor = input.selectionStart || 0;
    app.state.ui.entrySearch = input.value;
    saveState();
    renderEntriesView();
    const search = document.getElementById("entrySearch");
    if (search) {
      search.focus();
      search.setSelectionRange(cursor, cursor);
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (event.submitter instanceof HTMLElement) setDialogOriginFromElement(event.submitter);
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
      if (input) input.value = input.value === priority ? "SUB" : priority;
      updateConflictMovePreview();
      return;
    }
    const form = button.closest("form");
    const input = form?.elements.priority;
    if (!input) return;
    input.value = input.value === priority ? "SUB" : priority;
    updateTaskPriorityPreview(form);
  }

  async function handleDepartmentSelectChange(select) {
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.value === ADD_DEPARTMENT_VALUE) {
      await addDepartmentFromSelect(select);
      return;
    }
    select.dataset.currentValue = select.value;
  }

  async function addDepartmentFromSelect(select) {
    const previousValue = select.dataset.currentValue || "";
    const enteredName = window.prompt("新しい分類名", "新しい分類");
    if (enteredName === null) {
      select.value = previousValue;
      return;
    }
    const name = enteredName.trim() || "新しい分類";
    const now = nowIso();
    const department = {
      id: uid("dept"),
      name,
      parentId: "",
      sortOrder: app.state.departments.length + 1,
      createdAt: now,
      updatedAt: now
    };
    app.state.departments.push(department);
    await saveState();
    refreshDepartmentSelects(select, department.id);
    showToast("分類を追加しました。");
  }

  async function handlePolicyTypeSelectChange(select) {
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.value === ADD_POLICY_TYPE_VALUE) {
      await addPolicyTypeFromSelect(select);
      return;
    }
    select.dataset.currentValue = select.value;
  }

  async function addPolicyTypeFromSelect(select) {
    const previousValue = select.dataset.currentValue || "方針";
    const enteredName = window.prompt("新しい種別名", "新しい種別");
    if (enteredName === null) {
      select.value = previousValue;
      return;
    }
    const name = normalizePolicyType(enteredName);
    app.state.settings.policyTypes = normalizePolicyTypes(getPolicyTypes().concat(name));
    await saveState();
    refreshPolicyTypeSelects(select, name);
    showToast("運営情報の種別を追加しました。");
  }

  function refreshDepartmentSelects(activeSelect, activeValue) {
    document.querySelectorAll('select[name="departmentId"]').forEach((select) => {
      const current = select === activeSelect
        ? activeValue
        : normalizeDepartmentFormValue(select.value);
      select.innerHTML = renderDepartmentOptions(current);
      select.value = current;
      select.dataset.currentValue = current;
    });
  }

  function normalizeDepartmentFormValue(value) {
    const text = String(value || "");
    return text === ADD_DEPARTMENT_VALUE ? "" : text;
  }

  function refreshPolicyTypeSelects(activeSelect, activeValue) {
    document.querySelectorAll('select[name="type"]').forEach((select) => {
      const current = select === activeSelect
        ? activeValue
        : normalizePolicyTypeFormValue(select.value);
      select.innerHTML = renderPolicyTypeOptions(current);
      select.value = current;
      select.dataset.currentValue = current;
    });
  }

  function normalizePolicyTypeFormValue(value) {
    const text = String(value || "");
    return text === ADD_POLICY_TYPE_VALUE ? "方針" : normalizePolicyType(text || "方針");
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

  function openConvertChoice(kind, id) {
    const config = {
      task: {
        title: "変換",
        subtitle: "タスクから作成する内容を選んでください。",
        actions: [
          ["task-to-memo", "メモへ", "関連メモとして残す"],
          ["task-to-policy", "運営情報へ", "期間や判断材料として残す"]
        ]
      },
      memo: {
        title: "変換",
        subtitle: "メモから作成する内容を選んでください。",
        actions: [
          ["memo-to-task", "タスクへ", "実施項目にする"],
          ["memo-to-policy", "運営情報へ", "判断材料として残す"]
        ]
      },
      policy: {
        title: "変換",
        subtitle: "運営情報から作成する内容を選んでください。",
        actions: [
          ["policy-to-task", "タスクへ", "実施項目にする"],
          ["policy-to-memo", "メモへ", "記録として残す"]
        ]
      }
    }[kind];
    if (!config) return;
    openSheet(`
      <div class="sheet sheet-compact">
        ${renderSheetHeader(config.title, config.subtitle)}
        <div class="choice-grid">
          ${config.actions.map(([action, label, sub]) => `
            <button class="choice-button" type="button" data-action="${action}" data-id="${escapeAttr(id)}">
              <strong>${label}</strong>
              <span>${sub}</span>
            </button>
          `).join("")}
        </div>
      </div>
    `);
  }

  function defaultTaskForCurrentContext() {
    if (app.state.ui.activeTab === "today") return { actionDate: todayIso(), priority: "P2" };
    if (app.state.ui.activeTab === "calendar") return { actionDate: app.state.ui.selectedDate || todayIso(), priority: "P2" };
    return { priority: "SUB" };
  }

  function openTaskForm(task = null, defaults = {}) {
    const existing = task ? normalizeTask(task) : null;
    const value = {
      id: existing?.id || "",
      title: existing?.title || defaults.title || "",
      description: existing?.description || defaults.description || "",
      assignee: existing?.assignee || defaults.assignee || "",
      actionDate: existing?.actionDate || defaults.actionDate || "",
      dueDate: existing?.dueDate || defaults.dueDate || "",
      priority: normalizeTaskPriority(existing?.priority || defaults.priority || "SUB"),
      departmentId: existing?.departmentId || defaults.departmentId || "",
      estimatedMinutes: existing?.estimatedMinutes || defaults.estimatedMinutes || "",
      memoIds: existing?.memoIds || defaults.memoIds || [],
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
              <input id="taskActionDate" name="actionDate" type="date">
            </div>
            <div class="field">
              <label for="taskDueDate">DL</label>
              <input id="taskDueDate" name="dueDate" type="date">
            </div>
          </div>
          <div class="field">
            <label>優先度の空き状況</label>
            <input id="taskPriority" name="priority" type="hidden" value="${escapeAttr(value.priority)}">
            <div id="priorityAvailability" class="priority-availability" aria-live="polite"></div>
          </div>
          ${renderRecurrenceFields(value.recurrence)}
          <div class="field">
            <label for="taskMemos">関連メモ</label>
            ${renderMemoPicker(value.memoIds)}
            <div class="toolbar">
              ${value.id
                ? `<button class="ghost-button compact" type="button" data-action="task-to-memo" data-id="${escapeAttr(value.id)}">新しい関連メモ</button>`
                : `<span class="form-hint">関連メモの新規作成は、タスク保存後に使えます。</span>`}
            </div>
          </div>
          <div class="field-inline task-owner-row">
            <div class="field">
              <label for="taskDepartment">${CLASSIFICATION_LABEL}</label>
              <select id="taskDepartment" name="departmentId" data-current-value="${escapeAttr(value.departmentId)}">${renderDepartmentOptions(value.departmentId)}</select>
            </div>
            <div class="field">
              <label for="taskAssignee">担当者</label>
              <input id="taskAssignee" name="assignee" value="${escapeAttr(value.assignee)}" autocomplete="off" placeholder="任意">
            </div>
            <div class="field">
              <label for="taskEstimate">見積分</label>
              <input id="taskEstimate" name="estimatedMinutes" type="number" min="0" step="5" value="${escapeAttr(value.estimatedMinutes)}">
            </div>
          </div>
          <div class="form-actions">
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
    initializeTaskDateInputs(value);
    updateRecurrenceForm(document.getElementById("taskForm"));
    updateTaskPriorityPreview(document.getElementById("taskForm"));
  }

  function initializeTaskDateInputs(value) {
    setResettableDateInput(document.getElementById("taskActionDate"), value.actionDate);
    setResettableDateInput(document.getElementById("taskDueDate"), value.dueDate);
  }

  function setResettableDateInput(input, date) {
    if (!input) return;
    input.defaultValue = "";
    input.value = date || "";
  }

  function openMemoForm(memo = null, defaults = {}) {
    const existing = memo ? normalizeMemo(memo) : null;
    const value = {
      id: existing?.id || "",
      title: existing?.title || defaults.title || "",
      body: existing?.body || defaults.body || "",
      agenda: existing?.agenda || defaults.agenda || "",
      decisions: existing?.decisions || defaults.decisions || "",
      nextActions: existing?.nextActions || defaults.nextActions || "",
      transcript: existing?.transcript || defaults.transcript || "",
      departmentId: existing?.departmentId || defaults.departmentId || "",
      taskIds: existing?.taskIds || defaults.taskIds || [],
      recordings: existing?.recordings || []
    };
    resetRecordingDraft();
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(existing ? "メモ編集" : "メモ追加", "走り書きから始めて、後で論点・方針・行動へ整えられます。")}
        <form id="memoForm" class="form-grid" data-id="${escapeAttr(value.id)}">
          <div class="field">
            <label for="memoTitle">タイトル</label>
            <input id="memoTitle" name="title" value="${escapeAttr(value.title)}" autocomplete="off">
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
            <input type="hidden" data-recording-transcript-draft value="">
            <div class="transcript-preview hidden" data-recording-transcript-preview aria-live="polite"></div>
          </section>
          <div class="field">
            <label for="memoBody">本文</label>
            <textarea id="memoBody" name="body" required>${escapeHtml(value.body)}</textarea>
          </div>
          <div class="toolbar">
            <button class="ghost-button compact" type="button" data-action="classify-memo-form">自動判定</button>
            <span class="classify-status" data-classify-status></span>
          </div>
          <div class="field-inline">
            <div class="field">
              <label for="memoAgenda">${memoFieldLabels.agenda}</label>
              <textarea id="memoAgenda" name="agenda">${escapeHtml(value.agenda)}</textarea>
            </div>
            <div class="field">
              <label for="memoDecisions">${memoFieldLabels.decisions}</label>
              <textarea id="memoDecisions" name="decisions">${escapeHtml(value.decisions)}</textarea>
            </div>
            <div class="field">
              <label for="memoNextActions">${memoFieldLabels.nextActions}</label>
              <textarea id="memoNextActions" name="nextActions">${escapeHtml(value.nextActions)}</textarea>
            </div>
          </div>
          ${value.recordings.length ? `
            <div class="field">
              <label>録音</label>
              <div class="audio-list">${value.recordings.map(renderRecording).join("")}</div>
            </div>
          ` : ""}
          <div class="field-inline">
            <div class="field">
              <label for="memoDepartment">${CLASSIFICATION_LABEL}</label>
              <select id="memoDepartment" name="departmentId" data-current-value="${escapeAttr(value.departmentId)}">${renderDepartmentOptions(value.departmentId)}</select>
            </div>
          </div>
          <div class="field">
            <label for="memoTasks">関連タスク</label>
            ${renderTaskPicker(value.taskIds)}
          </div>
          <details class="transcript-details">
            <summary>文字起こし</summary>
            <div class="field">
              <label for="memoTranscript">全文</label>
              <textarea id="memoTranscript" name="transcript" placeholder="録音時の文字起こしや、別アプリで起こした全文をここに保存">${escapeHtml(value.transcript)}</textarea>
            </div>
          </details>
          <div class="form-actions">
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
    updateTranscriptPreview("");
    updateRecordingButtons();
  }

  function openPolicyForm(policy = null, defaults = {}) {
    const existing = policy ? normalizePolicy(policy) : null;
    const value = {
      id: existing?.id || "",
      title: existing?.title || defaults.title || "",
      type: normalizePolicyType(existing?.type || defaults.type || "方針"),
      periodStart: existing?.periodStart || defaults.periodStart || "",
      periodEnd: existing?.periodEnd || defaults.periodEnd || "",
      departmentId: existing?.departmentId || defaults.departmentId || "",
      content: getPolicyContent(existing || defaults),
      taskIds: existing?.taskIds || defaults.taskIds || [],
      memoIds: existing?.memoIds || defaults.memoIds || []
    };
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(existing ? "運営情報編集" : "運営情報追加", "内容をまとめて残します。")}
        <form id="policyForm" class="form-grid" data-id="${escapeAttr(value.id)}">
          ${value.taskIds.map((id) => `<input type="hidden" name="taskIds" value="${escapeAttr(id)}">`).join("")}
          ${value.memoIds.map((id) => `<input type="hidden" name="memoIds" value="${escapeAttr(id)}">`).join("")}
          <div class="field">
            <label for="policyTitle">タイトル</label>
            <input id="policyTitle" name="title" required value="${escapeAttr(value.title)}" autocomplete="off">
          </div>
          <div class="field-inline">
            <div class="field">
              <label for="policyType">種別</label>
              <select id="policyType" name="type" data-current-value="${escapeAttr(value.type)}">
                ${renderPolicyTypeOptions(value.type)}
              </select>
            </div>
            ${renderPolicyPeriodField(value.periodStart, value.periodEnd)}
          </div>
            <div class="field">
              <label for="policyDepartment">${CLASSIFICATION_LABEL}</label>
            <select id="policyDepartment" name="departmentId" data-current-value="${escapeAttr(value.departmentId)}">${renderDepartmentOptions(value.departmentId)}</select>
            </div>
          <div class="field">
            <label for="policyContent">内容</label>
            <textarea id="policyContent" name="content">${escapeHtml(value.content)}</textarea>
          </div>
          <div class="form-actions">
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
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
      ["policy", OPERATIONS_LABEL, "内容"]
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
          <div class="field recurrence-section" data-recurrence-section="weekly monthly-day monthly-start monthly-end custom">
            <label for="taskRecurrenceInterval">間隔</label>
            <input id="taskRecurrenceInterval" name="recurrenceInterval" type="number" min="1" max="24" step="1" value="${escapeAttr(value.interval)}">
          </div>
        </div>
        <div class="recurrence-section recurrence-weekdays" data-recurrence-section="weekly">
          ${weekdayChoiceOrder.map((index) => `
            <label class="weekday-choice">
              <input type="checkbox" name="recurrenceWeekdays" value="${index}" ${value.weekdays.includes(index) ? "checked" : ""}>
              <span>${weekdayLabels[index]}</span>
            </label>
          `).join("")}
        </div>
        <div class="field recurrence-section" data-recurrence-section="monthly-day">
          <label for="taskRecurrenceMonthDay">毎月の日付</label>
          <input id="taskRecurrenceMonthDay" name="recurrenceMonthDay" type="number" min="1" max="31" step="1" value="${escapeAttr(value.monthDay)}">
        </div>
        <div class="field-inline recurrence-section" data-recurrence-section="monthly-nth">
          <div class="field">
            <label>第</label>
            <div class="recurrence-ordinal-grid">
              ${[1, 2, 3, 4, 5].map((ordinal) => `
                <label class="weekday-choice">
                  <input type="checkbox" name="recurrenceOrdinals" value="${ordinal}" ${value.nthOrdinals.includes(ordinal) ? "checked" : ""}>
                  <span>${ordinal}</span>
                </label>
              `).join("")}
            </div>
          </div>
          <div class="field">
            <label for="taskRecurrenceWeekday">曜日</label>
            <select id="taskRecurrenceWeekday" name="recurrenceWeekday">
              ${weekdayChoiceOrder.map((index) => `<option value="${index}"${selected(value.weekday, index)}>${weekdayLabels[index]}曜日</option>`).join("")}
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
      ordinal: Number(data.getAll("recurrenceOrdinals")[0] || 2),
      nthOrdinals: data.getAll("recurrenceOrdinals").map(Number),
      weekday: Number(data.get("recurrenceWeekday") || 0),
      customDates: parseFlexibleDateList(String(data.get("recurrenceCustomDates") || ""))
    });
  }

  function updateTaskPriorityPreview(form) {
    if (!form) return;
    const target = form.querySelector("#priorityAvailability");
    if (!target) return;
    const date = String(form.elements.actionDate?.value || "");
    if (!date && form.elements.priority) form.elements.priority.value = "SUB";
    const selectedPriority = normalizeTaskPriority(form.elements.priority?.value || "SUB");
    const currentId = form.dataset.id || "";
    target.innerHTML = renderPrioritySelector(date, currentId, selectedPriority);
  }

  function renderPrioritySelector(date, excludeId = "", selectedPriority = "", extraExcludeIds = []) {
    const selected = normalizeTaskPriority(selectedPriority);
    if (!date) {
      return `
        <div class="availability-row availability-row-empty">
          <span class="availability-note">実施日がないタスクはサブタスクとして保存します。実施日を選ぶと、その日の優先度を選べます。</span>
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
      <p class="availability-note">最優先、2次優先、3次優先、サブタスクのどれかで保存します。</p>
    `;
  }

  function renderPrioritySlotButton(priority, label, detail, selectedPriority, occupied, count) {
    const classes = [
      "availability-pill",
      occupied ? "is-occupied" : "is-open",
      selectedPriority ? "is-selected" : ""
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
      priority: normalizeTaskPriority(data.get("priority")),
      departmentId: normalizeDepartmentFormValue(data.get("departmentId")),
      projectId: "",
      estimatedMinutes: Number(data.get("estimatedMinutes") || 0),
      memoIds: data.getAll("memoIds").map(String),
      showLinkedMemos: true,
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
    showDialogWithLaunch(conflictDialog);
    updateConflictMovePreview();
  }

  async function resolveConflict(mode) {
    if (!app.pendingConflict) return;
    const { task, context } = app.pendingConflict;
    const conflicts = findPriorityConflicts(task);
    if (mode === "move-existing") {
      const moveDate = document.getElementById("conflictMoveDate")?.value || "";
      const movePriority = normalizeTaskPriority(document.getElementById("conflictMovePriority")?.value);
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
    const priority = (priorityMeta[task.priority] || priorityMeta.SUB).label;
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
    const transcriptDraft = form.querySelector("[data-recording-transcript-draft]")?.value || "";
    const transcript = appendUniqueText(
      appendUniqueText(String(data.get("transcript") || "").trim(), app.pendingRecordingTranscript.trim()),
      transcriptDraft
    ).trim();
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
      dueDate: "",
      priority: "SUB",
      departmentId: normalizeDepartmentFormValue(data.get("departmentId")),
      projectId: "",
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
    const payload = buildPolicyPayloadFromForm(form, "saved");
    const periodPicker = form.querySelector("[data-period-picker]");
    const draftStart = periodPicker?.dataset.draftStart || "";
    const draftEnd = periodPicker?.dataset.draftEnd || "";
    const savedStart = periodPicker?.dataset.savedStart || "";
    const savedEnd = periodPicker?.dataset.savedEnd || "";
    if (draftStart !== savedStart || draftEnd !== savedEnd) {
      app.pendingPolicySave = {
        payload,
        draftStart,
        draftEnd,
        savedStart,
        savedEnd
      };
      openUnsavedPeriodChoice();
      return;
    }
    await savePolicyPayload(payload);
  }

  function buildPolicyPayloadFromForm(form, periodMode = "saved") {
    const data = new FormData(form);
    const picker = form.querySelector("[data-period-picker]");
    const now = nowIso();
    const existing = findById(app.state.policies, form.dataset.id || "");
    const content = String(data.get("content") || "").trim();
    return {
      ...existing,
      id: form.dataset.id || uid("policy"),
      title: String(data.get("title") || "").trim(),
      type: normalizePolicyTypeFormValue(data.get("type") || "方針"),
      periodStart: periodMode === "draft" ? (picker?.dataset.draftStart || "") : String(data.get("periodStart") || ""),
      periodEnd: periodMode === "draft" ? (picker?.dataset.draftEnd || "") : String(data.get("periodEnd") || ""),
      departmentId: normalizeDepartmentFormValue(data.get("departmentId")),
      background: "",
      policy: content,
      actions: "",
      notes: "",
      taskIds: data.getAll("taskIds").map(String),
      memoIds: data.getAll("memoIds").map(String),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
  }

  function openUnsavedPeriodChoice() {
    const pending = app.pendingPolicySave;
    if (!pending) return;
    openSheet(`
      <div class="sheet sheet-compact">
        ${renderSheetHeader("期間の保存", "期間が変更されています。どう保存しますか。")}
        <div class="choice-grid">
          <button class="choice-button" type="button" data-action="save-policy-period-mode" data-mode="with-period">
            <strong>期間も保存</strong>
            <span>${escapeHtml(formatPolicyPeriodRange(pending.draftStart, pending.draftEnd) || "期間なし")}</span>
          </button>
          <button class="choice-button" type="button" data-action="save-policy-period-mode" data-mode="without-period">
            <strong>本文だけ保存</strong>
            <span>期間は ${escapeHtml(formatPolicyPeriodRange(pending.savedStart, pending.savedEnd) || "期間なし")} のまま</span>
          </button>
          <button class="choice-button" type="button" data-action="save-policy-period-mode" data-mode="back">
            <strong>戻る</strong>
            <span>編集画面に戻る</span>
          </button>
        </div>
      </div>
    `);
  }

  async function savePendingPolicy(mode) {
    const pending = app.pendingPolicySave;
    if (!pending) return;
    if (mode === "back") {
      const draft = {
        ...pending.payload,
        periodStart: pending.draftStart,
        periodEnd: pending.draftEnd
      };
      app.pendingPolicySave = null;
      openPolicyForm(draft);
      return;
    }
    const payload = {
      ...pending.payload,
      periodStart: mode === "with-period" ? pending.draftStart : pending.savedStart,
      periodEnd: mode === "with-period" ? pending.draftEnd : pending.savedEnd
    };
    app.pendingPolicySave = null;
    await savePolicyPayload(payload);
  }

  async function savePolicyPayload(payload) {
    upsertById(app.state.policies, normalizePolicy(payload));
    await saveState();
    closeDialogs();
    render();
    showToast("運営情報を保存しました。");
  }

  async function toggleTask(id, date = "") {
    const task = findById(app.state.tasks, id);
    if (!task) return;
    if (task.status === "completed") {
      removeGeneratedNextTask(task);
      task.status = "active";
      task.completedAt = null;
    } else {
      task.status = "completed";
      task.completedAt = nowIso();
      createNextRecurringTask(task, date || task.actionDate || todayIso());
    }
    task.updatedAt = nowIso();
    await saveState();
    render();
  }

  function createNextRecurringTask(task, completedDate) {
    if (!hasRecurrence(task) || task.generatedNextTaskId) return;
    const nextDate = getNextRecurrenceDate(task, completedDate);
    if (!nextDate) return;
    const now = nowIso();
    const next = normalizeTask({
      ...task,
      id: uid("task"),
      actionDate: nextDate,
      dueDate: shiftDueDateForNextTask(task, nextDate, completedDate),
      status: "active",
      completedAt: null,
      completedDates: [],
      generatedFromTaskId: task.id,
      generatedFromDate: completedDate,
      generatedNextTaskId: "",
      createdAt: now,
      updatedAt: now
    });
    if (SINGLE_SLOT_PRIORITIES.includes(next.priority) && getPriorityOccupants(next.actionDate, next.priority, [task.id]).length) {
      next.priority = findAvailablePriority(next.actionDate, next.id, [next.priority]);
    }
    app.state.tasks.push(next);
    task.generatedNextTaskId = next.id;
  }

  function shiftDueDateForNextTask(task, nextActionDate, completedDate) {
    if (!task.dueDate || !isIsoDate(task.dueDate)) return "";
    const baseDate = isIsoDate(task.actionDate) ? task.actionDate : completedDate;
    if (!isIsoDate(baseDate)) return task.dueDate;
    return addDays(nextActionDate, daysBetween(baseDate, task.dueDate));
  }

  function removeGeneratedNextTask(task) {
    const nextId = task.generatedNextTaskId;
    if (!nextId) return;
    const next = findById(app.state.tasks, nextId);
    if (next && next.generatedFromTaskId === task.id) {
      app.state.tasks = app.state.tasks.filter((item) => item.id !== nextId);
      app.state.memos.forEach((memo) => {
        memo.taskIds = memo.taskIds.filter((taskId) => taskId !== nextId);
      });
    }
    task.generatedNextTaskId = "";
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
    openTodayPriorityDialog(task);
  }

  function openTodayPriorityDialog(task) {
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader("今日に追加", "優先度を選んでください。")}
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
    if (kind === "departments") return item.name || CLASSIFICATION_LABEL;
    return item.title || item.name || "項目";
  }

  function cloneForStorage(item) {
    if (typeof structuredClone === "function") return structuredClone(item);
    return JSON.parse(JSON.stringify(item));
  }

  async function classifyMemoForm() {
    const form = document.getElementById("memoForm");
    if (!form) return;
    const title = String(form.elements.title?.value || "");
    const body = String(form.elements.body?.value || "");
    const transcript = String(form.elements.transcript?.value || "");
    const source = [title, body, transcript].filter(Boolean).join("\n");
    if (!source.trim()) {
      showToast("判定するタイトル、本文、文字起こしを入力してください。");
      return;
    }
    const button = form.querySelector('[data-action="classify-memo-form"]');
    const status = form.querySelector("[data-classify-status]");
    if (button) button.disabled = true;
    if (status) status.textContent = "判定中";
    try {
      const organized = await classifyMemoText(source);
      if (!form.isConnected) {
        showToast("判定が完了しました。メモ画面を開き直して確認してください。");
        return;
      }
      if (!form.elements.title.value.trim()) form.elements.title.value = organized.title;
      form.elements.agenda.value = organized.agenda;
      form.elements.decisions.value = organized.decisions;
      form.elements.nextActions.value = organized.nextActions;
      if (status) status.textContent = "反映済み";
      showToast("タイトル、本文、文字起こしから論点・方針・行動へ判定しました。");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function classifyMemoText(text) {
    const endpoint = String(app.state.settings.llmEndpoint || "").trim();
    if (endpoint) {
      try {
        const external = await requestExternalMemoClassification(endpoint, text);
        if (external) return external;
      } catch (error) {
        showToast(`外部LLM判定に失敗しました。ローカル判定に切り替えます: ${error.message}`);
      }
    }
    return organizeText(text);
  }

  async function requestExternalMemoClassification(endpoint, text) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: app.state.settings.llmProvider || "external",
        task: "claris.memo.classify",
        input: text,
        schema: {
          title: "string",
          agenda: memoFieldLabels.agenda,
          decisions: memoFieldLabels.decisions,
          nextActions: memoFieldLabels.nextActions
        }
      })
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    const result = data.result && typeof data.result === "object" ? data.result : data;
    return {
      title: String(result.title || firstLine(text) || "メモ"),
      agenda: String(result.agenda || result.issues || result["論点"] || ""),
      decisions: String(result.decisions || result.policy || result["方針"] || ""),
      nextActions: String(result.nextActions || result.actions || result["行動"] || "")
    };
  }

  function openTaskFromMemo(id) {
    const memo = findById(app.state.memos, id);
    if (!memo) return;
    openTaskForm(null, {
      title: memo.nextActions || memo.title,
      priority: "SUB",
      departmentId: memo.departmentId,
      memoIds: [memo.id]
    });
    const form = document.getElementById("taskForm");
    if (!form) return;
    form.elements.title.value = memo.nextActions || memo.title || "メモから作成";
    form.elements.priority.value = "SUB";
    form.elements.departmentId.value = memo.departmentId || "";
    [...form.querySelectorAll('input[name="memoIds"]')].forEach((input) => {
      input.checked = input.value === memo.id;
    });
    updateTaskPriorityPreview(form);
  }

  function openMemoFromTask(id) {
    const task = findById(app.state.tasks, id);
    if (!task) return;
    openMemoForm(null, {
      title: task.title || "タスクメモ",
      body: buildTaskReferenceText(task),
      priority: task.priority,
      departmentId: task.departmentId,
      taskIds: [task.id]
    });
  }

  function openPolicyFromTask(id) {
    const task = findById(app.state.tasks, id);
    if (!task) return;
    openPolicyForm(null, {
      title: task.title || "タスクから運営情報",
      type: "施策",
      periodStart: task.actionDate || "",
      periodEnd: task.dueDate || task.actionDate || "",
      departmentId: task.departmentId,
      policy: buildTaskReferenceText(task),
      taskIds: [task.id],
      memoIds: task.memoIds || []
    });
  }

  function openPolicyFromMemo(id) {
    const memo = findById(app.state.memos, id);
    if (!memo) return;
    openPolicyForm(null, {
      title: memo.title || "メモから運営情報",
      type: "方針",
      departmentId: memo.departmentId,
      policy: getMemoPreviewText(memo) || memo.body || memo.title,
      memoIds: [memo.id],
      taskIds: memo.taskIds || []
    });
  }

  function openTaskFromPolicy(id) {
    const policy = findById(app.state.policies, id);
    if (!policy) return;
    openTaskForm(null, {
      title: policy.title || "運営情報タスク",
      actionDate: policy.periodStart || app.state.ui.selectedDate || todayIso(),
      dueDate: policy.periodEnd || "",
      priority: "SUB",
      departmentId: policy.departmentId,
      memoIds: policy.memoIds || []
    });
  }

  function openMemoFromPolicy(id) {
    const policy = findById(app.state.policies, id);
    if (!policy) return;
    openMemoForm(null, {
      title: policy.title || "運営情報メモ",
      body: getPolicyContent(policy) || policy.title,
      priority: "SUB",
      departmentId: policy.departmentId,
      taskIds: policy.taskIds || []
    });
  }

  function buildTaskReferenceText(task) {
    return [
      task.description,
      task.actionDate ? `実施: ${formatShortDate(task.actionDate)}` : "",
      task.dueDate ? `DL: ${formatShortDate(task.dueDate)}` : "",
      task.assignee ? `担当: ${task.assignee}` : ""
    ].filter(Boolean).join("\n") || task.title || "";
  }

  async function saveQuickMemo() {
    await ensureRecordingStopped();
    const textarea = document.getElementById("quickMemoText");
    const body = textarea?.value.trim() || "";
    const transcriptDraft = document.querySelector("[data-recording-transcript-draft]")?.value || "";
    const transcript = appendUniqueText(app.pendingRecordingTranscript, transcriptDraft).trim();
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
    await stopTranscription();
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
    app.recognitionStopPromise = new Promise((resolve) => {
      app.recognitionStopResolve = resolve;
    });
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
      app.recognitionStopResolve?.();
      app.recognitionStopPromise = null;
      app.recognitionStopResolve = null;
      updateRecordingButtons();
    });
    try {
      recognition.start();
      app.recognition = recognition;
      updateRecordingButtons(options.recording ? "録音中 / 文字起こし中" : "文字起こし中");
      return true;
    } catch {
      app.recognition = null;
      app.recognitionStopResolve?.();
      app.recognitionStopPromise = null;
      app.recognitionStopResolve = null;
      updateRecordingButtons(app.mediaRecorder ? "録音中（文字起こし開始失敗）" : "");
      showToast("文字起こしを開始できませんでした。");
      return false;
    }
  }

  async function stopTranscription(options = {}) {
    const recognition = app.recognition;
    const stopPromise = app.recognitionStopPromise;
    app.recognition = null;
    if (recognition) {
      try {
        if (options.abort && typeof recognition.abort === "function") recognition.abort();
        else recognition.stop();
      } catch {}
    }
    updateRecordingButtons();
    if (stopPromise) await Promise.race([stopPromise, wait(900)]);
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
    document.querySelectorAll("[data-recording-transcript-draft]").forEach((field) => {
      field.value = clean;
    });
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
    app.recognitionStopPromise = null;
    app.recognitionStopResolve = null;
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

  function appendUniqueText(base, addition) {
    const left = String(base || "").trim();
    const right = String(addition || "").trim();
    if (!left) return right;
    if (!right) return left;
    if (left.includes(right)) return left;
    if (right.includes(left)) return right;
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
        ${renderSheetHeader("設定", "")}
        <form id="settingsForm" class="settings-grid">
          <section class="settings-block">
            <label class="toolbar">
              <input name="showCompleted" type="checkbox" ${app.state.settings.showCompleted ? "checked" : ""}>
              完了済みを表示
            </label>
          </section>
          <section class="settings-block settings-collapsible">
            <div class="section-head">
              <button class="collapse-toggle" type="button" data-action="toggle-settings-panel" data-target="departmentRows" aria-expanded="false">
                <span class="collapse-mark">＋</span>
                <span class="section-title">${CLASSIFICATION_LABEL}</span>
                <span class="section-count">${app.state.departments.length}件</span>
              </button>
              <button class="mini-button" type="button" data-action="add-department">追加</button>
            </div>
            <div class="list-editor is-collapsed" id="departmentRows">
              ${app.state.departments.map((department) => renderDepartmentRow(department)).join("")}
            </div>
          </section>
          <section class="settings-block settings-collapsible">
            <div class="section-head">
              <button class="collapse-toggle" type="button" data-action="toggle-settings-panel" data-target="policyTypeRows" aria-expanded="false">
                <span class="collapse-mark">＋</span>
                <span class="section-title">運営情報の種別</span>
                <span class="section-count">${getPolicyTypes().length}件</span>
              </button>
              <button class="mini-button" type="button" data-action="add-policy-type">追加</button>
            </div>
            <div class="list-editor is-collapsed" id="policyTypeRows">
              ${getPolicyTypes().map((type) => renderPolicyTypeRow(type)).join("")}
            </div>
          </section>
          <section class="settings-block">
            <h2 class="section-title">外部LLM連携準備</h2>
            <div class="field-inline">
              <div class="field">
                <label for="settingsLlmProvider">連携名</label>
                <input id="settingsLlmProvider" name="llmProvider" value="${escapeAttr(app.state.settings.llmProvider || "")}" autocomplete="off" placeholder="Copilot / Power Automate など">
              </div>
              <div class="field">
                <label for="settingsLlmEndpoint">エンドポイント</label>
                <input id="settingsLlmEndpoint" name="llmEndpoint" value="${escapeAttr(app.state.settings.llmEndpoint || "")}" autocomplete="off" placeholder="https:// または http://localhost">
              </div>
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
          <section class="settings-block settings-collapsible">
            <div class="section-head">
              <button class="collapse-toggle" type="button" data-action="toggle-settings-panel" data-target="deletedRows" aria-expanded="false">
                <span class="collapse-mark">＋</span>
                <span class="section-title">削除済み</span>
                <span class="section-count">${app.state.deletedItems.length}件</span>
              </button>
            </div>
            <div class="list-editor is-collapsed" id="deletedRows">
              ${renderDeletedItems()}
            </div>
          </section>
          <div class="form-actions">
            <button class="solid-button" type="submit">設定を保存</button>
          </div>
        </form>
      </div>
    `);
  }

  function renderDeletedItems() {
    if (!app.state.deletedItems.length) return `<p class="body-preview">削除したタスク、メモ、運営情報はここにまとまります。</p>`;
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
    return ({ tasks: "タスク", memos: "メモ", policies: OPERATIONS_LABEL })[kind] || "項目";
  }

  function renderDepartmentRow(department) {
    return `
      <div class="list-row" data-row="department" data-id="${escapeAttr(department.id)}">
        <button class="drag-handle" type="button" data-drag-handle aria-label="ドラッグして分類を並び替え">☰</button>
        <input name="departmentName" value="${escapeAttr(department.name)}" aria-label="分類名">
        <button class="mini-button" type="button" data-action="remove-settings-row">削除</button>
      </div>
    `;
  }

  function renderPolicyTypeRow(type) {
    const id = uid("policy-type");
    return `
      <div class="list-row" data-row="policyType" data-id="${escapeAttr(id)}">
        <button class="drag-handle" type="button" data-drag-handle aria-label="ドラッグして種別を並び替え">☰</button>
        <input name="policyTypeName" value="${escapeAttr(type)}" aria-label="運営情報の種別">
        <button class="mini-button" type="button" data-action="remove-settings-row">削除</button>
      </div>
    `;
  }

  function addSettingsRow(type) {
    if (type === "department") {
      const target = document.getElementById("departmentRows");
      target?.insertAdjacentHTML("beforeend", renderDepartmentRow({ id: uid("dept"), name: "新しい分類" }));
      setSettingsPanelOpen("departmentRows", true);
    }
    if (type === "policyType") {
      const target = document.getElementById("policyTypeRows");
      target?.insertAdjacentHTML("beforeend", renderPolicyTypeRow("新しい種別"));
      setSettingsPanelOpen("policyTypeRows", true);
    }
  }

  function toggleSettingsPanel(button) {
    const targetId = button.dataset.target || "";
    const target = document.getElementById(targetId);
    setSettingsPanelOpen(targetId, target?.classList.contains("is-collapsed"));
  }

  function setSettingsPanelOpen(targetId, open) {
    const target = document.getElementById(targetId);
    const button = [...document.querySelectorAll('[data-action="toggle-settings-panel"]')]
      .find((item) => item.dataset.target === targetId);
    if (!target || !button) return;
    target.classList.toggle("is-collapsed", !open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
    const mark = button.querySelector(".collapse-mark");
    if (mark) mark.textContent = open ? "－" : "＋";
  }

  async function handleSettingsSubmit(form) {
    const data = new FormData(form);
    const now = nowIso();
    app.state.settings.showCompleted = data.get("showCompleted") === "on";
    app.state.settings.showLinkedMemos = true;
    app.state.settings.llmProvider = String(data.get("llmProvider") || "").trim();
    app.state.settings.llmEndpoint = String(data.get("llmEndpoint") || "").trim();
    app.state.departments = [...form.querySelectorAll('[data-row="department"]')].map((row, index) => ({
      id: row.dataset.id || uid("dept"),
      name: row.querySelector("input")?.value.trim() || "未名称",
      parentId: "",
      sortOrder: index + 1,
      createdAt: findById(app.state.departments, row.dataset.id)?.createdAt || now,
      updatedAt: now
    }));
    app.state.settings.policyTypes = normalizePolicyTypes([...form.querySelectorAll('[data-row="policyType"] input')]
      .map((input) => input.value.trim())
      .filter(Boolean));
    app.state.projects = [];
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
    showToast(`${result.tasks}件のタスク、${result.memos}件のメモ、${result.policies || 0}件の運営情報を取り込みました。`);
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
    showToast(`${result.tasks}件のタスク、${result.memos}件のメモ、${result.policies || 0}件の運営情報を取り込みました。`);
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

  function moveSettingsRow(button) {
    const row = button.closest(".list-row");
    const parent = row?.parentElement;
    if (!row || !parent) return;
    if (button.dataset.direction === "up" && row.previousElementSibling) {
      parent.insertBefore(row, row.previousElementSibling);
    }
    if (button.dataset.direction === "down" && row.nextElementSibling) {
      parent.insertBefore(row.nextElementSibling, row);
    }
  }

  function handleSettingsDragStart(event) {
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle) return;
    const row = handle.closest(".list-row");
    const list = row?.parentElement;
    if (!row || !list || list.classList.contains("is-collapsed")) return;
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    row.classList.add("is-dragging");
    app.settingsDrag = {
      pointerId: event.pointerId,
      row,
      list,
      handle
    };
  }

  function handleSettingsDragMove(event) {
    const drag = app.settingsDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest(".list-row");
    if (!targetRow || targetRow === drag.row || targetRow.parentElement !== drag.list) return;
    const rect = targetRow.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    drag.list.insertBefore(drag.row, before ? targetRow : targetRow.nextElementSibling);
  }

  function handleSettingsDragEnd(event) {
    const drag = app.settingsDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.row.classList.remove("is-dragging");
    drag.handle.releasePointerCapture?.(event.pointerId);
    app.settingsDrag = null;
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
      showToast(`${imported.tasks.length}件のタスクを指定ファイルで上書きし、${imported.policies.length}件の運営情報を同期しました。`);
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
        policy: policy.policy || policy.content || "",
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
        policyTypes: normalizePolicyTypes(payload.settings.policyTypes || app.state.settings.policyTypes),
        appliedTaskImportId: importId
      };
    }
    app.state.tasks = Array.isArray(payload.tasks) ? payload.tasks.map(normalizeTask) : app.state.tasks;
    app.state.memos = Array.isArray(payload.memos) ? payload.memos.map(normalizeMemo) : app.state.memos;
    app.state.policies = Array.isArray(payload.policies) ? payload.policies.map(normalizePolicy) : app.state.policies;
    app.state.departments = normalizeDepartments(payload.departments, app.state.departments);
    app.state.projects = [];
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
        projectId: ""
      })).filter((task) => task.title),
      memos: (source.memos || source.notes || []).map((memo) => ({
        title: memo.title || firstLine(memo.body || memo.content) || "メモ",
        body: memo.body || memo.content || "",
        agenda: memo.agenda || memo.論点 || memo.議題 || "",
        decisions: memo.decisions || memo.方針 || memo.決定 || "",
        nextActions: memo.nextActions || memo.行動 || memo.次 || "",
        transcript: memo.transcript || memo.文字起こし || "",
        dueDate: "",
        priority: normalizePriority(memo.priority || memo.優先度),
        departmentId: matchDepartmentId(memo.department || memo.departmentName || memo.category || memo.categoryName || memo.分類 || memo.部門),
        projectId: ""
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
        projectId: ""
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
      projects: [],
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
    showDialogWithLaunch(entityDialog);
  }

  function showDialogWithLaunch(dialog) {
    dialog.classList.remove("is-launching");
    if (!dialog.open) dialog.showModal();
    applyDialogOrigin(dialog);
    const sheet = dialog.querySelector(".sheet");
    if (sheet) void sheet.offsetWidth;
    dialog.classList.add("is-launching");
  }

  function setDialogOriginFromElement(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height)) return;
    app.dialogOrigin = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function applyDialogOrigin(dialog) {
    const sheet = dialog.querySelector(".sheet");
    const origin = app.dialogOrigin;
    if (!sheet || !origin) {
      dialog.style.removeProperty("--sheet-origin-x");
      dialog.style.removeProperty("--sheet-origin-y");
      return;
    }
    const rect = sheet.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clampNumber(((origin.x - rect.left) / rect.width) * 100, -18, 118, 50);
    const y = clampNumber(((origin.y - rect.top) / rect.height) * 100, -12, 112, 8);
    dialog.style.setProperty("--sheet-origin-x", `${x}%`);
    dialog.style.setProperty("--sheet-origin-y", `${y}%`);
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

  function renderPolicyTypeOptions(current) {
    return `${getPolicyTypes(current).map((type) =>
      `<option value="${escapeAttr(type)}"${selected(current, type)}>${escapeHtml(type)}</option>`
    ).join("")}<option value="${ADD_POLICY_TYPE_VALUE}">＋ 新しい種別を追加</option>`;
  }

  function renderPolicyPeriodField(start = "", end = "") {
    const month = monthKey(dateObject(start || end || todayIso()));
    return `
      <div class="field policy-period-field" data-period-picker data-range-month="${escapeAttr(month)}" data-draft-start="${escapeAttr(start)}" data-draft-end="${escapeAttr(end)}" data-saved-start="${escapeAttr(start)}" data-saved-end="${escapeAttr(end)}">
        <label>期間</label>
        <input id="periodStart" name="periodStart" type="hidden" value="${escapeAttr(start)}">
        <input id="periodEnd" name="periodEnd" type="hidden" value="${escapeAttr(end)}">
        <div class="period-picker" data-period-calendar>
          ${renderPolicyPeriodCalendar(month, start, end)}
        </div>
      </div>
    `;
  }

  function renderPolicyPeriodCalendar(month, start = "", end = "") {
    const current = parseMonthKey(month || monthKey(new Date()));
    const days = buildCalendarDays(current.year, current.month);
    const monthStart = toDateInputValue(new Date(current.year, current.month, 1));
    const monthEnd = toDateInputValue(new Date(current.year, current.month + 1, 0));
    const selectedDates = [...new Set([start, end].filter(Boolean))];
    const beforeDates = selectedDates.filter((date) => date < monthStart).map(formatShortDate);
    const afterDates = selectedDates.filter((date) => date > monthEnd).map(formatShortDate);
    return `
      <div class="period-picker-head">
        <button class="mini-button month-nav-button" type="button" data-action="period-month-prev" aria-label="月を戻す"><span class="month-nav-chevron is-prev" aria-hidden="true"></span></button>
        <span class="period-outside-date">${escapeHtml(beforeDates.join(" / "))}</span>
        <strong>${current.year}年${current.month + 1}月</strong>
        <span class="period-outside-date">${escapeHtml(afterDates.join(" / "))}</span>
        <button class="mini-button month-nav-button" type="button" data-action="period-month-next" aria-label="月を進める"><span class="month-nav-chevron is-next" aria-hidden="true"></span></button>
      </div>
      <div class="period-picker-grid">
        ${["月", "火", "水", "木", "金", "土", "日"].map((day) => `<span>${day}</span>`).join("")}
        ${days.map((day) => {
          const iso = toDateInputValue(day.date);
          const inRange = start && end && iso >= start && iso <= end;
          const classes = [
            "period-date-button",
            day.inMonth ? "" : "is-muted",
            iso === start ? "is-start" : "",
            iso === end ? "is-end" : "",
            inRange ? "is-in-range" : "",
            iso === todayIso() ? "is-today" : ""
          ].filter(Boolean).join(" ");
          return `<button class="${classes}" type="button" data-action="select-period-date" data-date="${iso}">${day.date.getDate()}</button>`;
        }).join("")}
      </div>
      <div class="period-picker-actions">
        <span class="period-save-state">${escapeHtml(periodSaveStateLabel(start, end))}</span>
        <button class="solid-button compact" type="button" data-action="save-policy-period">保存</button>
        <button class="mini-button" type="button" data-action="clear-policy-period">クリア</button>
      </div>
    `;
  }

  function changePolicyPeriodMonth(button, delta) {
    const picker = button.closest("[data-period-picker]");
    if (!picker) return;
    const current = parseMonthKey(picker.dataset.rangeMonth || monthKey(new Date()));
    const date = new Date(current.year, current.month + delta, 1);
    picker.dataset.rangeMonth = monthKey(date);
    refreshPolicyPeriodPicker(picker);
  }

  function selectPolicyPeriodDate(button) {
    const picker = button.closest("[data-period-picker]");
    if (!picker) return;
    const date = button.dataset.date || "";
    const start = picker.dataset.draftStart || "";
    const end = picker.dataset.draftEnd || "";
    if (!start || end) {
      picker.dataset.draftStart = date;
      picker.dataset.draftEnd = "";
    } else if (date === start) {
      picker.dataset.draftEnd = date;
    } else if (date < start) {
      picker.dataset.draftStart = date;
      picker.dataset.draftEnd = start;
    } else {
      picker.dataset.draftEnd = date;
    }
    picker.dataset.rangeMonth = monthKey(dateObject(date));
    refreshPolicyPeriodPicker(picker);
  }

  function savePolicyPeriod(button) {
    const picker = button.closest("[data-period-picker]");
    if (!picker) return;
    const start = picker.dataset.draftStart || "";
    const end = picker.dataset.draftEnd || "";
    const startInput = picker.querySelector('input[name="periodStart"]');
    const endInput = picker.querySelector('input[name="periodEnd"]');
    if (startInput) startInput.value = start;
    if (endInput) endInput.value = end;
    picker.dataset.savedStart = start;
    picker.dataset.savedEnd = end;
    refreshPolicyPeriodPicker(picker);
    const status = picker.querySelector(".period-save-state");
    const saveButton = picker.querySelector('[data-action="save-policy-period"]');
    status?.classList.add("is-confirmed");
    saveButton?.classList.add("is-confirmed");
    window.setTimeout(() => {
      status?.classList.remove("is-confirmed");
      saveButton?.classList.remove("is-confirmed");
    }, 900);
    showToast("期間を保存しました。");
  }

  function clearPolicyPeriod(button) {
    const picker = button.closest("[data-period-picker]");
    if (!picker) return;
    picker.dataset.draftStart = "";
    picker.dataset.draftEnd = "";
    refreshPolicyPeriodPicker(picker);
  }

  function refreshPolicyPeriodPicker(picker) {
    const start = picker.dataset.draftStart || "";
    const end = picker.dataset.draftEnd || "";
    const calendar = picker.querySelector("[data-period-calendar]");
    if (calendar) calendar.innerHTML = renderPolicyPeriodCalendar(picker.dataset.rangeMonth, start, end);
  }

  function periodSaveStateLabel(start = "", end = "") {
    return formatPolicyPeriodRange(start, end) || "期間なし";
  }

  function formatPolicyPeriodRange(start = "", end = "") {
    if (start && end) return `${formatShortDate(start)}-${formatShortDate(end)}`;
    if (start) return `${formatShortDate(start)}-`;
    if (end) return `-${formatShortDate(end)}`;
    return "";
  }

  function renderDepartmentOptions(current) {
    return `<option value="">未設定</option>${app.state.departments.map((department) =>
      `<option value="${escapeAttr(department.id)}"${selected(current, department.id)}>${escapeHtml(department.name)}</option>`
    ).join("")}<option value="${ADD_DEPARTMENT_VALUE}">＋ 新しい分類を追加</option>`;
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
    `;
  }

  function renderMemoOptions(currentIds) {
    return app.state.memos.map((memo) =>
      `<option value="${escapeAttr(memo.id)}"${currentIds.includes(memo.id) ? " selected" : ""}>${escapeHtml(memo.title)}</option>`
    ).join("");
  }

  function renderMemoPicker(currentIds) {
    const current = new Set(currentIds || []);
    const memos = [...app.state.memos].sort((a, b) =>
      Number(current.has(b.id)) - Number(current.has(a.id)) ||
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
    if (!memos.length) return `<p class="body-preview">関連付けできるメモはまだありません。</p>`;
    return `
      <div class="memo-picker">
        <input id="taskMemoSearch" type="search" data-memo-search placeholder="メモを検索（タイトル・本文・文字起こし）" autocomplete="off">
        <div class="memo-picker-list" data-memo-picker-list>
          ${memos.map((memo) => {
            const preview = truncate(getMemoPreviewText(memo), 120);
            const searchText = normalizeSearchText([memo.title, memo.body, memo.transcript, memo.agenda, memo.decisions, memo.nextActions].filter(Boolean).join(" "));
            return `
              <label class="memo-picker-item ${current.has(memo.id) ? "is-linked" : ""}" data-search-text="${escapeAttr(searchText)}">
                <input type="checkbox" name="memoIds" value="${escapeAttr(memo.id)}"${current.has(memo.id) ? " checked" : ""}>
                <span>
                  <strong>${escapeHtml(memo.title || "メモ")}</strong>
                  ${current.has(memo.id) ? `<small>現在紐付け中</small>` : ""}
                  ${preview ? `<small>${escapeHtml(preview)}</small>` : ""}
                </span>
              </label>
            `;
          }).join("")}
        </div>
      </div>
    `;
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
      <div id="memoTasks" class="task-picker">
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

  function filterMemoPicker(input) {
    const picker = input.closest(".memo-picker");
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
    return false;
  }

  function isTaskCompletedForDate(task, date = "") {
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
    const interval = recurrence.type === "monthly-nth" ? 1 : recurrence.interval;
    if (monthDistance % interval !== 0) return false;

    if (recurrence.type === "monthly-day") {
      return target.getDate() === recurrence.monthDay;
    }
    if (recurrence.type === "monthly-start") {
      return target.getDate() === 1;
    }
    if (recurrence.type === "monthly-end") {
      return target.getDate() === lastDayOfMonth(target.getFullYear(), target.getMonth());
    }
    if (recurrence.type === "monthly-nth") {
      return target.getDay() === recurrence.weekday && recurrence.nthOrdinals.includes(nthWeekdayOfMonth(target));
    }
    return false;
  }

  function getNextRecurrenceDate(task, fromDate) {
    if (!hasRecurrence(task) || !isIsoDate(fromDate)) return "";
    const recurrence = normalizeRecurrence(task.recurrence);
    if (recurrence.type === "custom") {
      return recurrence.customDates.find((date) => date > fromDate) || "";
    }
    for (let offset = 1; offset <= 370; offset += 1) {
      const candidate = addDays(fromDate, offset);
      if (recurrenceMatchesDate(task, candidate)) return candidate;
    }
    return "";
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
    if (recurrence.type === "monthly-start") return "毎月月初";
    if (recurrence.type === "monthly-end") return "毎月月末";
    if (recurrence.type === "monthly-nth") return `毎月第${recurrence.nthOrdinals.join(",")} ${weekdayLabels[recurrence.weekday]}曜`;
    if (recurrence.type === "custom") return `カスタム${recurrence.customDates.length}日`;
    return recurrenceLabels[recurrence.type] || "";
  }

  function getLinkedMemos(task) {
    const ids = new Set(task.memoIds || []);
    return app.state.memos.filter((memo) => ids.has(memo.id) || memo.taskIds?.includes(task.id));
  }

  function shouldShowMemos(task, linkedMemos) {
    return Boolean(linkedMemos.length);
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
      else if (/(論点|課題|懸念|確認したい|なぜ|どうする|検討)/.test(line)) agenda.push(line);
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
      if (kind === "memo") return false;
      if (kind === "policy") return isDateInPolicy(todayIso(), item);
    }
    if (filter === "no-date") return kind === "task" ? !item.actionDate : true;
    if (filter === "due") return kind === "task" ? Boolean(item.dueDate) : false;
    if (filter === "no-dept") return !item.departmentId;
    if (filter.startsWith("dept:")) return item.departmentId === filter.slice(5);
    return true;
  }

  function entrySearchText(item, kind) {
    if (kind === "task") {
      return [item.title, item.description, item.assignee, item.actionDate, item.dueDate].filter(Boolean).join(" ");
    }
    if (kind === "memo") {
      return [item.title, item.body, item.agenda, item.decisions, item.nextActions, item.transcript].filter(Boolean).join(" ");
    }
    return [item.title, item.type, getPolicyContent(item)].filter(Boolean).join(" ");
  }

  function matchesCalendarPolicyFilter(policy, filter = "all") {
    if (!filter || filter === "all") return true;
    if (filter === "no-dept") return !policy.departmentId;
    if (filter.startsWith("dept:")) return policy.departmentId === filter.slice(5);
    return true;
  }

  function matchesCalendarPeriodFilter(period, filter = "all") {
    if (!filter || filter === "all") return true;
    if (filter === "no-dept") return !period.departmentId;
    if (filter.startsWith("dept:")) return period.departmentId === filter.slice(5);
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
        summary: firstNonEmpty(getPolicyContent(policy), policy.title),
        source: "policy",
        departmentId: policy.departmentId || "",
        projectId: ""
      }));
    return policyPeriods.filter((period) => period.start && period.end);
  }

  function firstNonEmpty(...values) {
    return values.map((value) => String(value || "").trim()).find(Boolean) || "";
  }

  function getPolicyContent(policy) {
    if (!policy) return "";
    return [policy.policy, policy.background, policy.actions, policy.notes]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n\n");
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
    const flexible = parseFlexibleDate(text);
    if (flexible) return flexible;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const slash = text.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
    if (slash) return `${slash[1]}-${String(slash[2]).padStart(2, "0")}-${String(slash[3]).padStart(2, "0")}`;
    const md = text.match(/^(\d{1,2})[\/月](\d{1,2})/);
    if (md) return dateFromMonthDay(md[1], md[2]);
    return "";
  }

  function parseFlexibleDateList(text) {
    return [...new Set(String(text || "")
      .split(/[\n,、\s]+/)
      .map(parseFlexibleDate)
      .filter(Boolean))]
      .sort();
  }

  function parseFlexibleDate(value) {
    const text = String(value || "").trim().normalize("NFKC");
    if (!text) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    let match = text.match(/^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?$/);
    if (match) return buildIsoDate(match[1], match[2], match[3]);
    match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (match) return buildIsoDate(match[1], match[2], match[3]);
    match = text.match(/^(\d{1,2})[\/.\-月](\d{1,2})日?$/);
    if (match) return dateFromMonthDay(match[1], match[2]);
    match = text.match(/^(\d{2})(\d{2})$/);
    if (match) return dateFromMonthDay(match[1], match[2]);
    return "";
  }

  function buildIsoDate(year, month, day) {
    const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const date = dateObject(candidate);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() === Number(year) &&
      date.getMonth() + 1 === Number(month) &&
      date.getDate() === Number(day)
      ? candidate
      : "";
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

  function normalizeNthOrdinals(values) {
    const source = Array.isArray(values) ? values : [values];
    const normalized = [...new Set(source
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5))]
      .sort((a, b) => a - b);
    return normalized.length ? normalized : [2];
  }

  function normalizeDateList(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map(String)
      .map((value) => parseFlexibleDate(value.trim()) || value.trim())
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
    return "SUB";
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
