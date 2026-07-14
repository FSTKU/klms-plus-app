const STORAGE_KEY = "klms-plus-state-v2";
const CLIENT_ID_KEY = "klms-plus-client-id-v1";
const clientId = getOrCreateClientId();
let databaseSaveTimer = null;
let databaseAvailable = false;

const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
const timetableDays = ["月", "火", "水", "木", "金", "土"];

const demoState = {
  user: {
    studentId: "",
    name: "",
    notifyDays: 3,
  },
  assignments: [
    {
      id: crypto.randomUUID(),
      course: "インターネット経済論",
      title: "第1回レポート",
      deadline: getDateTimeLocalOffset(2, 23, 59),
      memo: "400字程度。冒頭に希望業界名を書く。",
      done: false,
      source: "デモ",
      isDemo: true,
    },
    {
      id: crypto.randomUUID(),
      course: "物性物理II",
      title: "結晶中のシュレディンガー方程式",
      deadline: getDateTimeLocalOffset(5, 18, 0),
      memo: "永年方程式の導出を整理。",
      done: false,
      source: "デモ",
      isDemo: true,
    },
    {
      id: crypto.randomUUID(),
      course: "Webアプリ設計",
      title: "三層構成アプリ設計メモ",
      deadline: getDateTimeLocalOffset(-1, 23, 59),
      memo: "KLMS Plusの機能要件を整理。",
      done: true,
      source: "デモ",
      isDemo: true,
    },
  ],
  courses: [
    { id: crypto.randomUUID(), title: "Webアプリ設計", day: "水", period: "2", room: "日吉 J11", syllabus: "", source: "デモ", isDemo: true },
    { id: crypto.randomUUID(), title: "物性物理II", day: "木", period: "3", room: "矢上 12-210", syllabus: "", source: "デモ", isDemo: true },
    { id: crypto.randomUUID(), title: "インターネット経済論", day: "金", period: "4", room: "日吉 D201", syllabus: "", source: "デモ", isDemo: true },
  ],
  classrooms: [
    {
      id: crypto.randomUUID(),
      campus: "日吉",
      building: "第4校舎",
      room: "J11",
      capacity: 120,
      pc: false,
      eat: false,
      outlets: true,
      memo: "机が広く、PC作業しやすい。",
      updatedBy: "公式＋ユーザー投稿",
    },
    {
      id: crypto.randomUUID(),
      campus: "矢上",
      building: "12棟",
      room: "12-210",
      capacity: 80,
      pc: true,
      eat: false,
      outlets: true,
      memo: "実験系の授業で使われやすい。",
      updatedBy: "公式データ",
    },
    {
      id: crypto.randomUUID(),
      campus: "日吉",
      building: "独立館",
      room: "D201",
      capacity: 180,
      pc: false,
      eat: true,
      outlets: false,
      memo: "空き時間の自習に使いやすい。",
      updatedBy: "ユーザー投稿",
    },
    {
      id: crypto.randomUUID(),
      campus: "三田",
      building: "南校舎",
      room: "445",
      capacity: 60,
      pc: false,
      eat: false,
      outlets: true,
      memo: "静かでレポート作成向き。",
      updatedBy: "ユーザー投稿",
    },
  ],
  officialSchedule: [],
  syllabusLastImportedAt: "",
};

let state = loadState();
let selectedFileUrl = null;
let selectedFile = null;

function getOrCreateClientId() {
  const saved = localStorage.getItem(CLIENT_ID_KEY);
  if (saved && /^[a-zA-Z0-9-]{16,100}$/.test(saved)) return saved;
  const created = crypto.randomUUID();
  localStorage.setItem(CLIENT_ID_KEY, created);
  return created;
}

function normalizeState(value) {
  const parsed = value && typeof value === "object" ? value : {};
  return {
    ...structuredClone(demoState),
    ...parsed,
    user: { ...demoState.user, ...(parsed.user || {}) },
    assignments: Array.isArray(parsed.assignments) ? parsed.assignments : structuredClone(demoState.assignments),
    courses: Array.isArray(parsed.courses) ? parsed.courses : structuredClone(demoState.courses),
    classrooms: Array.isArray(parsed.classrooms) ? parsed.classrooms : structuredClone(demoState.classrooms),
    officialSchedule: Array.isArray(parsed.officialSchedule) ? parsed.officialSchedule : [],
    syllabusLastImportedAt: parsed.syllabusLastImportedAt || "",
  };
}

function getDateTimeLocalOffset(days, hour, minute) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return structuredClone(demoState);
  try {
    const parsed = JSON.parse(saved);
    return normalizeState(parsed);
  } catch {
    return structuredClone(demoState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleDatabaseSave();
}

function scheduleDatabaseSave() {
  clearTimeout(databaseSaveTimer);
  databaseSaveTimer = setTimeout(() => {
    persistStateToDatabase().catch((error) => console.warn("Database save failed:", error.message));
  }, 500);
}

async function persistStateToDatabase() {
  const response = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, state }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  databaseAvailable = true;
  return data;
}

async function hydrateStateFromDatabase() {
  try {
    const response = await fetch(`/api/state?clientId=${encodeURIComponent(clientId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    databaseAvailable = true;
    if (data.found && data.state) {
      state = normalizeState(data.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } else {
      await persistStateToDatabase();
    }
    renderAll();
    showToast("PostgreSQLと同期しました");
  } catch (error) {
    databaseAvailable = false;
    console.warn("Database load failed; using localStorage:", error.message);
  }
}

async function handleDatabaseStatus() {
  const output = document.querySelector("#databaseStatusOutput");
  if (!output) return;
  output.textContent = "PostgreSQLへ接続確認中...";
  try {
    const response = await fetch("/api/health");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    databaseAvailable = true;
    output.textContent = `接続成功
database: true
確認時刻: ${data.checkedAt || "取得済み"}
clientId: ${clientId}`;
  } catch (error) {
    databaseAvailable = false;
    output.textContent = `接続失敗
${error.message}
DATABASE_URLとRender PostgreSQLの状態を確認してください。`;
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2200);
}

function formatDateTime(value) {
  if (!value) return "期限未設定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "期限未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function deadlineStatus(deadline, done = false) {
  if (done) return { kind: "done", label: "完了済み", className: "done", days: Infinity };
  if (!deadline) return { kind: "undated", label: "期限未設定", className: "undated", days: Infinity };
  const now = new Date();
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return { kind: "undated", label: "期限未設定", className: "undated", days: Infinity };
  const diffMs = date - now;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffMs < 0) return { kind: "overdue", label: "期限超過済み", className: "overdue", days: diffDays };
  if (diffDays <= 7) {
    const remaining = diffDays < 1 ? "24時間以内" : `${Math.ceil(diffDays)}日以内`;
    return { kind: "within-week", label: `期限前1週間以内（${remaining}）`, className: "urgent", days: diffDays };
  }
  return { kind: "before", label: `期限前（${Math.ceil(diffDays)}日後）`, className: "before", days: diffDays };
}

function assignmentSortValue(item) {
  if (!item.deadline) return Infinity;
  const time = new Date(item.deadline).getTime();
  return Number.isFinite(time) ? time : Infinity;
}

function sanitizeFilePart(text) {
  return String(text || "")
    .trim()
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60) || "未設定";
}

function initializeNavigation() {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-button").forEach((btn) => btn.classList.remove("active"));
      document.querySelectorAll(".page").forEach((page) => page.classList.remove("active-page"));
      button.classList.add("active");
      document.querySelector(`#${button.dataset.target}`).classList.add("active-page");
    });
  });
}

function renderAll() {
  renderHeader();
  renderDashboard();
  renderAssignments();
  renderTimetable();
  renderClassrooms();
  renderSettings();
}

function renderHeader() {
  const today = new Date();
  document.querySelector("#todayText").textContent = new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(today);

  const next = [...state.assignments]
    .filter((item) => !item.done && item.deadline && new Date(item.deadline) >= new Date())
    .sort((a, b) => assignmentSortValue(a) - assignmentSortValue(b))[0];

  document.querySelector("#nextDeadlineText").textContent = next
    ? `次の締切：${next.course}「${next.title}」 ${formatDateTime(next.deadline)}`
    : "未完了の締切はありません";
}

function renderDashboard() {
  const open = state.assignments.filter((item) => !item.done);
  const urgent = open.filter((item) => deadlineStatus(item.deadline).kind === "within-week");
  document.querySelector("#openCount").textContent = open.length;
  document.querySelector("#urgentCount").textContent = urgent.length;
  document.querySelector("#courseCount").textContent = new Set(state.courses.map((course) => course.canvasId || course.title)).size;
  document.querySelector("#roomCount").textContent = state.classrooms.length;

  const upcoming = [...open].sort((a, b) => assignmentSortValue(a) - assignmentSortValue(b)).slice(0, 5);
  document.querySelector("#upcomingList").innerHTML = upcoming.length
    ? upcoming.map(renderCompactAssignment).join("")
    : `<div class="item-card"><p class="meta">未完了の課題はありません。</p></div>`;

  const todayDay = dayNames[new Date().getDay()];
  const todayCourses = state.courses
    .filter((course) => course.day === todayDay)
    .sort((a, b) => Number(a.period) - Number(b.period));
  document.querySelector("#todaySchedule").innerHTML = todayCourses.length
    ? todayCourses.map((course) => `
      <div class="item-card">
        <div class="item-head">
          <div>
            <h4>${escapeHtml(course.period)}限：${escapeHtml(course.title)}</h4>
            <p class="meta">教室：${escapeHtml(course.room || "未設定")}</p>
          </div>
          <span class="badge">${escapeHtml(course.day)}曜</span>
        </div>
      </div>
    `).join("")
    : `<div class="item-card"><p class="meta">今日の登録講義はありません。</p></div>`;
}

function renderCompactAssignment(item) {
  const status = deadlineStatus(item.deadline, item.done);
  return `
    <div class="item-card ${item.done ? "done" : ""}">
      <div class="item-head">
        <div>
          <h4>${escapeHtml(item.title)}</h4>
          <p class="meta">${escapeHtml(item.course)} / 締切：${formatDateTime(item.deadline)}</p>
        </div>
        <span class="badge ${status.className}">${status.label}</span>
      </div>
    </div>
  `;
}

function renderAssignments() {
  const query = document.querySelector("#assignmentSearch")?.value?.trim().toLowerCase() || "";
  const filter = document.querySelector("#assignmentFilter")?.value || "all";

  const filtered = state.assignments
    .filter((item) => {
      const haystack = `${item.course} ${item.title} ${item.memo}`.toLowerCase();
      if (query && !haystack.includes(query)) return false;
      const status = deadlineStatus(item.deadline, item.done);
      if (filter === "open") return !item.done;
      if (filter === "done") return status.kind === "done";
      if (filter === "overdue") return status.kind === "overdue";
      if (filter === "before") return status.kind === "within-week" || status.kind === "before";
      if (filter === "within-week") return status.kind === "within-week";
      if (filter === "later") return status.kind === "before";
      if (filter === "undated") return status.kind === "undated";
      return true;
    })
    .sort((a, b) => assignmentSortValue(a) - assignmentSortValue(b));

  document.querySelector("#assignmentList").innerHTML = filtered.length
    ? filtered.map((item) => {
      const status = deadlineStatus(item.deadline, item.done);
      return `
        <article class="item-card ${item.done ? "done" : ""}">
          <div class="item-head">
            <div>
              <h4>${escapeHtml(item.title)}</h4>
              <p class="meta">講義：${escapeHtml(item.course)}<br>締切：${formatDateTime(item.deadline)}<br>情報源：${escapeHtml(item.source || "手入力")}</p>
            </div>
            <span class="badge ${status.className}">${status.label}</span>
          </div>
          <div class="card-actions">
            <button class="${item.done ? "secondary" : "success"}" data-action="toggle-assignment" data-id="${item.id}">${item.done ? "未完了に戻す" : "完了"}</button>
            <button class="secondary" data-action="use-rename" data-id="${item.id}">ファイル名に使う</button>
            ${item.url ? `<a class="secondary button-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">KLMSで開く</a>` : ""}
            <button class="danger" data-action="delete-assignment" data-id="${item.id}">削除</button>
          </div>
        </article>
      `;
    }).join("")
    : `<div class="item-card"><p class="meta">条件に合う課題はありません。</p></div>`;
}

function renderTimetable() {
  const grid = document.querySelector("#timetableGrid");
  let html = `<div class="head">時限</div>`;
  html += timetableDays.map((day) => `<div class="head">${day}</div>`).join("");

  for (let period = 1; period <= 7; period++) {
    html += `<div class="period">${period}限</div>`;
    for (const day of timetableDays) {
      const courses = state.courses.filter((course) => course.day === day && Number(course.period) === period);
      html += `<div>${courses.map((course) => `
        <div class="course-cell">
          <strong>${escapeHtml(course.title)}</strong>
          <small>${escapeHtml(course.room || "教室未設定")}</small>
          <div class="card-actions">
            <button class="danger" data-action="delete-course" data-id="${course.id}">削除</button>
          </div>
        </div>
      `).join("")}</div>`;
    }
  }
  grid.innerHTML = html;

  const list = document.querySelector("#courseList");
  if (!list) return;
  list.innerHTML = state.courses.length
    ? state.courses.map((course) => `
      <article class="item-card">
        <div class="item-head">
          <div>
            <h4>${escapeHtml(course.title)}</h4>
            <p class="meta">
              曜日・時限：${course.day && course.period ? `${escapeHtml(course.day)}曜 ${escapeHtml(course.period)}限` : "未設定"}<br>
              ${course.startTime ? `時刻：${escapeHtml(course.startTime)}${course.endTime ? `〜${escapeHtml(course.endTime)}` : ""}<br>` : ""}
              教室：${escapeHtml(course.room || "未設定")}<br>
              情報源：${escapeHtml(course.source || "手入力")}${course.scheduleSource ? `（${escapeHtml(course.scheduleSource)}）` : ""}
            </p>
          </div>
          ${course.syllabus ? `<a class="secondary button-link" href="${escapeHtml(course.syllabus)}" target="_blank" rel="noopener">開く</a>` : ""}
        </div>
      </article>
    `).join("")
    : `<div class="item-card"><p class="meta">講義はまだ登録されていません。</p></div>`;
}

function renderClassrooms() {
  const query = document.querySelector("#roomSearch")?.value?.trim().toLowerCase() || "";
  const campus = document.querySelector("#campusFilter")?.value || "all";
  const day = document.querySelector("#roomDayFilter")?.value || dayNames[new Date().getDay()];
  const period = document.querySelector("#roomPeriodFilter")?.value || "";
  const availability = document.querySelector("#roomAvailabilityFilter")?.value || "available";
  const pcOnly = document.querySelector("#pcOnly")?.checked || false;
  const eatOnly = document.querySelector("#eatOnly")?.checked || false;
  const scheduleRows = getKnownScheduleRows();
  const hasExactScheduleData = scheduleRows.some((row) => normalizeRoomKey(row.room));

  const evaluated = state.classrooms.map((room) => {
    const roomKey = normalizeRoomKey(room.room);
    const matchingClasses = scheduleRows.filter((row) => {
      if (!roomKey || normalizeRoomKey(row.room) !== roomKey) return false;
      if (day && row.day !== day) return false;
      if (period && String(row.period) !== String(period)) return false;
      return true;
    });
    return {
      ...room,
      availabilityStatus: matchingClasses.length ? "busy" : (hasExactScheduleData ? "candidate" : "unknown"),
      matchingClasses,
    };
  });

  const filtered = evaluated.filter((room) => {
    const haystack = `${room.campus} ${room.building} ${room.room} ${room.memo}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (campus !== "all" && room.campus !== campus) return false;
    if (pcOnly && !room.pc) return false;
    if (eatOnly && !room.eat) return false;
    if (availability === "available" && room.availabilityStatus === "busy") return false;
    if (availability === "busy" && room.availabilityStatus !== "busy") return false;
    return true;
  });

  const summary = document.querySelector("#classroomStatusSummary");
  if (summary) {
    const imported = state.officialSchedule.length;
    const exactRows = scheduleRows.filter((row) => normalizeRoomKey(row.room)).length;
    summary.textContent = `${day || "曜日未指定"}${period ? `曜${period}限` : ""}を判定。公式シラバス取込 ${imported}件、教室番号付き予定 ${exactRows}件。予定が見つかった教室は「使用予定あり」、それ以外は「空き候補」です。`;
  }

  document.querySelector("#classroomList").innerHTML = filtered.length
    ? filtered.map((room) => {
      const status = classroomAvailabilityLabel(room.availabilityStatus);
      const classes = room.matchingClasses.map((item) => `${item.title || "講義"}（${item.source || "時間割"}）`).join("、");
      return `
      <article class="item-card">
        <div class="item-head">
          <div>
            <h4>${escapeHtml(room.campus)} ${escapeHtml(room.building)} ${escapeHtml(room.room)}</h4>
            <p class="meta">
              収容人数：${room.capacity ? `約${escapeHtml(room.capacity)}人` : "未登録"} / PC：${room.pc ? "あり" : "なし・不明"} / 飲食：${room.eat ? "可" : "不可・不明"} / コンセント：${room.outlets ? "あり" : "不明・少なめ"}<br>
              ${classes ? `使用予定：${escapeHtml(classes)}<br>` : ""}
              メモ：${escapeHtml(room.memo || "なし")}<br>
              情報源：${escapeHtml(room.updatedBy || "ユーザー登録")}
            </p>
          </div>
          <span class="badge ${status.className}">${status.label}</span>
        </div>
        <div class="card-actions">
          <button class="secondary" data-action="edit-room-note" data-id="${room.id}">メモ更新</button>
          ${room.sourceUrl ? `<a class="secondary button-link" href="${escapeHtml(room.sourceUrl)}" target="_blank" rel="noopener">シラバス</a>` : ""}
        </div>
      </article>
    `;
    }).join("")
    : `<div class="item-card"><p class="meta">条件に合う教室はありません。</p></div>`;
}

function classroomAvailabilityLabel(status) {
  if (status === "busy") return { label: "使用予定あり", className: "busy" };
  if (status === "candidate") return { label: "空き候補", className: "available" };
  return { label: "判定データ不足", className: "undated" };
}

function getKnownScheduleRows() {
  const rows = [...(state.officialSchedule || []), ...(state.courses || [])];
  const map = new Map();
  for (const row of rows) {
    if (!row || !row.day || !row.period) continue;
    const key = `${row.sourceId || row.syllabus || row.title}|${row.day}|${row.period}|${normalizeRoomKey(row.room)}`;
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function normalizeRoomKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/(?:日吉|矢上|三田|湘南藤沢|SFC|信濃町|芝共立|キャンパス|校舎|棟|教室)/g, "")
    .replace(/[\s　_ー−–—]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function currentPeriodForCampus(campus, date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const isSfc = campus === "湘南藤沢";
  const rows = isSfc
    ? [[1, 565, 655], [2, 670, 760], [3, 780, 870], [4, 885, 975], [5, 990, 1080], [6, 1090, 1180]]
    : [[1, 540, 630], [2, 645, 735], [3, 780, 870], [4, 885, 975], [5, 990, 1080], [6, 1090, 1180], [7, 1190, 1280]];
  const hit = rows.find(([, start, end]) => minutes >= start && minutes <= end);
  return hit ? String(hit[0]) : "";
}

function renderSettings() {
  document.querySelector("#settingsStudentId").value = state.user.studentId || "";
  document.querySelector("#settingsName").value = state.user.name || "";
  document.querySelector("#notifyDays").value = String(state.user.notifyDays || 3);
  document.querySelector("#studentId").value = document.querySelector("#studentId").value || state.user.studentId || "";
  document.querySelector("#studentName").value = document.querySelector("#studentName").value || state.user.name || "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function mergeKlmsPayload(payload, options = {}) {
  const importedCourses = Array.isArray(payload.courses) ? payload.courses : [];
  const importedAssignments = Array.isArray(payload.assignments) ? payload.assignments : [];
  const replaceSynced = options.replaceSynced === true;
  const removeDemo = options.removeDemo !== false;

  if (replaceSynced) {
    state.courses = state.courses.filter((item) => {
      if (isKlmsRecord(item)) return false;
      if (removeDemo && isDemoCourse(item)) return false;
      return true;
    });
    state.assignments = state.assignments.filter((item) => {
      if (isKlmsRecord(item)) return false;
      if (removeDemo && isDemoAssignment(item)) return false;
      return true;
    });
  }

  let addedCourses = 0;
  let updatedCourses = 0;
  let addedAssignments = 0;
  let updatedAssignments = 0;

  for (const course of importedCourses) {
    if (!course?.title) continue;
    const sourceId = course.sourceId || course.canvasId || `course-title-${course.title}-${course.day || ""}-${course.period || ""}`;
    const existing = state.courses.find((item) => item.sourceId === sourceId);
    const normalized = {
      id: existing?.id || crypto.randomUUID(),
      sourceId,
      canvasId: course.canvasId || course.canvasCourseId || "",
      title: course.title,
      day: course.day || "",
      period: String(course.period || ""),
      startTime: course.startTime || "",
      endTime: course.endTime || "",
      room: course.room || "未取得",
      syllabus: course.syllabus || course.url || "",
      source: course.source || "KLMS同期",
      scheduleSource: course.scheduleSource || "",
      isDemo: false,
    };
    if (existing) {
      Object.assign(existing, normalized);
      updatedCourses++;
    } else {
      state.courses.push(normalized);
      addedCourses++;
    }
  }

  for (const assignment of importedAssignments) {
    if (!assignment?.title) continue;
    const sourceId = assignment.sourceId || assignment.canvasId || `assignment-${assignment.course}-${assignment.title}-${assignment.deadline || "undated"}`;
    const existing = state.assignments.find((item) => item.sourceId === sourceId);
    const normalized = {
      id: existing?.id || crypto.randomUUID(),
      sourceId,
      canvasId: assignment.canvasId || "",
      course: assignment.course || "KLMS",
      title: assignment.title,
      deadline: assignment.deadline || "",
      memo: assignment.memo || assignment.url || "KLMS同期",
      done: Boolean(assignment.done),
      source: assignment.source || "KLMS同期",
      url: assignment.url || "",
      isDemo: false,
    };
    if (existing) {
      Object.assign(existing, normalized);
      updatedAssignments++;
    } else {
      state.assignments.push(normalized);
      addedAssignments++;
    }
  }

  state.assignments.sort((a, b) => assignmentSortValue(a) - assignmentSortValue(b));
  saveState();
  renderAll();
  return { addedCourses, updatedCourses, addedAssignments, updatedAssignments };
}

function isKlmsRecord(item) {
  return String(item?.sourceId || "").startsWith("canvas-") || /KLMS|Canvas/i.test(String(item?.source || ""));
}

function isDemoCourse(item) {
  return item?.isDemo === true || ["Webアプリ設計", "物性物理II", "インターネット経済論"].includes(item?.title);
}

function isDemoAssignment(item) {
  return item?.isDemo === true || ["第1回レポート", "結晶中のシュレディンガー方程式", "三層構成アプリ設計メモ"].includes(item?.title);
}

function normalizePlannerJson(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : rawItems.items || rawItems.data || [];
  const courseMap = new Map();
  const assignments = items.map((item) => {
    const plannable = item.plannable || item.assignment || item;
    const type = String(item.plannable_type || plannable.type || "assignment").toLowerCase();
    if (!type.includes("assignment") && !plannable.due_at && !item.assignment_id) return null;
    const dueAt = plannable.due_at || plannable.todo_date || item.plannable_date || item.due_at || "";
    const courseId = String(item.course_id || plannable.course_id || "");
    const courseName = item.context_name || item.course_name || plannable.context_name || (courseId ? `KLMS course ${courseId}` : "KLMS");
    if (courseId && courseName) courseMap.set(courseId, courseName);
    const markedComplete = item.planner_override?.marked_complete === true;
    const submission = item.submissions && typeof item.submissions === "object" ? item.submissions : {};
    const submissionState = String(submission.workflow_state || submission.state || "").toLowerCase();
    const submitted = Boolean(
      submission.submitted_at || submission.graded_at || submission.submitted === true || submission.graded === true ||
      ["submitted", "graded", "pending_review", "complete", "completed"].includes(submissionState)
    );
    return {
      sourceId: `canvas-assignment-${courseId}-${item.plannable_id || plannable.id || plannable.title || plannable.name}`,
      canvasId: String(item.plannable_id || plannable.id || ""),
      course: courseName,
      title: plannable.title || plannable.name || item.title || "KLMS課題",
      deadline: dueAt ? toLocalInputValue(dueAt) : "",
      memo: `JSONインポート / ${item.html_url || plannable.html_url || ""}`,
      done: Boolean(markedComplete || submitted),
      source: "KLMS JSONインポート",
      url: item.html_url || plannable.html_url || "",
    };
  }).filter(Boolean);

  const courses = [...courseMap.entries()].map(([courseId, title]) => ({
    sourceId: `canvas-course-${courseId}`,
    canvasId: courseId,
    title,
    day: "",
    period: "",
    room: "KLMS",
    syllabus: courseId ? `https://lms.keio.jp/courses/${courseId}` : "",
    source: "KLMS JSONインポート",
  }));

  return { courses, assignments };
}

function toLocalInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function getKlmsRequestBody() {
  return {
    baseUrl: document.querySelector("#klmsBaseUrl").value.trim() || "https://lms.keio.jp",
    accessToken: document.querySelector("#klmsAccessToken").value.trim(),
  };
}

async function postKlmsApi(path) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getKlmsRequestBody()),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `APIエラー ${response.status}`);
  return data;
}

async function handleKlmsStatus() {
  const output = document.querySelector("#klmsSyncOutput");
  const token = document.querySelector("#klmsAccessToken").value.trim();
  output.textContent = token ? "アクセストークンを確認中..." : "サーバー設定を確認中...";
  try {
    const data = token
      ? await postKlmsApi("/api/klms/test")
      : await fetch("/api/klms/status").then((response) => response.json());
    output.textContent = JSON.stringify(data, null, 2);
    if (data.ok) showToast(token ? "トークンを確認できました" : "接続設定を確認しました");
  } catch (error) {
    output.textContent = `接続確認に失敗しました。npm startで起動しているか、トークンが正しいか確認してください。
${error.message}`;
    showToast("接続確認に失敗しました");
  }
}

async function handleKlmsSync() {
  const output = document.querySelector("#klmsSyncOutput");
  const button = document.querySelector("#syncKlmsBtn");
  output.textContent = "KLMSから講義・時間割・課題を同期中...";
  button.disabled = true;
  try {
    const data = await postKlmsApi("/api/klms/sync-all");
    const summary = mergeKlmsPayload(data, {
      replaceSynced: true,
      removeDemo: document.querySelector("#removeDemoOnSync").checked,
    });
    if (data.profile?.name && !state.user.name) state.user.name = data.profile.name;
    saveState();
    renderAll();
    output.textContent = JSON.stringify({
      message: "時間割・課題の同期完了",
      user: data.profile,
      syncedAt: data.syncedAt,
      counts: data.counts,
      imported: summary,
      note: data.counts?.unscheduledCourses
        ? `${data.counts.unscheduledCourses}件はKLMS側に曜日・時限情報がなく、時間割一覧の「未設定」に表示されます。`
        : "取得できた曜日・時限を時間割へ反映しました。",
      warnings: data.warnings || [],
    }, null, 2);
    showToast("時間割と課題を同期しました");
  } catch (error) {
    output.textContent = `同期に失敗しました。
${error.message}`;
    showToast("KLMS同期に失敗しました");
  } finally {
    button.disabled = false;
  }
}

async function handleRawKlmsExport() {
  const output = document.querySelector("#klmsSyncOutput");
  output.textContent = "KLMS生データを書き出し中...";
  try {
    const data = await postKlmsApi("/api/klms/raw");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `klms_canvas_raw_${timestamp}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    output.textContent = JSON.stringify({ message: "KLMS生データを書き出しました", fileName, counts: data.counts, warnings: data.warnings || [] }, null, 2);
    showToast("KLMS生データを書き出しました");
  } catch (error) {
    output.textContent = `生データ取得に失敗しました。
${error.message}`;
    showToast("KLMS生データ取得に失敗しました");
  }
}

function handlePlannerJsonImport() {
  const textarea = document.querySelector("#plannerJsonInput");
  const output = document.querySelector("#klmsSyncOutput");
  try {
    const raw = JSON.parse(textarea.value);
    const normalized = normalizePlannerJson(raw);
    const summary = mergeKlmsPayload(normalized);
    output.textContent = JSON.stringify({
      message: "JSONインポート完了",
      normalizedCounts: {
        courses: normalized.courses.length,
        assignments: normalized.assignments.length,
      },
      imported: summary,
    }, null, 2);
    textarea.value = "";
    showToast("JSONを取り込みました");
  } catch (error) {
    output.textContent = `JSONの取り込みに失敗しました。形式を確認してください。\n${error.message}`;
    showToast("JSONの取り込みに失敗しました");
  }
}

function mergeOfficialSchedule(entries) {
  if (!Array.isArray(state.officialSchedule)) state.officialSchedule = [];
  let added = 0;
  let updated = 0;
  let roomsAdded = 0;
  for (const entry of entries || []) {
    if (!entry?.title || !entry?.day || !entry?.period) continue;
    const sourceId = entry.sourceId || `syllabus-${entry.registrationNumber || entry.title}-${entry.day}-${entry.period}-${entry.room || ""}`;
    const normalized = {
      id: sourceId,
      sourceId,
      title: entry.title,
      day: entry.day,
      period: String(entry.period),
      campus: entry.campus || "",
      room: entry.room || "",
      term: entry.term || "",
      registrationNumber: entry.registrationNumber || "",
      source: entry.source || "慶應公式シラバス",
      syllabus: entry.syllabus || entry.url || "",
    };
    const existing = state.officialSchedule.find((item) => item.sourceId === sourceId);
    if (existing) {
      Object.assign(existing, normalized);
      updated++;
    } else {
      state.officialSchedule.push(normalized);
      added++;
    }
    if (normalized.room) {
      const roomKey = normalizeRoomKey(normalized.room);
      const roomExists = state.classrooms.some((room) => normalizeRoomKey(room.room) === roomKey);
      if (!roomExists) {
        state.classrooms.push({
          id: crypto.randomUUID(),
          campus: normalized.campus || "未設定",
          building: "",
          room: normalized.room,
          capacity: "",
          pc: false,
          eat: false,
          outlets: false,
          memo: "公式シラバスの時間割から追加。設備情報は未確認。",
          updatedBy: "慶應公式シラバス",
          sourceUrl: normalized.syllabus,
        });
        roomsAdded++;
      }
    }
  }
  state.syllabusLastImportedAt = new Date().toISOString();
  saveState();
  renderAll();
  return { added, updated, roomsAdded, total: state.officialSchedule.length };
}

async function handleSyllabusUrlImport() {
  const textarea = document.querySelector("#syllabusUrlsInput");
  const output = document.querySelector("#syllabusImportOutput");
  const button = document.querySelector("#importSyllabusUrlsBtn");
  const urls = textarea.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!urls.length) {
    showToast("シラバス詳細URLを入力してください");
    return;
  }
  output.textContent = "公式シラバスを取得中...";
  button.disabled = true;
  try {
    const response = await fetch("/api/syllabus/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `APIエラー ${response.status}`);
    const summary = mergeOfficialSchedule(data.entries || []);
    output.textContent = JSON.stringify({
      message: "公式シラバスを取り込みました",
      fetched: data.counts,
      imported: summary,
      warnings: data.warnings || [],
      note: "公開ページに教室番号がない科目は、キャンパス・曜日時限のみ登録されます。",
    }, null, 2);
    showToast("公式シラバスを取り込みました");
  } catch (error) {
    output.textContent = `シラバス取得に失敗しました。npm startで起動し、詳細URLを1行ずつ入力してください。\n${error.message}`;
    showToast("シラバス取得に失敗しました");
  } finally {
    button.disabled = false;
  }
}

function handleOfficialScheduleJsonImport() {
  const textarea = document.querySelector("#officialScheduleJsonInput");
  const output = document.querySelector("#syllabusImportOutput");
  try {
    const raw = JSON.parse(textarea.value);
    const entries = Array.isArray(raw) ? raw : raw.entries || raw.courses || raw.data || [];
    const expanded = entries.flatMap((item) => {
      const periods = Array.isArray(item.periods) ? item.periods : [item.period || item.period_no || ""];
      const days = Array.isArray(item.days) ? item.days : [item.day || item.weekday || ""];
      return days.flatMap((day) => periods.map((period) => ({
        ...item,
        day: String(day).match(/[月火水木金土日]/)?.[0] || day,
        period: String(period).match(/[1-7]/)?.[0] || period,
        title: item.title || item.course || item.name,
        campus: item.campus || "",
        room: item.room || item.classroom || item.location || "",
        syllabus: item.syllabus || item.url || "",
        source: item.source || "公式時間割JSON",
      })));
    });
    const summary = mergeOfficialSchedule(expanded);
    textarea.value = "";
    output.textContent = JSON.stringify({ message: "公式時間割JSONを取り込みました", imported: summary }, null, 2);
    showToast("公式時間割JSONを取り込みました");
  } catch (error) {
    output.textContent = `JSON取り込みに失敗しました。\n${error.message}`;
    showToast("公式時間割JSONの形式を確認してください");
  }
}

function bindEvents() {
  document.querySelector("#resetDemoBtn").addEventListener("click", () => {
    state = structuredClone(demoState);
    saveState();
    renderAll();
    showToast("デモデータに戻しました");
  });

  document.querySelector("#assignmentForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.assignments.push({
      id: crypto.randomUUID(),
      course: document.querySelector("#assignmentCourse").value,
      title: document.querySelector("#assignmentTitle").value,
      deadline: document.querySelector("#assignmentDeadline").value,
      memo: document.querySelector("#assignmentMemo").value,
      done: false,
      source: "手入力",
      isDemo: false,
    });
    event.target.reset();
    saveState();
    renderAll();
    showToast("課題を追加しました");
  });

  document.querySelector("#assignmentSearch").addEventListener("input", renderAssignments);
  document.querySelector("#assignmentFilter").addEventListener("change", renderAssignments);

  document.querySelector("#assignmentList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;
    if (action === "toggle-assignment") {
      const item = state.assignments.find((assignment) => assignment.id === id);
      item.done = !item.done;
      saveState();
      renderAll();
      showToast(item.done ? "完了にしました" : "未完了に戻しました");
    }
    if (action === "delete-assignment") {
      state.assignments = state.assignments.filter((assignment) => assignment.id !== id);
      saveState();
      renderAll();
      showToast("課題を削除しました");
    }
    if (action === "use-rename") {
      const item = state.assignments.find((assignment) => assignment.id === id);
      document.querySelector("#renameCourse").value = item.course;
      document.querySelector("#renameAssignment").value = item.title;
      document.querySelector('[data-target="file-tools"]').click();
      showToast("ファイル名生成フォームに反映しました");
    }
  });

  document.querySelector("#fileInput").addEventListener("change", handleFilePreview);
  document.querySelector("#renameForm").addEventListener("submit", handleRename);

  document.querySelector("#courseForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.courses.push({
      id: crypto.randomUUID(),
      title: document.querySelector("#courseTitle").value,
      day: document.querySelector("#courseDay").value,
      period: document.querySelector("#coursePeriod").value,
      room: document.querySelector("#courseRoom").value,
      syllabus: document.querySelector("#courseSyllabus").value,
      source: "手入力",
      isDemo: false,
    });
    event.target.reset();
    saveState();
    renderAll();
    showToast("講義を追加しました");
  });

  document.querySelector("#timetableGrid").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='delete-course']");
    if (!button) return;
    state.courses = state.courses.filter((course) => course.id !== button.dataset.id);
    saveState();
    renderAll();
    showToast("講義を削除しました");
  });

  ["#roomSearch", "#campusFilter", "#roomDayFilter", "#roomPeriodFilter", "#roomAvailabilityFilter", "#pcOnly", "#eatOnly"].forEach((selector) => {
    document.querySelector(selector).addEventListener("input", renderClassrooms);
    document.querySelector(selector).addEventListener("change", renderClassrooms);
  });
  document.querySelector("#setCurrentPeriodBtn").addEventListener("click", () => {
    const campus = document.querySelector("#campusFilter").value;
    document.querySelector("#roomDayFilter").value = dayNames[new Date().getDay()];
    document.querySelector("#roomPeriodFilter").value = currentPeriodForCampus(campus === "all" ? "日吉" : campus);
    renderClassrooms();
    showToast("現在の曜日・時限を設定しました");
  });
  document.querySelector("#importSyllabusUrlsBtn").addEventListener("click", handleSyllabusUrlImport);
  document.querySelector("#importOfficialScheduleJsonBtn").addEventListener("click", handleOfficialScheduleJsonImport);

  document.querySelector("#classroomList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='edit-room-note']");
    if (!button) return;
    const room = state.classrooms.find((item) => item.id === button.dataset.id);
    const nextMemo = prompt("教室メモを入力してください", room.memo);
    if (nextMemo === null) return;
    room.memo = nextMemo.trim() || room.memo;
    room.updatedBy = "ユーザー投稿";
    saveState();
    renderClassrooms();
    showToast("教室メモを更新しました");
  });

  document.querySelector("#aiForm").addEventListener("submit", handleAiTemplate);
  document.querySelector("#copyAiOutput").addEventListener("click", async () => {
    const text = document.querySelector("#aiOutput").textContent;
    await navigator.clipboard.writeText(text);
    showToast("生成結果をコピーしました");
  });

  document.querySelector("#checkKlmsStatus").addEventListener("click", handleKlmsStatus);
  document.querySelector("#syncKlmsBtn").addEventListener("click", handleKlmsSync);
  document.querySelector("#exportRawKlmsBtn").addEventListener("click", handleRawKlmsExport);
  document.querySelector("#importPlannerJsonBtn").addEventListener("click", handlePlannerJsonImport);
  document.querySelector("#checkDatabaseStatus")?.addEventListener("click", handleDatabaseStatus);
  document.querySelector("#saveDatabaseNow")?.addEventListener("click", async () => {
    try {
      await persistStateToDatabase();
      await handleDatabaseStatus();
      showToast("PostgreSQLへ保存しました");
    } catch (error) {
      showToast(`DB保存失敗: ${error.message}`);
    }
  });
  document.querySelector("#reloadDatabaseState")?.addEventListener("click", async () => {
    await hydrateStateFromDatabase();
  });

  document.querySelector("#settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.user.studentId = document.querySelector("#settingsStudentId").value;
    state.user.name = document.querySelector("#settingsName").value;
    state.user.notifyDays = Number(document.querySelector("#notifyDays").value);
    saveState();
    renderAll();
    showToast("設定を保存しました");
  });
}

function handleFilePreview(event) {
  selectedFile = event.target.files[0] || null;
  const preview = document.querySelector("#previewArea");
  document.querySelector("#generatedName").textContent = "未生成";
  document.querySelector("#downloadRenamed").classList.add("hidden");

  if (selectedFileUrl) URL.revokeObjectURL(selectedFileUrl);
  if (!selectedFile) {
    preview.textContent = "PDF・画像・テキストを選択するとプレビューします。";
    return;
  }

  selectedFileUrl = URL.createObjectURL(selectedFile);
  if (selectedFile.type === "application/pdf") {
    preview.innerHTML = `<iframe src="${selectedFileUrl}" title="PDF preview"></iframe>`;
  } else if (selectedFile.type.startsWith("image/")) {
    preview.innerHTML = `<img src="${selectedFileUrl}" alt="preview" />`;
  } else if (selectedFile.type.startsWith("text/") || selectedFile.name.endsWith(".txt") || selectedFile.name.endsWith(".md")) {
    const reader = new FileReader();
    reader.onload = () => {
      preview.innerHTML = `<pre>${escapeHtml(reader.result)}</pre>`;
    };
    reader.readAsText(selectedFile, "utf-8");
  } else {
    preview.innerHTML = `<p class="meta">この形式はブラウザ内プレビュー非対応です。<br>ファイル名生成と保存は可能です。</p>`;
  }
}

function handleRename(event) {
  event.preventDefault();
  const studentId = document.querySelector("#studentId").value || state.user.studentId || "student";
  const studentName = document.querySelector("#studentName").value || state.user.name || "name";
  const course = document.querySelector("#renameCourse").value || "course";
  const assignment = document.querySelector("#renameAssignment").value || "assignment";
  const original = selectedFile?.name || "report.pdf";
  const extension = original.includes(".") ? original.slice(original.lastIndexOf(".")) : "";
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const newName = [studentId, studentName, course, assignment, date]
    .map(sanitizeFilePart)
    .join("_") + extension;

  document.querySelector("#generatedName").textContent = newName;

  const link = document.querySelector("#downloadRenamed");
  if (selectedFile && selectedFileUrl) {
    link.href = selectedFileUrl;
    link.download = newName;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
  showToast("ファイル名を生成しました");
}

function handleAiTemplate(event) {
  event.preventDefault();
  const theme = document.querySelector("#reportTheme").value.trim();
  const field = document.querySelector("#reportField").value.trim() || "希望する業界";
  const length = document.querySelector("#reportLength").value;
  const output = `【レポート構成テンプレート】

業界名：${field}

1. 冒頭
${field}では、インターネットを単なる情報収集の手段としてだけでなく、顧客との接点、業務効率化、データ活用の基盤として利用することが重要である。

2. 本文の方向性
テーマ「${theme}」について、次の観点で論じると書きやすい。
・インターネットによって便利になった点
・企業活動や生活に与える影響
・個人情報、セキュリティ、情報格差などの注意点
・将来自分がその業界で働く場合に意識したいこと

3. まとめ例
したがって、インターネットを活用する際には、利便性だけでなく安全性や信頼性にも配慮する必要がある。${field}においても、利用者にとって使いやすく、安心できるサービスを提供する姿勢が重要だと考える。

目安：${length}字程度

※これはデモ用のテンプレート生成です。実運用ではOpenAI APIなどのLLMに接続します。`;
  document.querySelector("#aiOutput").textContent = output;
  showToast("テンプレートを生成しました");
}

initializeNavigation();
bindEvents();
document.querySelector("#roomDayFilter").value = dayNames[new Date().getDay()];
renderAll();
handleDatabaseStatus();
hydrateStateFromDatabase();
