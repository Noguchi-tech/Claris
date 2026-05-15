(() => {
  "use strict";

  const DB_NAME = "claris-local-db";
  const DB_VERSION = 1;
  const STORE = "app";
  const STATE_KEY = "state";
  const BUNDLED_TASK_IMPORT_URL = "./data/current-todo-tasks-2026-05-15.json";
  const SINGLE_SLOT_PRIORITIES = ["P1", "P2", "P3"];
  const PERIOD_LINE_CLASS_COUNT = 6;

  const priorityMeta = {
    P1: { label: "最優先", className: "priority-p1" },
    P2: { label: "2次優先", className: "priority-p2" },
    P3: { label: "3次優先", className: "priority-p3" },
    SUB: { label: "サブタスク", className: "priority-sub" },
    NONE: { label: "未設定", className: "priority-none" }
  };

  const tabs = {
    today: "今日",
    calendar: "カレンダー",
    tasks: "タスク",
    memos: "メモ",
    policies: "方針"
  };

  const defaultDepartments = [
    ["dept_store", "店舗全体", ""],
    ["dept_food", "食品", ""],
    ["dept_clothing", "衣服", ""],
    ["dept_life", "生活", ""],
    ["dept_large", "大型", ""],
    ["dept_kitchen", "キッチン", "dept_life"],
    ["dept_houseware", "ハウスウェア", "dept_life"],
    ["dept_other", "その他", ""]
  ];

  const app = {
    state: null,
    db: null,
    pendingConflict: null,
    mediaRecorder: null,
    recordingChunks: [],
    recordingStartedAt: 0,
    recordingBaseText: "",
    recordingTranscript: "",
    recordingStream: null,
    recognition: null,
    toastTimer: 0
  };

  const entityDialog = document.getElementById("entityDialog");
  const conflictDialog = document.getElementById("conflictDialog");
  const view = document.getElementById("view");
  const viewTitle = document.getElementById("viewTitle");
  const todayLabel = document.getElementById("todayLabel");
  const workerLabel = document.getElementById("workerLabel");
  const toast = document.getElementById("toast");

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    app.db = await openDatabase();
    app.state = await loadState();
    await applyBundledTaskImport();
    render();
    registerServiceWorker();
  }

  function bindEvents() {
    document.body.addEventListener("click", handleClick);
    document.body.addEventListener("change", handleChange);
    document.body.addEventListener("input", handleInput);
    document.addEventListener("submit", handleSubmit);
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
      projects: []
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
      departments: Array.isArray(saved.departments) && saved.departments.length ? saved.departments : base.departments,
      projects: Array.isArray(saved.projects) ? saved.projects : []
    };
    merged.tasks = merged.tasks.map(normalizeTask);
    merged.memos = merged.memos.map(normalizeMemo);
    return merged;
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
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso(),
      completedAt: task.completedAt || null
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

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      showToast("オフライン用キャッシュの登録に失敗しました。通常利用は可能です。");
    }
  }

  function render() {
    const activeTab = app.state.ui.activeTab || "today";
    viewTitle.textContent = tabs[activeTab] || "今日";
    todayLabel.textContent = formatLongDate(todayIso());
    workerLabel.textContent = buildHeaderAssigneeLabel();
    renderNav(activeTab);
    if (activeTab === "calendar") renderCalendarView();
    if (activeTab === "tasks") renderTasksView();
    if (activeTab === "today") renderTodayView();
    if (activeTab === "memos") renderMemosView();
    if (activeTab === "policies") renderPoliciesView();
  }

  function renderNav(activeTab) {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === activeTab);
    });
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
    const todayTasks = sortTasks(activeTasks.filter((task) => task.actionDate === date));
    const overdue = sortTasks(activeTasks.filter((task) => task.dueDate && task.dueDate < date && task.actionDate !== date));
    const completedToday = sortTasks(app.state.tasks.filter((task) => task.status === "completed" && task.completedAt?.startsWith(date)));
    const relatedPolicies = app.state.policies.filter((policy) => isDateInPolicy(date, policy));

    view.innerHTML = `
      <section class="dashboard-grid" aria-label="今日の数">
        ${renderStat("実施", todayTasks.length)}
        ${renderStat("DL超過", overdue.length)}
        ${renderStat("メモ", app.state.memos.length)}
        ${renderStat("方針", relatedPolicies.length)}
      </section>
      ${overdue.length ? renderTaskSection("DL超過", overdue, "DLが過ぎています") : ""}
      ${["P1", "P2", "P3", "SUB"].map((priority) => {
        const tasks = todayTasks.filter((task) => task.priority === priority);
        const emptyAction = priority === "SUB" ? "" : `<button class="mini-button" type="button" data-action="add-task-slot" data-priority="${priority}" data-date="${date}">この枠に追加</button>`;
        return renderTaskSection(priorityMeta[priority].label, tasks, "空き", emptyAction);
      }).join("")}
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">今日に関係する方針</h2>
          <span class="section-count">${relatedPolicies.length}件</span>
        </div>
        <div class="policy-list">
          ${relatedPolicies.length ? relatedPolicies.map(renderPolicyCard).join("") : renderEmpty("今日の期間に入る方針はありません。", "方針を追加")}
        </div>
      </section>
      ${app.state.settings.showCompleted ? renderTaskSection("今日完了", completedToday, "今日完了したタスクはありません") : ""}
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
          ${app.state.departments.map((department) => `<option value="dept:${escapeAttr(department.id)}"${selected(filter, `dept:${department.id}`)}>部門: ${escapeHtml(department.name)}</option>`).join("")}
          ${app.state.projects.map((project) => `<option value="project:${escapeAttr(project.id)}"${selected(filter, `project:${project.id}`)}>PJ: ${escapeHtml(project.name)}</option>`).join("")}
        </select>
      </section>
      ${renderTaskSection("未完了", filtered, "該当するタスクはありません")}
      ${app.state.settings.showCompleted ? renderTaskSection("完了済み", completed, "完了済みタスクはありません") : ""}
    `;
  }

  function renderCalendarView() {
    const current = parseMonthKey(app.state.ui.calendarMonth || monthKey(new Date()));
    const selectedDate = app.state.ui.selectedDate || todayIso();
    const days = buildCalendarDays(current.year, current.month);
    const selectedTasks = sortCalendarTasks(app.state.tasks.filter((task) => task.actionDate === selectedDate || task.dueDate === selectedDate));
    const selectedPolicies = app.state.policies.filter((policy) => isDateInPolicy(selectedDate, policy));

    view.innerHTML = `
      <section class="calendar-shell">
        <div class="calendar-header">
          <button class="mini-button" type="button" data-action="month-prev">前月</button>
          <h2 class="section-title">${current.year}年${current.month + 1}月</h2>
          <button class="mini-button" type="button" data-action="month-next">翌月</button>
        </div>
        <div class="calendar-grid" aria-label="カレンダー">
          ${["日", "月", "火", "水", "木", "金", "土"].map((day) => `<div class="weekday">${day}</div>`).join("")}
          ${days.map((day) => renderDayCell(day, selectedDate)).join("")}
        </div>
        ${renderCalendarPolicyFocus(selectedDate)}
        <div class="calendar-day-detail">
          <div class="section-head">
            <h2 class="section-title">${formatLongDate(selectedDate)}の予定</h2>
            <button class="mini-button" type="button" data-action="add-task-slot" data-priority="P2" data-date="${selectedDate}">追加</button>
          </div>
          ${selectedTasks.length ? `<div class="task-list">${selectedTasks.map(renderTaskCard).join("")}</div>` : `<p class="body-preview">この日の作業またはDLタスクはありません。</p>`}
          ${selectedPolicies.length ? `<div class="policy-list">${selectedPolicies.map(renderPolicyCard).join("")}</div>` : ""}
        </div>
      </section>
    `;
  }

  function renderDayCell(day, selectedDate) {
    const iso = toDateInputValue(day.date);
    const actionTasks = app.state.tasks.filter((task) => task.status === "active" && task.actionDate === iso);
    const dueTasks = app.state.tasks.filter((task) => task.status === "active" && task.dueDate === iso);
    const policyCount = app.state.policies.filter((policy) => isDateInPolicy(iso, policy)).length;
    const classes = [
      "day-cell",
      day.inMonth ? "" : "is-muted",
      iso === todayIso() ? "is-today" : "",
      iso === selectedDate ? "is-selected" : "",
      dueTasks.length ? "has-due" : ""
    ].filter(Boolean).join(" ");
    return `
      <button class="${classes}" type="button" data-action="select-day" data-date="${iso}">
        <span class="day-number">${day.date.getDate()}</span>
        ${renderDayPrioritySummary(actionTasks)}
        ${actionTasks.length ? `<span class="day-badge">作業 ${actionTasks.length}</span>` : ""}
        ${dueTasks.length ? `<span class="day-badge due-badge">DL ${dueTasks.length}</span>` : ""}
        ${policyCount ? `<span class="day-badge">方針 ${policyCount}</span>` : ""}
        ${renderCalendarPeriodLines(iso)}
      </button>
    `;
  }

  function renderDayPrioritySummary(actionTasks) {
    const count = (priority) => actionTasks.filter((task) => task.priority === priority).length;
    return `
      <span class="day-priority-row" aria-label="作業優先度">
        <span>最${count("P1") ? "○" : "×"}</span>
        <span>2次${count("P2") ? "○" : "×"}</span>
        <span>3次${count("P3") ? "○" : "×"}</span>
        <span>サブ${count("SUB")}</span>
      </span>
    `;
  }

  function renderCalendarPeriodLines(isoDate) {
    const periods = getCalendarPeriodsForDate(isoDate).slice(0, 3);
    if (!periods.length) return "";
    return `
      <span class="period-lines" aria-label="期間">
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

  function renderCalendarPolicyFocus(date) {
    const policies = app.state.policies.filter((policy) => isDateInPolicy(date, policy));
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
          <div class="policy-focus-card">
            <span class="policy-focus-label">${label}</span>
            <strong>${escapeHtml(items[0].title)}</strong>
            ${items[0].policy ? `<span>${escapeHtml(truncate(items[0].policy, 46))}</span>` : ""}
          </div>
        `).join("")}
        ${other.slice(0, 2).map((policy) => `
          <div class="policy-focus-card">
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
      <section class="quick-capture">
        <div class="section-head">
          <h2 class="section-title">走り書きメモ</h2>
          <span class="recording-status" id="recordingStatus">録音待機中</span>
        </div>
        <textarea id="quickMemoText" placeholder="とっさの話し合い、指示、気づきをそのまま入力"></textarea>
        <div class="recording-bar">
          <button class="solid-button compact" type="button" data-action="save-quick-memo">保存</button>
          <button class="ghost-button compact" type="button" data-action="start-recording">録音＋文字起こし</button>
          <button class="ghost-button compact" type="button" data-action="stop-recording" disabled>停止</button>
        </div>
      </section>
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
    updateRecordingButtons();
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

  function renderStat(label, value) {
    return `
      <div class="stat-tile">
        <div class="stat-value">${value}</div>
        <div class="stat-label">${escapeHtml(label)}</div>
      </div>
    `;
  }

  function renderTaskSection(title, tasks, emptyText, actionHtml = "") {
    return `
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">${escapeHtml(title)}</h2>
          <span class="section-count">${tasks.length}件</span>
        </div>
        <div class="task-list">
          ${tasks.length ? tasks.map(renderTaskCard).join("") : renderEmpty(emptyText, "", actionHtml)}
        </div>
      </section>
    `;
  }

  function renderEmpty(text, addLabel = "", actionHtml = "") {
    const addButton = addLabel ? `<button class="mini-button" type="button" data-action="open-add">${escapeHtml(addLabel)}</button>` : "";
    return `<div class="empty-state"><p>${escapeHtml(text)}</p><div class="card-actions">${actionHtml}${addButton}</div></div>`;
  }

  function renderTaskCard(task) {
    const priority = priorityMeta[task.priority] || priorityMeta.NONE;
    const department = findById(app.state.departments, task.departmentId);
    const project = findById(app.state.projects, task.projectId);
    const linkedMemos = getLinkedMemos(task);
    const memoSummary = shouldShowMemos(task, linkedMemos)
      ? `<div class="memo-summary">${linkedMemos.map((memo) => escapeHtml(summarizeMemo(memo))).join("<br>")}</div>`
      : "";
    const completed = task.status === "completed";
    return `
      <article class="task-card ${completed ? "completed" : ""}">
        <button class="complete-button ${completed ? "is-completed" : ""}" type="button" data-action="toggle-task" data-id="${escapeAttr(task.id)}" aria-label="完了切替"></button>
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
    return `
      <article class="memo-card">
        <div class="section-head">
          <h3>${escapeHtml(memo.title || "メモ")}</h3>
          <span class="priority-pill ${(priorityMeta[memo.priority] || priorityMeta.NONE).className}">${(priorityMeta[memo.priority] || priorityMeta.NONE).label}</span>
        </div>
        <div class="meta-row">
          ${memo.dueDate ? `<span class="tag">DL ${formatShortDate(memo.dueDate)}</span>` : ""}
          ${department ? `<span class="tag">${escapeHtml(department.name)}</span>` : ""}
          ${project ? `<span class="tag">${escapeHtml(project.name)}</span>` : ""}
          ${linkedTasks.length ? `<span class="tag">関連タスク ${linkedTasks.length}</span>` : ""}
          ${recordings.length ? `<span class="tag">録音 ${recordings.length}</span>` : ""}
        </div>
        ${memo.body ? `<p class="body-preview">${escapeHtml(truncate(memo.body, 180))}</p>` : ""}
        ${memo.agenda || memo.decisions || memo.nextActions ? `
          <div class="memo-summary">
            ${memo.agenda ? `<strong>議題</strong> ${escapeHtml(memo.agenda)}<br>` : ""}
            ${memo.decisions ? `<strong>決定</strong> ${escapeHtml(memo.decisions)}<br>` : ""}
            ${memo.nextActions ? `<strong>次</strong> ${escapeHtml(memo.nextActions)}` : ""}
          </div>
        ` : ""}
        ${recordings.length ? `<div class="audio-list">${recordings.map(renderRecording).join("")}</div>` : ""}
        <div class="card-actions">
          <button class="mini-button" type="button" data-action="organize-memo" data-id="${escapeAttr(memo.id)}">整理</button>
          <button class="mini-button" type="button" data-action="edit-memo" data-id="${escapeAttr(memo.id)}">編集</button>
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
      <article class="policy-card">
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
      app.state.ui.activeTab = tabButton.dataset.tab;
      await saveState();
      render();
      return;
    }

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
    if (action === "edit-task") openTaskForm(findById(app.state.tasks, id));
    if (action === "edit-memo") openMemoForm(findById(app.state.memos, id));
    if (action === "edit-policy") openPolicyForm(findById(app.state.policies, id));
    if (action === "toggle-task") await toggleTask(id);
    if (action === "move-today") await moveTaskToToday(id);
    if (action === "assign-today-priority") await assignTaskToToday(id, button.dataset.priority);
    if (action === "duplicate-task") await duplicateTask(id);
    if (action === "delete-task") await deleteEntity("tasks", id, "タスクを削除しました");
    if (action === "delete-memo") await deleteMemo(id);
    if (action === "delete-policy") await deleteEntity("policies", id, "方針を削除しました");
    if (action === "organize-memo") await organizeMemo(id);
    if (action === "memo-to-task") openTaskFromMemo(id);
    if (action === "save-quick-memo") await saveQuickMemo();
    if (action === "start-recording") await startRecording();
    if (action === "stop-recording") stopRecording();
    if (action === "start-transcription") startTranscription();
    if (action === "stop-transcription") stopTranscription();
    if (action === "month-prev") await changeMonth(-1);
    if (action === "month-next") await changeMonth(1);
    if (action === "select-day") await selectDay(button.dataset.date);
    if (action === "resolve-conflict") await resolveConflict(button.dataset.mode);
    if (action === "back-to-task-form") reopenPendingTaskForm();
    if (action === "export-json") exportJson();
    if (action === "export-master-json") exportMasterJson();
    if (action === "run-import") await runImportFromDialog();
    if (action === "add-department") addSettingsRow("department");
    if (action === "add-project") addSettingsRow("project");
    if (action === "remove-settings-row") button.closest(".list-row")?.remove();
  }

  async function handleChange(event) {
    if (event.target.id === "taskFilter") {
      app.state.ui.taskFilter = event.target.value;
      await saveState();
      render();
    }
  }

  function handleInput(event) {
    if (event.target.matches("[data-task-search]")) {
      filterTaskPicker(event.target);
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

  function openAddForCurrentContext() {
    const activeTab = app.state.ui.activeTab || "today";
    if (activeTab === "memos") {
      openMemoForm();
      return;
    }
    if (activeTab === "policies") {
      openPolicyForm();
      return;
    }
    openTaskForm(null, defaultTaskForCurrentContext());
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
      showLinkedMemos: existing?.showLinkedMemos !== false
    };
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(existing ? "タスク編集" : "タスク追加", "実施日とDLは別々に管理します。")}
        <form id="taskForm" class="form-grid" data-id="${escapeAttr(value.id)}" data-original-action-date="${escapeAttr(existing?.actionDate || "")}" data-original-priority="${escapeAttr(existing?.priority || "")}">
          <div class="field">
            <label for="taskTitle">タスク名</label>
            <input id="taskTitle" name="title" required value="${escapeAttr(value.title)}" autocomplete="off">
          </div>
          <div class="field-inline">
            <div class="field">
              <label for="taskActionDate">実施</label>
              <input id="taskActionDate" name="actionDate" type="date" value="${escapeAttr(value.actionDate)}">
            </div>
            <div class="field">
              <label for="taskDueDate">DL</label>
              <input id="taskDueDate" name="dueDate" type="date" value="${escapeAttr(value.dueDate)}">
            </div>
            <div class="field">
              <label for="taskPriority">優先度</label>
              <select id="taskPriority" name="priority">${renderPriorityOptions(value.priority)}</select>
            </div>
          </div>
          <div class="field-inline">
            <div class="field">
              <label for="taskAssignee">担当者</label>
              <input id="taskAssignee" name="assignee" value="${escapeAttr(value.assignee)}" autocomplete="off" placeholder="任意">
            </div>
            <div class="field">
              <label for="taskDepartment">部門</label>
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
          <div class="field">
            <label for="taskMemos">関連メモ</label>
            <select id="taskMemos" name="memoIds" multiple size="4">${renderMemoOptions(value.memoIds)}</select>
          </div>
          <label class="toolbar">
            <input name="showLinkedMemos" type="checkbox" ${value.showLinkedMemos ? "checked" : ""}>
            このタスクではメモ要約を表示
          </label>
          <div class="form-actions">
            <button class="text-button" type="button" data-action="close-dialog">キャンセル</button>
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
  }

  function openMemoForm(memo = null) {
    const existing = memo ? normalizeMemo(memo) : null;
    openSheet(`
      <div class="sheet">
        ${renderSheetHeader(existing ? "メモ編集" : "メモ追加", "走り書きから始めて、後で議題や決定事項を整えられます。")}
        <form id="memoForm" class="form-grid" data-id="${escapeAttr(existing?.id || "")}">
          <div class="field">
            <label for="memoTitle">タイトル</label>
            <input id="memoTitle" name="title" value="${escapeAttr(existing?.title || "")}" autocomplete="off">
          </div>
          <div class="field">
            <label for="memoBody">本文</label>
            <textarea id="memoBody" name="body" required>${escapeHtml(existing?.body || "")}</textarea>
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
              <label for="memoDepartment">部門</label>
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
            <button class="text-button" type="button" data-action="close-dialog">キャンセル</button>
            <button class="solid-button" type="submit">保存</button>
          </div>
        </form>
      </div>
    `);
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
                ${["月次", "週次", "半期", "部門", "施策", "イベント", "在庫", "売場", "商売計画"].map((type) => `<option value="${type}"${selected(existing.type, type)}>${type}</option>`).join("")}
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
            <label for="policyDepartment">部門</label>
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
            <button class="text-button" type="button" data-action="close-dialog">キャンセル</button>
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
      name: "新しい部門",
      parentId: "",
      sortOrder: app.state.departments.length + 1,
      createdAt,
      updatedAt: createdAt
    });
    saveState().then(() => {
      closeDialogs();
      openSettings();
      showToast("部門を追加しました。設定で名前を変更できます。");
    });
  }

  function renderKindButtons(active) {
    const items = [
      ["task", "タスク", "実施とDL"],
      ["memo", "メモ", "走り書き"],
      ["policy", "方針", "判断材料"],
      ["project", "プロジェクト", "施策管理"],
      ["department", "部門", "分類"]
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
      applyConflictMode(task, conflicts, context, mode);
    }
    upsertById(app.state.tasks, task);
    syncMemoLinksForTask(task);
    await saveState();
    render();
    showToast("タスクを保存しました。");
  }

  function openConflictDialog(task, conflicts) {
    const existingLabel = conflicts.length > 1 ? `既存 ${conflicts.length}件` : "既存";
    conflictDialog.innerHTML = `
      <div class="sheet">
        ${renderSheetHeader("優先度枠が重複しています", `${formatShortDate(task.actionDate)} の ${priorityMeta[task.priority].label} には既存タスクがあります。`)}
        <div class="conflict-compare">
          <section class="conflict-panel conflict-new">
            <span class="conflict-label">新規 / 編集中</span>
            <strong>${escapeHtml(task.title)}</strong>
            <span>${formatConflictSlot(task)}</span>
          </section>
          <section class="conflict-panel conflict-existing">
            <span class="conflict-label">${existingLabel}</span>
            ${conflicts.map((item) => `
              <div class="conflict-existing-item">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${formatConflictSlot(item)}</span>
              </div>
            `).join("")}
          </section>
        </div>
        <div class="choice-grid">
          <button class="choice-button" type="button" data-action="resolve-conflict" data-mode="swap">
            <strong>入れ替える</strong><span>新規/編集タスクをこの枠へ、既存を編集前の枠へ</span>
          </button>
          <button class="choice-button" type="button" data-action="resolve-conflict" data-mode="restore">
            <strong>枠を元に戻す</strong><span>新規/編集タスクを編集前の枠に戻す</span>
          </button>
          <button class="choice-button" type="button" data-action="resolve-conflict" data-mode="existing-available">
            <strong>既存を空き枠へ</strong><span>新規/編集タスクをこの枠に入れる</span>
          </button>
          <button class="choice-button" type="button" data-action="resolve-conflict" data-mode="available">
            <strong>新規を空き枠へ</strong><span>新規/編集タスク側の優先度を空き枠へ</span>
          </button>
          <button class="choice-button" type="button" data-action="resolve-conflict" data-mode="existing-sub">
            <strong>既存をサブタスクへ</strong><span>既存をサブに下げ、新規/編集タスクをこの枠へ</span>
          </button>
          <button class="choice-button" type="button" data-action="resolve-conflict" data-mode="keep">
            <strong>同じ枠へ追加</strong><span>警告を無視して保存</span>
          </button>
          <button class="choice-button" type="button" data-action="back-to-task-form">
            <strong>戻って修正</strong><span>日付や優先度を選び直す</span>
          </button>
        </div>
      </div>
    `;
    conflictDialog.showModal();
  }

  async function resolveConflict(mode) {
    if (!app.pendingConflict) return;
    const { task, context } = app.pendingConflict;
    const conflicts = findPriorityConflicts(task);
    app.pendingConflict = null;
    closeDialogs();
    await saveTaskWithConflict(task, context, mode || "keep");
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
    if (mode === "existing-sub") {
      conflicts.forEach((existing) => {
        existing.priority = "SUB";
        existing.updatedAt = nowIso();
      });
    }
    if (mode === "swap") {
      conflicts.forEach((existing) => {
        existing.actionDate = context.originalActionDate || "";
        existing.priority = context.originalPriority || "NONE";
        existing.updatedAt = nowIso();
      });
    }
    if (mode === "restore") {
      task.actionDate = context.originalActionDate || "";
      task.priority = context.originalPriority || "NONE";
    }
    if (mode === "existing-available") {
      conflicts.forEach((existing) => {
        existing.priority = findAvailablePriority(existing.actionDate, existing.id, [task.priority]);
        existing.updatedAt = nowIso();
      });
    }
    if (mode === "available") {
      task.priority = findAvailablePriority(task.actionDate, task.id);
    }
  }

  function findPriorityConflicts(task) {
    if (!task.actionDate || !SINGLE_SLOT_PRIORITIES.includes(task.priority) || task.status !== "active") return [];
    return app.state.tasks.filter((item) =>
      item.id !== task.id &&
      item.status === "active" &&
      item.actionDate === task.actionDate &&
      item.priority === task.priority
    );
  }

  function findAvailablePriority(actionDate, excludeId, extraUsed = []) {
    const used = new Set(app.state.tasks.filter((task) =>
      task.id !== excludeId &&
      task.status === "active" &&
      task.actionDate === actionDate &&
      SINGLE_SLOT_PRIORITIES.includes(task.priority)
    ).map((task) => task.priority));
    extraUsed.forEach((priority) => used.add(priority));
    return SINGLE_SLOT_PRIORITIES.find((priority) => !used.has(priority)) || "SUB";
  }

  async function handleMemoSubmit(form) {
    const data = new FormData(form);
    const id = form.dataset.id || uid("memo");
    const existing = findById(app.state.memos, id);
    const body = String(data.get("body") || "").trim();
    const now = nowIso();
    const memo = normalizeMemo({
      ...existing,
      id,
      title: String(data.get("title") || "").trim() || firstLine(body) || "メモ",
      body,
      agenda: String(data.get("agenda") || "").trim(),
      decisions: String(data.get("decisions") || "").trim(),
      nextActions: String(data.get("nextActions") || "").trim(),
      dueDate: String(data.get("dueDate") || ""),
      priority: String(data.get("priority") || "NONE"),
      departmentId: String(data.get("departmentId") || ""),
      projectId: String(data.get("projectId") || ""),
      taskIds: data.getAll("taskIds").map(String),
      recordings: existing?.recordings || [],
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
      type: String(data.get("type") || "方針"),
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

  async function toggleTask(id) {
    const task = findById(app.state.tasks, id);
    if (!task) return;
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
    app.state.memos = app.state.memos.filter((memo) => memo.id !== id);
    app.state.tasks.forEach((task) => {
      task.memoIds = task.memoIds.filter((memoId) => memoId !== id);
    });
    await saveState();
    render();
    showToast("メモを削除しました。");
  }

  async function organizeMemo(id) {
    const memo = findById(app.state.memos, id);
    if (!memo) return;
    const organized = organizeText(memo.body);
    memo.title = memo.title || organized.title;
    memo.agenda = memo.agenda || organized.agenda;
    memo.decisions = memo.decisions || organized.decisions;
    memo.nextActions = memo.nextActions || organized.nextActions;
    memo.updatedAt = nowIso();
    await saveState();
    render();
    openMemoForm(memo);
    showToast("メモを整理しました。必要に応じて手直ししてください。");
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
  }

  async function saveQuickMemo() {
    const textarea = document.getElementById("quickMemoText");
    const body = textarea?.value.trim() || "";
    if (!body) {
      showToast("本文を入力してください。");
      return;
    }
    const now = nowIso();
    app.state.memos.unshift(normalizeMemo({
      id: uid("memo"),
      title: firstLine(body) || "走り書きメモ",
      body,
      createdAt: now,
      updatedAt: now
    }));
    textarea.value = "";
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
      const textarea = document.getElementById("quickMemoText");
      app.recordingBaseText = textarea?.value.trim() || "";
      app.recordingTranscript = "";
      app.mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) app.recordingChunks.push(event.data);
      });
      app.mediaRecorder.addEventListener("stop", saveRecordingMemo);
      app.mediaRecorder.start();
      const transcriptionStarted = startTranscription({ recording: true });
      updateRecordingButtons(transcriptionStarted ? "録音中 / 文字起こし中" : "録音中（文字起こし非対応）");
    } catch {
      showToast("録音を開始できませんでした。マイク権限を確認してください。");
    }
  }

  function stopRecording() {
    stopTranscription();
    if (app.mediaRecorder && app.mediaRecorder.state !== "inactive") {
      app.mediaRecorder.stop();
    }
  }

  async function saveRecordingMemo() {
    await wait(300);
    const mimeType = app.mediaRecorder?.mimeType || "audio/webm";
    const blob = new Blob(app.recordingChunks, { type: mimeType });
    const textarea = document.getElementById("quickMemoText");
    const body = combineRecordingText() || "録音メモ";
    const durationSeconds = Math.round((Date.now() - app.recordingStartedAt) / 1000);
    app.recordingStream?.getTracks().forEach((track) => track.stop());
    app.mediaRecorder = null;
    app.recordingStream = null;
    app.recordingBaseText = "";
    app.recordingTranscript = "";
    const now = nowIso();
    app.state.memos.unshift(normalizeMemo({
      id: uid("memo"),
      title: firstLine(body) || "録音メモ",
      body,
      recordings: [{
        id: uid("audio"),
        name: `${formatLongDate(todayIso())} ${durationSeconds}秒`,
        mimeType,
        durationSeconds,
        blob,
        createdAt: now
      }],
      createdAt: now,
      updatedAt: now
    }));
    if (textarea) textarea.value = "";
    await saveState();
    render();
    showToast("録音メモを保存しました。");
  }

  function startTranscription(options = {}) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast("このブラウザでは文字起こしに対応していません。iPhoneの音声入力も使えます。");
      updateRecordingButtons(app.mediaRecorder ? "録音中（文字起こし非対応）" : "");
      return false;
    }
    const textarea = document.getElementById("quickMemoText");
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
          app.recordingTranscript = `${app.recordingTranscript}${finalText}`;
          textarea.value = combineRecordingText();
        } else {
          textarea.value = `${textarea.value}${textarea.value ? "\n" : ""}${finalText}`;
        }
      }
      updateRecordingButtons(options.recording
        ? (interimText ? `録音中: ${interimText}` : "録音中 / 文字起こし中")
        : (interimText ? `文字起こし中: ${interimText}` : "文字起こし中"));
    });
    recognition.addEventListener("end", () => {
      app.recognition = null;
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

  function stopTranscription() {
    app.recognition?.stop();
    app.recognition = null;
    updateRecordingButtons();
  }

  function updateRecordingButtons(status = "") {
    const isRecording = app.mediaRecorder && app.mediaRecorder.state !== "inactive";
    const isRecognizing = Boolean(app.recognition);
    document.querySelectorAll('[data-action="start-recording"]').forEach((button) => { button.disabled = isRecording; });
    document.querySelectorAll('[data-action="stop-recording"]').forEach((button) => { button.disabled = !isRecording; });
    document.querySelectorAll('[data-action="start-transcription"]').forEach((button) => { button.disabled = isRecognizing; });
    document.querySelectorAll('[data-action="stop-transcription"]').forEach((button) => { button.disabled = !isRecognizing; });
    const statusEl = document.getElementById("recordingStatus");
    if (statusEl) statusEl.textContent = status || (isRecording ? "録音中 / 文字起こし中" : "録音待機中");
  }

  function combineRecordingText() {
    const base = app.recordingBaseText.trim();
    const transcript = app.recordingTranscript.trim();
    return [base, transcript].filter(Boolean).join(base && transcript ? "\n" : "");
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
              <h2 class="section-title">部門</h2>
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
            <p class="body-preview">公開URLは誰でも閲覧できるため、ここから直接マスタを書き換えません。iPhoneで編集した内容はマスター上書き用JSONとして出力し、必要時にデータファイルへ反映します。</p>
            <textarea id="settingsImportText" name="settingsImportText" placeholder="JSON / CSV / テキストを貼り付け"></textarea>
            <button class="ghost-button" type="button" data-action="run-import">貼り付け内容を取り込む</button>
          </section>
          <div class="form-actions">
            <button class="text-button" type="button" data-action="close-dialog">閉じる</button>
            <button class="solid-button" type="submit">設定を保存</button>
          </div>
        </form>
      </div>
    `);
  }

  function renderDepartmentRow(department) {
    return `
      <div class="list-row" data-row="department" data-id="${escapeAttr(department.id)}">
        <input name="departmentName" value="${escapeAttr(department.name)}" aria-label="部門名">
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
      document.getElementById("departmentRows")?.insertAdjacentHTML("beforeend", renderDepartmentRow({ id: uid("dept"), name: "新しい部門" }));
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
        ${renderSheetHeader("GPT書き込み", "アプリ側のデータを読ませず、貼り付けた内容だけを追加します。")}
        <form id="importForm" class="form-grid">
          <div class="field">
            <label for="importText">追加内容</label>
            <textarea id="importText" name="importText" required placeholder="JSON / CSV / Microsoft To Do のエクスポートテキスト"></textarea>
          </div>
          <div class="form-actions">
            <button class="text-button" type="button" data-action="close-dialog">キャンセル</button>
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
    showToast(`${result.tasks}件のタスク、${result.memos}件のメモを取り込みました。`);
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
    showToast(`${result.tasks}件のタスク、${result.memos}件のメモを取り込みました。`);
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
      app.state.settings.appliedTaskImportId = importId;
      await saveState();
      showToast(`${imported.tasks.length}件のタスクを指定ファイルで上書きしました。`);
    } catch {
      // 同梱インポートは初期投入用。失敗しても通常利用は止めない。
    }
  }

  async function importText(raw) {
    const text = raw.trim();
    if (!text) return { tasks: 0, memos: 0 };
    let imported = { tasks: [], memos: [], policies: [] };
    try {
      if (/^[{[]/.test(text)) imported = importJson(text);
      else if (looksLikeCsv(text)) imported = importCsv(text);
      else imported = importTodoText(text);
    } catch (error) {
      showToast(`取り込みに失敗しました: ${error.message}`);
      return { tasks: 0, memos: 0 };
    }
    const now = nowIso();
    app.state.tasks.push(...normalizeImportedTasks(imported.tasks, now));
    imported.memos.forEach((memo) => app.state.memos.push(normalizeMemo({ ...memo, id: uid("memo"), createdAt: now, updatedAt: now })));
    imported.policies.forEach((policy) => app.state.policies.push({ ...policy, id: uid("policy"), createdAt: now, updatedAt: now }));
    await saveState();
    return { tasks: imported.tasks.length, memos: imported.memos.length };
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
    app.state.tasks = Array.isArray(payload.tasks) ? payload.tasks.map(normalizeTask) : app.state.tasks;
    app.state.memos = Array.isArray(payload.memos) ? payload.memos.map(normalizeMemo) : app.state.memos;
    app.state.policies = Array.isArray(payload.policies) ? payload.policies : app.state.policies;
    app.state.departments = Array.isArray(payload.departments) && payload.departments.length ? payload.departments : app.state.departments;
    app.state.projects = Array.isArray(payload.projects) ? payload.projects : app.state.projects;
    app.state.updatedAt = now;
  }

  function normalizeImportedTasks(tasks, now) {
    return tasks.map((task) => normalizeTask({
      ...task,
      id: uid("task"),
      status: task.status || "active",
      createdAt: now,
      updatedAt: now
    }));
  }

  function importJson(text) {
    const parsed = JSON.parse(text);
    const source = Array.isArray(parsed) ? { tasks: parsed } : parsed;
    return {
      tasks: (source.tasks || []).map((task) => ({
        title: task.title || task.name || task.task || "",
        description: task.description || task.body || task.content || "",
        assignee: task.assignee || task.owner || task["担当者"] || "",
        actionDate: toDateInputValueFromUnknown(task.actionDate || task.date || task.実施日),
        dueDate: toDateInputValueFromUnknown(task.dueDate || task.dl || task.DL || task.期限日),
        priority: normalizePriority(task.priority || task.優先度),
        departmentId: matchDepartmentId(task.department || task.departmentName || task.部門),
        projectId: matchProjectId(task.project || task.projectName || task.プロジェクト)
      })).filter((task) => task.title),
      memos: (source.memos || source.notes || []).map((memo) => ({
        title: memo.title || firstLine(memo.body || memo.content) || "メモ",
        body: memo.body || memo.content || "",
        agenda: memo.agenda || memo.議題 || "",
        decisions: memo.decisions || memo.決定 || "",
        nextActions: memo.nextActions || memo.次 || "",
        dueDate: toDateInputValueFromUnknown(memo.dueDate || memo.DL || memo.期限),
        priority: normalizePriority(memo.priority || memo.優先度)
      })).filter((memo) => memo.body || memo.title),
      policies: source.policies || []
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
        departmentId: matchDepartmentId(row.department || row.部門),
        projectId: matchProjectId(row.project || row.プロジェクト)
      };
    }).filter((task) => task.title);
    return { tasks, memos: [], policies: [] };
  }

  function importTodoText(text) {
    const tasks = [];
    let current = null;
    text.split(/\r?\n/).forEach((line) => {
      const taskMatch = line.match(/^\s*[◯○]\s*(.+)$/);
      const childMatch = line.match(/^\s*[◦・]\s*(.+)$/);
      if (taskMatch) {
        current = parseTodoLine(taskMatch[1]);
        tasks.push(current);
        return;
      }
      if (childMatch && current) {
        current.description = `${current.description ? `${current.description}\n` : ""}${childMatch[1].trim()}`;
      }
    });
    return { tasks, memos: [], policies: [] };
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
    const tasks = sortTasksByActionDate(app.state.tasks);
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
              <label class="task-picker-item" data-search-text="${escapeAttr(normalizeSearchText(`${task.title} ${meta}`))}">
                <input type="checkbox" name="taskIds" value="${escapeAttr(task.id)}"${current.has(task.id) ? " checked" : ""}>
                <span>
                  <strong>${escapeHtml(task.title)}</strong>
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

  function getCalendarPeriodsForDate(date) {
    return getCalendarPeriods()
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
        type: policy.type || "方針"
      }));
    const projectPeriods = app.state.projects
      .filter((project) => project.startDate || project.endDate)
      .map((project) => ({
        id: project.id,
        title: project.name,
        start: project.startDate || project.endDate,
        end: project.endDate || project.startDate,
        type: "プロジェクト"
      }));
    return [...policyPeriods, ...projectPeriods].filter((period) => period.start && period.end);
  }

  function stableIndex(value, modulo) {
    const text = String(value || "");
    let sum = 0;
    for (let index = 0; index < text.length; index += 1) sum += text.charCodeAt(index);
    return sum % modulo;
  }

  function buildCalendarDays(year, month) {
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
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

  function addDays(isoDate, amount) {
    const date = isoDate ? new Date(`${isoDate}T00:00:00`) : new Date();
    date.setDate(date.getDate() + amount);
    return toDateInputValue(date);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function formatLongDate(isoDate) {
    const date = new Date(`${isoDate}T00:00:00`);
    return new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "long" }).format(date);
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
    const found = app.state.departments.find((department) => department.name === name);
    return found?.id || "";
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
