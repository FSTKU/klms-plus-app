const http = require("http");
const fs = require("fs");
const path = require("path");

const publicDir = __dirname;
loadDotEnv(path.join(__dirname, ".env"));
const { databaseConfigured, ensureSchema, getAppState, saveAppState, checkDatabase } = require("./db");
const port = process.env.PORT || 3000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/health")) {
      await handleHealthApi(req, res);
      return;
    }

    if (req.url.startsWith("/api/state")) {
      await handleStateApi(req, res);
      return;
    }

    if (req.url.startsWith("/api/klms/")) {
      await handleKlmsApi(req, res);
      return;
    }

    if (req.url.startsWith("/api/syllabus/")) {
      await handleSyllabusApi(req, res);
      return;
    }

    const safePath = path.normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(publicDir, safePath === "/" ? "index.html" : safePath);

    if (!filePath.startsWith(publicDir)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        sendText(res, 404, "Not Found");
        return;
      }

      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      res.end(data);
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message || "Internal Server Error" });
  }
});

async function handleHealthApi(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    return;
  }
  if (!databaseConfigured) {
    sendJson(res, 503, { ok: false, database: false, error: "DATABASE_URL が未設定です。" });
    return;
  }
  const result = await checkDatabase();
  sendJson(res, 200, { ok: true, database: true, checkedAt: result.now });
}

async function handleStateApi(req, res) {
  if (!databaseConfigured) {
    sendJson(res, 503, { ok: false, error: "DATABASE_URL が未設定です。localStorageのみで動作しています。" });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET") {
    const clientId = validateClientId(requestUrl.searchParams.get("clientId"));
    const row = await getAppState(clientId);
    sendJson(res, 200, {
      ok: true,
      found: Boolean(row),
      state: row ? row.data : null,
      updatedAt: row ? row.updated_at : null,
    });
    return;
  }

  if (req.method === "PUT" || req.method === "POST") {
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const clientId = validateClientId(body.clientId);
    if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
      sendJson(res, 400, { ok: false, error: "state はJSONオブジェクトで指定してください。" });
      return;
    }
    const saved = await saveAppState(clientId, body.state);
    sendJson(res, 200, { ok: true, updatedAt: saved.updated_at });
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
}

function validateClientId(value) {
  const clientId = String(value || "").trim();
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(clientId)) {
    const error = new Error("clientId の形式が正しくありません。");
    error.statusCode = 400;
    throw error;
  }
  return clientId;
}

async function handleKlmsApi(req, res) {
  if (req.method === "GET" && req.url.startsWith("/api/klms/status")) {
    const baseUrl = normalizeBaseUrl(process.env.KLMS_BASE_URL || "https://lms.keio.jp");
    sendJson(res, 200, {
      ok: true,
      configured: Boolean(process.env.CANVAS_ACCESS_TOKEN),
      baseUrl,
      mode: "Canvas API token sync",
      tokenStorage: "トークンはブラウザまたはサーバーに保存せず、同期リクエスト中だけ使用できます。",
      message: process.env.CANVAS_ACCESS_TOKEN
        ? ".env のアクセストークンが設定されています。画面入力を空欄にしても同期できます。"
        : "画面にCanvas Access Tokenを入力して同期できます。.env設定も利用できます。",
    });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/klms/test")) {
    const body = await readJsonBody(req);
    const config = getKlmsConfig(body);
    requireToken(config.token);
    const profile = await canvasGetJson(config.baseUrl, config.token, "/api/v1/users/self/profile");
    const sampleCourses = await canvasGetAll(config.baseUrl, config.token, "/api/v1/courses", {
      enrollment_state: "active",
      "include[]": ["term"],
      per_page: "10",
    }, 1);
    sendJson(res, 200, {
      ok: true,
      baseUrl: config.baseUrl,
      user: profile ? { id: profile.id, name: profile.name, loginId: profile.login_id || "" } : null,
      activeCourseCountAtLeast: sampleCourses.length,
      message: "アクセストークンを確認できました。",
    });
    return;
  }

  if (req.method === "POST" && (req.url.startsWith("/api/klms/sync") || req.url.startsWith("/api/klms/sync-all"))) {
    const body = await readJsonBody(req);
    const config = getKlmsConfig(body);
    requireToken(config.token);
    const payload = await syncCanvas({ ...config, includeRaw: false });
    sendJson(res, 200, { ok: true, ...payload });
    return;
  }

  if (req.method === "POST" && (req.url.startsWith("/api/klms/raw") || req.url.startsWith("/api/klms/export"))) {
    const body = await readJsonBody(req);
    const config = getKlmsConfig(body);
    requireToken(config.token);
    const payload = await syncCanvas({ ...config, includeRaw: true });
    sendJson(res, 200, { ok: true, ...payload });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Unknown API route" });
}

async function handleSyllabusApi(req, res) {
  if (req.method === "POST" && req.url.startsWith("/api/syllabus/import")) {
    const body = await readJsonBody(req, 256 * 1024);
    const urls = Array.isArray(body.urls) ? body.urls.map((value) => String(value || "").trim()).filter(Boolean) : [];
    if (!urls.length) {
      sendJson(res, 400, { ok: false, error: "シラバス詳細URLを1件以上指定してください。" });
      return;
    }
    if (urls.length > 50) {
      sendJson(res, 400, { ok: false, error: "一度に取り込めるURLは50件までです。" });
      return;
    }

    const warnings = [];
    const results = await mapLimit(urls, 3, async (rawUrl) => {
      try {
        const safeUrl = validateSyllabusUrl(rawUrl);
        const response = await fetch(safeUrl, {
          redirect: "follow",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "ja,en;q=0.8",
            "User-Agent": "KLMS-Plus-Render/1.4 (personal syllabus importer)",
          },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) throw new Error(`HTMLではない応答です: ${contentType}`);
        const html = await response.text();
        const parsed = parseKeioSyllabusHtml(html, safeUrl);
        if (!parsed.entries.length) {
          warnings.push({ url: rawUrl, error: "曜日時限を取得できませんでした。ログイン画面への転送または対象ページの形式を確認してください。" });
        }
        return parsed;
      } catch (error) {
        warnings.push({ url: rawUrl, error: error.message });
        return null;
      }
    });

    const pages = results.filter(Boolean);
    const entries = pages.flatMap((page) => page.entries);
    sendJson(res, 200, {
      ok: true,
      entries,
      pages,
      counts: {
        requested: urls.length,
        fetched: pages.length,
        scheduleRows: entries.length,
        withExactRoom: entries.filter((entry) => Boolean(entry.room)).length,
        warnings: warnings.length,
      },
      warnings,
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Unknown syllabus API route" });
}

function validateSyllabusUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL形式が正しくありません。");
  }
  if (url.protocol !== "https:") throw new Error("HTTPSのURLだけを指定してください。");
  if (url.hostname !== "gslbs.keio.jp") throw new Error("gslbs.keio.jp の公式シラバスURLだけを指定できます。");
  if (!url.pathname.startsWith("/pub-syllabus/detail")) throw new Error("検索画面ではなく授業の詳細URLを指定してください。");
  return url.toString();
}

function parseKeioSyllabusHtml(html, sourceUrl) {
  const title = firstMatch(html, [
    /<h2[^>]*>([\s\S]*?)<\/h2>/i,
    /<title[^>]*>([\s\S]*?)(?:\||-)[\s\S]*?<\/title>/i,
  ]);
  const plain = htmlToLines(html);
  const term = readLabeledLine(plain, "年度・学期");
  const dayPeriodText = readLabeledLine(plain, "曜日時限");
  const campus = normalizeCampusName(readLabeledLine(plain, "キャンパス") || readLabeledLine(plain, "開講場所"));
  const registrationNumber = readLabeledLine(plain, "登録番号");
  const location = readLabeledLine(plain, "教室") || readLabeledLine(plain, "授業教室") || "";
  const room = normalizeExactRoom(location, campus);
  const meetings = parseJapaneseDayPeriodsServer(dayPeriodText);
  const cleanTitle = decodeHtml(stripTags(title || "")).replace(/\s+/g, " ").trim() || "名称未取得";

  return {
    title: cleanTitle,
    term,
    campus,
    dayPeriodText,
    registrationNumber,
    room,
    syllabus: sourceUrl,
    entries: meetings.map((meeting) => ({
      sourceId: `keio-syllabus-${registrationNumber || cleanTitle}-${meeting.day}-${meeting.period}`,
      title: cleanTitle,
      day: meeting.day,
      period: String(meeting.period),
      campus,
      room,
      term,
      registrationNumber,
      source: "慶應公式シラバス",
      syllabus: sourceUrl,
    })),
  };
}

function htmlToLines(html) {
  return decodeHtml(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/dt|\/dd)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\t\r]+/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n"));
}

function readLabeledLine(text, label) {
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === label && lines[index + 1]) return lines[index + 1].trim();
    if (line.startsWith(label)) {
      const rest = line.slice(label.length).replace(/^[：:\s]+/, "").trim();
      if (rest) return rest;
    }
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`${escaped}[：:\\s]+([^\\n]+)`));
  return match ? match[1].trim() : "";
}

function parseJapaneseDayPeriodsServer(value) {
  const text = String(value || "").normalize("NFKC").replace(/曜日|時限|限/g, "");
  const matches = [...text.matchAll(/([月火水木金土日])\s*([1-7](?:\s*[,、・/]\s*[1-7])*)/g)];
  const rows = [];
  for (const match of matches) {
    const day = match[1];
    const periods = match[2].split(/[,、・/]/).map((item) => item.trim()).filter(Boolean);
    for (const period of periods) rows.push({ day, period });
  }
  return dedupeSimple(rows, (item) => `${item.day}-${item.period}`);
}

function normalizeCampusName(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (/SFC|湘南藤沢/i.test(text)) return "湘南藤沢";
  if (/日吉/.test(text)) return "日吉";
  if (/矢上/.test(text)) return "矢上";
  if (/三田/.test(text)) return "三田";
  if (/信濃町/.test(text)) return "信濃町";
  if (/芝共立/.test(text)) return "芝共立";
  return text;
}

function normalizeExactRoom(value, campus) {
  const text = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text || text === campus || /^(SFC|湘南藤沢|日吉|矢上|三田|信濃町|芝共立)$/.test(text)) return "";
  if (!/[0-9]/.test(text)) return "";
  return text;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) return match[1] || "";
  }
  return "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    yen: "¥", copy: "©", middot: "·",
  };
  return String(value || "")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : match);
}

function dedupeSimple(items, keyFn) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function getKlmsConfig(body = {}) {
  return {
    token: String(body.accessToken || process.env.CANVAS_ACCESS_TOKEN || "").trim(),
    baseUrl: normalizeBaseUrl(body.baseUrl || process.env.KLMS_BASE_URL || "https://lms.keio.jp"),
  };
}

function requireToken(token) {
  if (!token) {
    const error = new Error("Canvas Access Tokenを入力してください。Keio IDのパスワードは入力しないでください。");
    error.statusCode = 400;
    throw error;
  }
}

async function syncCanvas({ baseUrl, token, includeRaw = false }) {
  const today = new Date();
  const pastDays = numberInRange(process.env.KLMS_SYNC_DAYS_PAST, 120, 1, 730);
  const futureDays = numberInRange(process.env.KLMS_SYNC_DAYS_FUTURE, 365, 30, 730);
  const startDate = toDateString(addDays(today, -pastDays));
  const endDate = toDateString(addDays(today, futureDays));
  const errors = [];

  const selfProfile = await safeCanvasGetJson(errors, baseUrl, token, "/api/v1/users/self/profile", {}, "users/self/profile");

  const coursesRaw = await canvasGetAll(baseUrl, token, "/api/v1/courses", {
    enrollment_state: "active",
    "include[]": ["term", "syllabus_body", "sections", "teachers"],
    per_page: "100",
  });

  const activeCourses = coursesRaw.filter((course) => course && course.id && (course.name || course.course_code));
  const courseMap = new Map(activeCourses.map((course) => [String(course.id), course.name || course.course_code || `course_${course.id}`]));

  const plannerItems = await safeCanvasGetAll(errors, baseUrl, token, "/api/v1/planner/items", {
    start_date: startDate,
    end_date: endDate,
    per_page: "100",
  }, "planner/items");

  // CanvasのCalendar Events APIはcontext_codesを省略すると個人カレンダーのみ返すため、
  // 講義IDを10件ずつ明示して取得する。
  const contextCodeChunks = chunkArray(activeCourses.map((course) => `course_${course.id}`), 10);
  const calendarEventBatches = await mapLimit(contextCodeChunks, 3, async (contextCodes, index) => (
    safeCanvasGetAll(errors, baseUrl, token, "/api/v1/calendar_events", {
      type: "event",
      start_date: startDate,
      end_date: endDate,
      "context_codes[]": contextCodes,
      "includes[]": ["series_natural_language"],
      per_page: "100",
    }, `calendar_events/batch_${index + 1}`)
  ));
  const calendarEvents = calendarEventBatches.flat();
  const eventsByCourse = groupCalendarEventsByCourse(calendarEvents);

  const courseDetails = await mapLimit(activeCourses, 4, async (course) => {
    const courseId = String(course.id);
    const [assignments, todos, modules, timetable] = await Promise.all([
      safeCanvasGetAll(errors, baseUrl, token, `/api/v1/courses/${courseId}/assignments`, {
        "include[]": ["submission", "all_dates", "overrides"],
        order_by: "due_at",
        per_page: "100",
      }, `courses/${courseId}/assignments`),
      safeCanvasGetAll(errors, baseUrl, token, `/api/v1/courses/${courseId}/todo`, {
        per_page: "100",
      }, `courses/${courseId}/todo`),
      safeCanvasGetAll(errors, baseUrl, token, `/api/v1/courses/${courseId}/modules`, {
        per_page: "100",
      }, `courses/${courseId}/modules`),
      safeCanvasGetJson(errors, baseUrl, token, `/api/v1/courses/${courseId}/calendar_events/timetable`, {}, `courses/${courseId}/timetable`),
    ]);
    return { course, assignments, todos, modules, timetable: timetable || {}, events: eventsByCourse.get(courseId) || [] };
  });

  const courses = courseDetails.flatMap((detail) => normalizeCourseMeetings(detail, baseUrl));
  const assignmentsFromPlanner = mapPlannerItems(plannerItems, courseMap, baseUrl);
  const assignmentsFromCourses = mapCourseAssignments(courseDetails, courseMap, baseUrl);
  const assignmentsFromTodos = mapCourseTodos(courseDetails, courseMap, baseUrl);
  const assignments = dedupeAssignments([
    ...assignmentsFromCourses,
    ...assignmentsFromPlanner,
    ...assignmentsFromTodos,
  ]);

  const scheduledMeetings = courses.filter((course) => course.day && course.period).length;
  const unscheduledCourses = new Set(courses.filter((course) => !course.day || !course.period).map((course) => course.canvasId)).size;

  const payload = {
    syncedAt: new Date().toISOString(),
    baseUrl,
    startDate,
    endDate,
    profile: selfProfile ? { id: selfProfile.id, name: selfProfile.name, loginId: selfProfile.login_id || "" } : null,
    courses,
    assignments,
    counts: {
      canvasCourses: activeCourses.length,
      timetableRows: courses.length,
      scheduledMeetings,
      unscheduledCourses,
      assignments: assignments.length,
      plannerItems: plannerItems.length,
      calendarEvents: calendarEvents.length,
      courseAssignmentsRaw: courseDetails.reduce((sum, item) => sum + item.assignments.length, 0),
      courseTodosRaw: courseDetails.reduce((sum, item) => sum + item.todos.length, 0),
      modulesRaw: courseDetails.reduce((sum, item) => sum + item.modules.length, 0),
      errors: errors.length,
    },
    warnings: errors,
  };

  if (includeRaw) {
    payload.raw = {
      selfProfile,
      courses: coursesRaw,
      plannerItems,
      calendarEvents,
      courseData: courseDetails.map((item) => ({
        course: item.course,
        assignments: item.assignments,
        todos: item.todos,
        modules: item.modules,
        timetable: item.timetable,
        calendarEvents: item.events,
      })),
    };
  }

  return payload;
}

function normalizeCourseMeetings(detail, baseUrl) {
  const { course, timetable, events } = detail;
  const canvasId = String(course.id);
  const title = course.name || course.course_code || `course_${canvasId}`;
  const syllabus = absoluteUrl(baseUrl, course.html_url || `/courses/${canvasId}`);
  const common = {
    canvasId,
    canvasCourseId: canvasId,
    title,
    syllabus,
    source: "KLMS Canvas API",
    term: course.term?.name || "",
    teachers: Array.isArray(course.teachers) ? course.teachers.map((teacher) => teacher.display_name || teacher.name).filter(Boolean) : [],
  };

  const timetableMeetings = meetingsFromCanvasTimetable(timetable);
  const textMeetings = meetingsFromCourseText(course);
  const eventMeetings = meetingsFromCalendarEvents(events, title);
  const meetings = dedupeMeetings(timetableMeetings.length ? timetableMeetings : (textMeetings.length ? textMeetings : eventMeetings));

  if (!meetings.length) {
    return [{
      ...common,
      sourceId: `canvas-course-${canvasId}-unscheduled`,
      day: "",
      period: "",
      startTime: "",
      endTime: "",
      room: extractRoomFromCourse(course) || "未取得",
      scheduleSource: "曜日・時限情報なし",
    }];
  }

  return meetings.map((meeting, index) => ({
    ...common,
    sourceId: `canvas-course-${canvasId}-${meeting.day || "x"}-${meeting.period || meeting.startTime || index}-${index}`,
    day: meeting.day || "",
    period: String(meeting.period || ""),
    startTime: meeting.startTime || "",
    endTime: meeting.endTime || "",
    room: meeting.room || extractRoomFromCourse(course) || "未取得",
    scheduleSource: meeting.source || "KLMS",
  }));
}

function meetingsFromCanvasTimetable(timetable) {
  if (!timetable || typeof timetable !== "object") return [];
  const rows = [];
  for (const value of Object.values(timetable)) {
    for (const item of Array.isArray(value) ? value : []) {
      const weekdays = parseWeekdays(item.weekdays);
      const startTime = normalizeClock(item.start_time);
      const endTime = normalizeClock(item.end_time);
      for (const day of weekdays) {
        rows.push({
          day,
          period: periodFromClock(startTime),
          startTime,
          endTime,
          room: item.location_name || "",
          source: "Canvas timetable",
        });
      }
    }
  }
  return rows;
}

function meetingsFromCourseText(course) {
  const sectionText = Array.isArray(course.sections) ? course.sections.map((section) => section.name || "").join(" ") : "";
  const mainText = `${course.name || ""} ${course.course_code || ""} ${sectionText}`;
  let meetings = parseJapaneseDayPeriods(mainText).map((item) => ({ ...item, source: "講義名・セクション" }));
  if (meetings.length) return meetings;

  const syllabusText = stripHtml(course.syllabus_body || "").slice(0, 8000);
  const scheduleSegments = [];
  const patterns = [
    /(?:曜日時限|曜日・時限|開講曜日|授業時間|時間割)[：:\s]*([^。\n]{1,100})/g,
    /(?:day\s*\/\s*period|weekday|schedule)[：:\s]*([^。\n]{1,100})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of syllabusText.matchAll(pattern)) scheduleSegments.push(match[1]);
  }
  meetings = parseJapaneseDayPeriods(scheduleSegments.join(" ")).map((item) => ({ ...item, source: "Canvasシラバス本文" }));
  return meetings;
}

function meetingsFromCalendarEvents(events, courseTitle) {
  const groups = new Map();
  for (const event of events || []) {
    if (!event?.start_at || event.all_day || event.workflow_state === "deleted") continue;
    const start = tokyoDateParts(event.start_at);
    if (!start) continue;
    const end = tokyoDateParts(event.end_at || event.start_at);
    const day = dayNumberToJapanese(start.weekday);
    const startTime = `${pad2(start.hour)}:${pad2(start.minute)}`;
    const endTime = end ? `${pad2(end.hour)}:${pad2(end.minute)}` : "";
    const room = event.location_name || "";
    const key = `${day}|${startTime}|${endTime}|${room}`;
    const current = groups.get(key) || {
      day,
      period: periodFromClock(startTime),
      startTime,
      endTime,
      room,
      count: 0,
      recurring: false,
      titleMatch: false,
      source: "Canvasカレンダー",
    };
    current.count += 1;
    current.recurring = current.recurring || Boolean(event.series_uuid || event.rrule || event.series_natural_language);
    const normalizedEventTitle = normalizeText(event.title);
    const normalizedCourseTitle = normalizeText(courseTitle);
    current.titleMatch = current.titleMatch || Boolean(
      normalizedEventTitle && normalizedCourseTitle &&
      (normalizedEventTitle.includes(normalizedCourseTitle) || normalizedCourseTitle.includes(normalizedEventTitle))
    );
    groups.set(key, current);
  }

  const candidates = [...groups.values()].filter((item) => item.count >= 2 || item.recurring || item.titleMatch);
  candidates.sort((a, b) => b.count - a.count || Number(a.period || 99) - Number(b.period || 99));
  return candidates.map(({ count, recurring, titleMatch, ...meeting }) => meeting);
}

function parseJapaneseDayPeriods(text) {
  const normalized = String(text || "").normalize("NFKC");
  const rows = [];
  const jpPattern = /([月火水木金土日])(?:曜(?:日)?)?\s*([1-7])(?:\s*(?:,|、|・|\/|〜|~|-)?\s*([1-7]))?\s*(?:限|時限)?/g;
  for (const match of normalized.matchAll(jpPattern)) {
    const day = match[1];
    const first = Number(match[2]);
    const second = match[3] ? Number(match[3]) : null;
    rows.push({ day, period: first, startTime: "", endTime: "", room: extractRoomFromText(normalized) });
    if (second && second !== first) rows.push({ day, period: second, startTime: "", endTime: "", room: extractRoomFromText(normalized) });
  }

  const englishDays = { Mon: "月", Monday: "月", Tue: "火", Tuesday: "火", Wed: "水", Wednesday: "水", Thu: "木", Thursday: "木", Fri: "金", Friday: "金", Sat: "土", Saturday: "土", Sun: "日", Sunday: "日" };
  const enPattern = /\b(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b[^\d]{0,8}([1-7])(?:st|nd|rd|th)?\s*(?:period|限)?/gi;
  for (const match of normalized.matchAll(enPattern)) {
    const key = Object.keys(englishDays).find((name) => name.toLowerCase() === match[1].toLowerCase());
    rows.push({ day: englishDays[key], period: Number(match[2]), startTime: "", endTime: "", room: extractRoomFromText(normalized) });
  }
  return dedupeMeetings(rows);
}

function groupCalendarEventsByCourse(events) {
  const map = new Map();
  for (const event of events || []) {
    const codes = [event.context_code, event.effective_context_code, ...(String(event.all_context_codes || "").split(","))]
      .map((value) => String(value || "").trim());
    const courseIds = new Set();
    for (const code of codes) {
      const match = code.match(/^course_(\d+)$/);
      if (match) courseIds.add(match[1]);
    }
    for (const courseId of courseIds) {
      if (!map.has(courseId)) map.set(courseId, []);
      map.get(courseId).push(event);
    }
  }
  return map;
}

function mapPlannerItems(items, courseMap, baseUrl) {
  return items.map((item) => {
    const plannable = item.plannable || {};
    const type = String(item.plannable_type || plannable.type || "").toLowerCase();
    if (!type.includes("assignment") && !item.assignment_id && !plannable.due_at) return null;
    const courseId = String(item.course_id || plannable.course_id || "");
    const dueAt = plannable.due_at || plannable.todo_date || item.plannable_date || item.new_activity_date || "";
    const title = plannable.title || plannable.name || item.title || `課題 ${item.plannable_id || ""}`;
    const markedComplete = item.planner_override?.marked_complete === true;
    const submitted = isSubmissionDone(item.submissions);
    return {
      sourceId: `canvas-assignment-${courseId}-${item.plannable_id || plannable.id || slug(title)}`,
      canvasId: String(item.plannable_id || plannable.id || ""),
      courseCanvasId: courseId,
      course: courseMap.get(courseId) || item.context_name || `KLMS course ${courseId || "不明"}`,
      title,
      deadline: dueAt ? toTokyoInputValue(dueAt) : "",
      memo: `KLMS Planner API${item.html_url || plannable.html_url ? ` / ${absoluteUrl(baseUrl, item.html_url || plannable.html_url)}` : ""}`,
      done: Boolean(submitted || markedComplete),
      source: "KLMS Planner API",
      url: absoluteUrl(baseUrl, item.html_url || plannable.html_url || ""),
    };
  }).filter(Boolean);
}

function mapCourseAssignments(courseDetails, courseMap, baseUrl) {
  const rows = [];
  for (const detail of courseDetails) {
    const course = detail.course;
    const courseId = String(course.id || "");
    for (const assignment of detail.assignments || []) {
      const dueAt = assignment.due_at || firstAllDateDueAt(assignment.all_dates) || "";
      rows.push({
        sourceId: `canvas-assignment-${courseId}-${assignment.id}`,
        canvasId: String(assignment.id || ""),
        courseCanvasId: courseId,
        course: courseMap.get(courseId) || course.name || `KLMS course ${courseId}`,
        title: assignment.name || `課題 ${assignment.id}`,
        deadline: dueAt ? toTokyoInputValue(dueAt) : "",
        memo: `KLMS Assignments API${assignment.html_url ? ` / ${absoluteUrl(baseUrl, assignment.html_url)}` : ""}`,
        done: isSubmissionDone(assignment.submission),
        source: "KLMS Assignments API",
        url: absoluteUrl(baseUrl, assignment.html_url || ""),
        pointsPossible: assignment.points_possible,
        submissionTypes: assignment.submission_types,
      });
    }
  }
  return rows;
}

function mapCourseTodos(courseDetails, courseMap, baseUrl) {
  const rows = [];
  for (const detail of courseDetails) {
    const course = detail.course;
    const courseId = String(course.id || "");
    for (const todo of detail.todos || []) {
      const assignment = todo.assignment || todo.plannable || todo;
      const dueAt = assignment.due_at || todo.due_at || todo.plannable_date || "";
      rows.push({
        sourceId: `canvas-assignment-${courseId}-${assignment.id || todo.assignment_id || slug(assignment.name || todo.title)}`,
        canvasId: String(assignment.id || todo.assignment_id || ""),
        courseCanvasId: courseId,
        course: courseMap.get(courseId) || course.name || `KLMS course ${courseId}`,
        title: assignment.name || assignment.title || todo.title || "KLMS TODO",
        deadline: dueAt ? toTokyoInputValue(dueAt) : "",
        memo: `KLMS TODO API${assignment.html_url || todo.html_url ? ` / ${absoluteUrl(baseUrl, assignment.html_url || todo.html_url)}` : ""}`,
        done: Boolean(todo.workflow_state === "completed" || isSubmissionDone(assignment.submission) || assignment.has_submitted_submissions),
        source: "KLMS TODO API",
        url: absoluteUrl(baseUrl, assignment.html_url || todo.html_url || ""),
      });
    }
  }
  return rows;
}

function isSubmissionDone(submission) {
  if (!submission || typeof submission !== "object") return false;
  const workflow = String(submission.workflow_state || submission.state || "").toLowerCase();
  return Boolean(
    submission.submitted_at ||
    submission.graded_at ||
    submission.submitted === true ||
    submission.graded === true ||
    ["submitted", "graded", "pending_review", "complete", "completed"].includes(workflow)
  );
}

function dedupeAssignments(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.canvasId && item.courseCanvasId
      ? `${item.courseCanvasId}:${item.canvasId}`
      : `${item.course}:${item.title}:${item.deadline || "undated"}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    map.set(key, {
      ...existing,
      ...item,
      deadline: item.deadline || existing.deadline || "",
      done: Boolean(existing.done || item.done),
      memo: [...new Set([existing.memo, item.memo].filter(Boolean))].join("\n"),
      url: item.url || existing.url,
    });
  }
  return [...map.values()].sort(compareOptionalDates);
}

function dedupeMeetings(items) {
  const map = new Map();
  for (const item of items || []) {
    const key = `${item.day || ""}|${item.period || ""}|${item.startTime || ""}|${item.room || ""}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => timetableDayIndex(a.day) - timetableDayIndex(b.day) || Number(a.period || 99) - Number(b.period || 99));
}

async function safeCanvasGetAll(errors, baseUrl, token, apiPath, params = {}, label = apiPath) {
  try {
    return await canvasGetAll(baseUrl, token, apiPath, params);
  } catch (error) {
    errors.push({ endpoint: label, error: error.message });
    return [];
  }
}

async function safeCanvasGetJson(errors, baseUrl, token, apiPath, params = {}, label = apiPath) {
  try {
    return await canvasGetJson(baseUrl, token, apiPath, params);
  } catch (error) {
    // timetable未設定の404は正常な未設定として扱う。
    if (error.statusCode !== 404) errors.push({ endpoint: label, error: error.message });
    return null;
  }
}

async function canvasGetAll(baseUrl, token, apiPath, params = {}, maxPages = 80) {
  const results = [];
  let url = makeCanvasUrl(baseUrl, apiPath, params);
  for (let page = 0; page < maxPages && url; page++) {
    const response = await canvasFetch(url, token);
    const data = await response.json();
    if (Array.isArray(data)) results.push(...data);
    else if (data) results.push(data);
    url = getNextLink(response.headers.get("link"));
  }
  return results;
}

async function canvasGetJson(baseUrl, token, apiPath, params = {}) {
  const url = makeCanvasUrl(baseUrl, apiPath, params);
  const response = await canvasFetch(url, token);
  return response.json();
}

async function canvasFetch(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json+canvas-string-ids",
      "User-Agent": "KLMS-Plus-Render/1.4",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`Canvas API error ${response.status}: ${body.slice(0, 300)}`);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

function makeCanvasUrl(baseUrl, apiPath, params) {
  const url = new URL(apiPath, baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
    else if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, value);
  });
  return url.toString();
}

function getNextLink(linkHeader) {
  if (!linkHeader) return null;
  const links = linkHeader.split(",").map((part) => part.trim());
  const next = links.find((part) => /rel="next"/.test(part));
  if (!next) return null;
  const match = next.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
  return results.filter(Boolean);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("リクエストが大きすぎます。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("JSONリクエストの形式が不正です。"));
      }
    });
    req.on("error", reject);
  });
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^[\'\"]|[\'\"]$/g, "");
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value || "https://lms.keio.jp");
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("KLMS URLはHTTPSを指定してください。");
  }
  return `${url.protocol}//${url.host}`;
}

function absoluteUrl(baseUrl, value) {
  if (!value) return "";
  try { return new URL(value, baseUrl).toString(); } catch { return ""; }
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function toTokyoInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function tokyoDateParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: weekdayMap[parts.weekday], hour: Number(parts.hour), minute: Number(parts.minute) };
}

function firstAllDateDueAt(allDates) {
  if (!Array.isArray(allDates)) return "";
  const found = allDates.find((item) => item?.due_at);
  return found?.due_at || "";
}

function extractRoomFromCourse(course) {
  const text = `${course.name || ""} ${course.course_code || ""} ${Array.isArray(course.sections) ? course.sections.map((section) => section.name || "").join(" ") : ""} ${stripHtml(course.syllabus_body || "").slice(0, 3000)}`;
  return extractRoomFromText(text);
}

function extractRoomFromText(text) {
  const normalized = String(text || "").normalize("NFKC");
  const patterns = [
    /(?:教室|場所|location)[：:\s]*([A-Za-z一-龠ぁ-んァ-ヶ0-9]+(?:\s*[A-Za-z0-9]+[-ー−][A-Za-z0-9]+|\s+[A-Za-z]?[0-9]{2,4}))/i,
    /((?:日吉|矢上|三田|湘南藤沢|信濃町)?\s*[A-Za-z0-9]{1,4}[-ー−][A-Za-z0-9]{1,5})/,
    /((?:日吉|矢上|三田|湘南藤沢|信濃町)\s+[A-Za-z]?[0-9]{2,4})/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1].trim();
  }
  return "";
}

function parseWeekdays(value) {
  const map = { Mon: "月", Monday: "月", Tue: "火", Tuesday: "火", Wed: "水", Wednesday: "水", Thu: "木", Thursday: "木", Fri: "金", Friday: "金", Sat: "土", Saturday: "土", Sun: "日", Sunday: "日" };
  return String(value || "").split(/[,、\s]+/).map((item) => map[item] || item.match(/[月火水木金土日]/)?.[0]).filter(Boolean);
}

function normalizeClock(value) {
  if (!value) return "";
  const text = String(value).trim().toLowerCase();
  const match = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (match[3] === "pm" && hour < 12) hour += 12;
  if (match[3] === "am" && hour === 12) hour = 0;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function periodFromClock(clock) {
  const match = String(clock || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return "";
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  // 2026年度の三田・日吉・矢上は9:00,10:45,13:00,14:45,16:30,18:10。
  // SFCの9:25,11:10等も同じ時限番号になるよう、代表開始時刻の近いものを選ぶ。
  const candidates = [
    { period: 1, starts: [9 * 60, 9 * 60 + 25] },
    { period: 2, starts: [10 * 60 + 45, 11 * 60 + 10] },
    { period: 3, starts: [13 * 60] },
    { period: 4, starts: [14 * 60 + 45] },
    { period: 5, starts: [16 * 60 + 30] },
    { period: 6, starts: [18 * 60 + 10] },
    { period: 7, starts: [19 * 60 + 50] },
  ];
  let best = { period: "", diff: Infinity };
  for (const candidate of candidates) {
    for (const start of candidate.starts) {
      const diff = Math.abs(minutes - start);
      if (diff < best.diff) best = { period: candidate.period, diff };
    }
  }
  return best.diff <= 45 ? best.period : "";
}

function compareOptionalDates(a, b) {
  const aTime = a.deadline ? new Date(a.deadline).getTime() : Infinity;
  const bTime = b.deadline ? new Date(b.deadline).getTime() : Infinity;
  return (Number.isFinite(aTime) ? aTime : Infinity) - (Number.isFinite(bTime) ? bTime : Infinity);
}

function timetableDayIndex(day) {
  return ["月", "火", "水", "木", "金", "土", "日"].indexOf(day);
}

function dayNumberToJapanese(day) {
  return ["日", "月", "火", "水", "木", "金", "土"][day] || "";
}

function stripHtml(value) {
  return String(value || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function slug(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

const host = "0.0.0.0";

if (databaseConfigured) {
  ensureSchema()
    .then(() => console.log("PostgreSQL schema is ready."))
    .catch((error) => console.error("PostgreSQL initialization failed:", error.message));
}

server.listen(port, host, () => {
  console.log(`KLMS Plus is running on ${host}:${port}`);
  console.log("Health check: GET /api/health");
  console.log("KLMS sync: POST /api/klms/sync-all");
});
