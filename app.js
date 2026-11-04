"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    auth: null, db: null, legacyDb: null, user: null, profile: null,
    stream: null, modelsReady: false, faceTimer: null, records: [], members: [], monthlyReport: [], toastTimer: null,
    registrationInProgress: false
  };
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
  const MATCH_THRESHOLD = 0.48; // Cần hiệu chỉnh bằng dữ liệu thật; không phải bảo đảm chống giả mạo.
  const FACE_DETECTION_OPTIONS = { minConfidence: 0.55, inputSize: 320, maxResults: 1 };
  const GRACE_MINUTES = 5;
  const MIN_PASSWORD_LENGTH = 12;
  const MAX_PHOTO_BYTES = 180 * 1024;

  function localDate(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function localDateTime(date = new Date()) {
    return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  function displayTime(value) {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function setMessage(id, text, type = "") {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.className = "message" + (type ? ` ${type}` : "");
  }
  function toast(message, type = "") {
    const el = $("toast");
    el.textContent = message;
    el.className = `toast ${type}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
  }
  function setButtonBusy(button, busy, label) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? label : button.dataset.originalText;
  }
  async function withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function setAuthTab(tab) {
    const login = tab === "login";
    $("loginTab").classList.toggle("active", login);
    $("registerTab").classList.toggle("active", !login);
    $("loginForm").classList.toggle("hidden", !login);
    $("registerForm").classList.toggle("hidden", login);
    setMessage("authMessage", "");
  }
  function shiftInfo(now = new Date()) {
    const workDate = localDate(now);
    const start = new Date(now); start.setHours(8, 0, 0, 0);
    const end = new Date(now); end.setHours(17, 0, 0, 0);
    return { key: `${workDate}_day`, workDate, shift: "Ca hành chính", start, end };
  }
  function statusForCheckIn(now, shift) {
    const lateAt = new Date(shift.start.getTime() + GRACE_MINUTES * 60000);
    return now > lateAt ? "Đi trễ" : "Đúng giờ";
  }
  function configIsReady() {
    const c = window.FIREBASE_CONFIG;
    return c && c.apiKey && !c.apiKey.startsWith("PASTE_") &&
      c.projectId && c.projectId !== "YOUR_PROJECT_ID" &&
      c.appId && !c.appId.startsWith("PASTE_");
  }
  function employeeCodeDocId(code) {
    return encodeURIComponent(code);
  }
  async function importLegacyAccount(uid, fallbackProfile) {
    if (!state.legacyDb) {
      await state.db.collection("users").doc(uid).set(fallbackProfile);
      return fallbackProfile;
    }
    const [userSnap, faceSnap, attendanceSnap] = await Promise.all([
      withTimeout(state.legacyDb.ref(`users/${uid}`).once("value"), 15000, "Hết thời gian đọc hồ sơ cũ."),
      withTimeout(state.legacyDb.ref(`faceProfiles/${uid}`).once("value"), 15000, "Hết thời gian đọc hồ sơ khuôn mặt cũ."),
      withTimeout(state.legacyDb.ref(`attendance/${uid}`).once("value"), 15000, "Hết thời gian đọc lịch sử chấm công cũ.")
    ]);
    const profile = userSnap.val() || fallbackProfile;
    if (profile.role === "admin") {
      profile.role = "employee";
      console.warn("Vai trò quản trị cũ cần được cấp lại trong Firestore.");
    }

    const attendance = attendanceSnap.val() || {};
    const records = Object.entries(attendance).filter(([, record]) => record && typeof record === "object");
    for (let offset = 0; offset < records.length; offset += 450) {
      const batch = state.db.batch();
      for (const [key, record] of records.slice(offset, offset + 450)) {
        const attendanceRecord = { ...record };
        delete attendanceRecord.checkInPhoto;
        delete attendanceRecord.checkOutPhoto;
        batch.set(state.db.collection("attendance").doc(`${uid}_${key}`), {
          ...attendanceRecord,
          employeeUid: uid,
          migratedFromLegacy: true
        });
      }
      await withTimeout(batch.commit(), 20000, "Hết thời gian chuyển lịch sử chấm công cũ sang Firestore.");
    }

    const batch = state.db.batch();
    batch.set(state.db.collection("users").doc(uid), profile);
    if (faceSnap.exists()) {
      batch.set(state.db.collection("faceProfiles").doc(uid), faceSnap.val());
    }
    if (profile.employeeId) {
      const codeRef = state.db.collection("employeeCodes").doc(employeeCodeDocId(profile.employeeId));
      const [legacyCodeSnap, firestoreCodeSnap] = await Promise.all([
        withTimeout(state.legacyDb.ref(`employeeCodes/${profile.employeeId}`).once("value"), 15000, "Hết thời gian đọc mã nhân viên cũ."),
        codeRef.get()
      ]);
      if (legacyCodeSnap.val() === uid && !firestoreCodeSnap.exists) {
        batch.set(codeRef, { uid });
      }
    }
    await withTimeout(batch.commit(), 20000, "Hết thời gian lưu hồ sơ cũ sang Firestore.");
    return profile;
  }
  function initFirebase() {
    if (!configIsReady()) {
      setMessage("authMessage", "Bạn chưa điền firebase-config.js. Hãy làm theo README.txt trước khi đăng nhập.", "error");
      return false;
    }
    if (!window.firebase) {
      setMessage("authMessage", "Không tải được Firebase SDK. Kiểm tra kết nối Internet rồi tải lại trang.", "error");
      return false;
    }
    try {
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(window.FIREBASE_CONFIG);
      state.auth = app.auth();
      state.db = app.firestore();
      state.legacyDb = window.FIREBASE_CONFIG.databaseURL ? app.database() : null;
      state.auth.onAuthStateChanged(async (user) => {
        if (!user) {
          state.user = null; state.profile = null;
          stopCamera();
          $("authView").classList.remove("hidden");
          $("appView").classList.add("hidden");
          $("userBadge").classList.add("hidden");
          return;
        }
        if (state.registrationInProgress) {
          state.user = user;
          return;
        }
        state.user = user;
        try {
          const userRef = state.db.collection("users").doc(user.uid);
          const snap = await withTimeout(userRef.get(), 15000, "Hết thời gian tải hồ sơ từ Firestore.");
          let profile = snap.exists ? snap.data() : null;
          if (!profile) {
            const fallbackProfile = {
              name: user.displayName || user.email.split("@")[0],
              employeeId: "NV-" + user.uid.slice(0, 6).toUpperCase(),
              email: user.email || "", role: "employee", createdAt: localDateTime()
            };
            profile = await importLegacyAccount(user.uid, fallbackProfile);
          }
          state.profile = profile;
          await showApp();
        } catch (error) {
          toast("Không tải được hồ sơ: " + error.message, "error");
        }
      });
      return true;
    } catch (error) {
      setMessage("authMessage", "Lỗi khởi tạo Firebase: " + error.message, "error");
      return false;
    }
  }
  async function showApp() {
    $("authView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("userBadge").classList.remove("hidden");
    $("userBadge").textContent = state.profile.name || state.user.email;
    $("welcomeTitle").textContent = `Xin chào, ${state.profile.name || "bạn"}!`;
    $("welcomeSub").textContent = state.profile.role === "admin"
      ? "Chế độ quản trị · xem dữ liệu chấm công toàn bộ nhân viên."
      : "Đây là bảng điều khiển chấm công của bạn.";
    $("profileName").textContent = state.profile.name || "—";
    $("profileEmployeeId").textContent = state.profile.employeeId || "—";
    $("profileEmail").textContent = state.profile.email || state.user.email || "—";
    $("profileRole").textContent = state.profile.role === "admin" ? "Quản trị viên" : "Nhân viên";
    $("avatarInitials").textContent = (state.profile.name || "NV").split(/\s+/).slice(-2).map(s => s[0]).join("").toUpperCase();
    $("adminNote").classList.toggle("hidden", state.profile.role !== "admin");
    $("deleteAttendanceDateBtn").classList.toggle("hidden", state.profile.role !== "admin");
    $("adminPanel").classList.toggle("hidden", state.profile.role !== "admin");
    $("adminDashboardToggle").classList.toggle("hidden", state.profile.role !== "admin");
    $("filterDate").value = localDate();
    $("adminEmployeeDate").value = localDate();
    $("adminMonthPicker").value = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    $("statDate").textContent = localDate();
    updateAdminButtonState();
    if (state.profile.role === "admin") {
      setAdminDrawer(false);
      setAdminTab("overview");
      renderAdminSettings();
    }
    await updateFaceStatus();
    if (state.profile.role === "admin") {
      await loadMembers();
      await loadMonthlyReport();
    } else {
      state.members = [];
      renderAdminMembers([]);
    }
    await loadAttendance();
  }
  function renderAdminMembers(rows) {
    const tbody = $("adminMembersTableBody");
    if (!tbody) return;
    const search = ($("adminMemberSearch").value || "").trim().toLowerCase();
    const roleFilter = ($("adminMemberRoleFilter").value || "all");
    const filtered = rows.filter((member) => {
      const matchRole = roleFilter === "all" || member.role === roleFilter;
      const haystack = `${member.name} ${member.employeeId} ${member.email}`.toLowerCase();
      const matchSearch = !search || haystack.includes(search);
      return matchRole && matchSearch;
    });
    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Không tìm thấy thành viên phù hợp.</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map((member) => {
      const isSelf = state.user && member.uid === state.user.uid;
      const roleLabel = member.role === "admin" ? "Quản trị viên" : "Nhân viên";
      const actionButton = isSelf
        ? '<span class="member-self-tag">Bạn</span>'
        : `<button type="button" class="btn mini ${member.role === "admin" ? "secondary" : "primary"}" data-action="toggle-role" data-uid="${esc(member.uid)}" data-role="${member.role}">${member.role === "admin" ? "Gỡ quyền admin" : "Cấp quyền admin"}</button>`;
      return `<tr>
        <td><strong>${esc(member.name || "Không rõ")}</strong></td>
        <td>${esc(member.employeeId || "—")}</td>
        <td>${esc(member.email || "—")}</td>
        <td><span class="tag ${member.role === "admin" ? "admin-role" : "employee-role"}">${esc(roleLabel)}</span></td>
        <td>${esc(member.faceStatus || "Chưa đăng ký")}</td>
        <td class="member-actions">${actionButton}</td>
      </tr>`;
    }).join("");
  }
  function setAdminDrawer(open) {
    const panel = $("adminPanel");
    const overlay = $("adminDrawerOverlay");
    if (!panel || !overlay) return;
    panel.classList.toggle("open", open);
    overlay.classList.toggle("visible", open);
    overlay.classList.toggle("hidden", !open);
    panel.classList.toggle("hidden", false);
  }
  function updateAdminButtonState() {
    const toggle = $("adminDashboardToggle");
    if (!toggle) return;
    const isAdmin = !!(state.profile && state.profile.role === "admin");
    toggle.classList.toggle("hidden", !isAdmin);
    toggle.onclick = () => setAdminDrawer($("adminPanel").classList.contains("open") ? false : true);
  }
  function renderAdminSummary(rows, todayRecords) {
    const total = rows.length;
    const admins = rows.filter((member) => member.role === "admin").length;
    const checkedIn = todayRecords.filter((record) => record.checkIn && !record.checkOut).length;
    const late = todayRecords.filter((record) => record.status === "Đi trễ").length;
    $("adminSummaryTotal").textContent = String(total);
    $("adminSummaryAdmins").textContent = String(admins);
    $("adminSummaryCheckedIn").textContent = String(checkedIn);
    $("adminSummaryLate").textContent = String(late);

    const overviewList = $("adminOverviewList");
    const attentionList = $("adminAttentionList");
    if (overviewList) {
      const onTime = todayRecords.filter((record) => record.status === "Đúng giờ").length;
      const pending = todayRecords.filter((record) => record.checkIn && !record.checkOut).length;
      overviewList.innerHTML = [
        `<li>Nhân viên: ${rows.length}</li>`,
        `<li>Đúng giờ: ${onTime}</li>`,
        `<li>Đi trễ: ${late}</li>`,
        `<li>Chưa chấm ra: ${pending}</li>`
      ].join("");
    }
    if (attentionList) {
      const lateMembers = todayRecords.filter((record) => record.status === "Đi trễ").map((record) => record.employeeName || record.employeeId || "Nhân viên");
      const list = lateMembers.length ? lateMembers.slice(0, 5) : ["Không có nhân viên nào cần chú ý trong ngày"];
      attentionList.innerHTML = list.map((item) => `<li>${esc(item)}</li>`).join("");
    }
  }
  function setAdminTab(tabName) {
    document.querySelectorAll(".admin-tab").forEach((button) => {
      const active = button.dataset.adminTab === tabName;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    document.querySelectorAll(".admin-tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.adminTab !== tabName);
      panel.classList.toggle("active", panel.dataset.adminTab === tabName);
    });
  }
  function renderMonthlyReport(records, monthValue) {
    const chart = $("monthlyChart");
    const monthRows = $("monthlyEmployeeRows");
    if (!chart || !monthRows) return;

    const [year, month] = (monthValue || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`).split("-").map(Number);
    const totalDays = new Date(year, month, 0).getDate();
    const dailyMap = {};
    for (let day = 1; day <= totalDays; day += 1) {
      const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      dailyMap[key] = { total: 0, late: 0, onTime: 0, pending: 0 };
    }

    records.forEach((record) => {
      if (!record.workDate || !record.workDate.startsWith(`${year}-${String(month).padStart(2, "0")}`)) return;
      const entry = dailyMap[record.workDate] || { total: 0, late: 0, onTime: 0, pending: 0 };
      entry.total += 1;
      if (record.status === "Đi trễ") entry.late += 1;
      if (record.status === "Đúng giờ") entry.onTime += 1;
      if (record.checkIn && !record.checkOut) entry.pending += 1;
      dailyMap[record.workDate] = entry;
    });

    const maxValue = Math.max(1, ...Object.values(dailyMap).map((entry) => entry.total));
    const labels = Object.keys(dailyMap).map((date) => date.slice(-2));
    chart.innerHTML = labels.map((label, index) => {
      const date = Object.keys(dailyMap)[index];
      const value = dailyMap[date].total || 0;
      const height = Math.max(8, (value / maxValue) * 100);
      return `<div class="month-bar-wrap"><span class="month-bar" style="height:${height}%"></span><span class="month-bar-label">${label}</span></div>`;
    }).join("");

    const byEmployee = {};
    records.forEach((record) => {
      const key = record.employeeUid || record.employeeName || "Unknown";
      if (!byEmployee[key]) {
        byEmployee[key] = { name: record.employeeName || "Nhân viên", total: 0, late: 0 };
      }
      byEmployee[key].total += 1;
      if (record.status === "Đi trễ") byEmployee[key].late += 1;
    });
    const employeeRows = Object.values(byEmployee).sort((a, b) => b.total - a.total);
    monthRows.innerHTML = employeeRows.length
      ? employeeRows.slice(0, 8).map((member) => `
          <tr>
            <td>${esc(member.name || "Nhân viên")}</td>
            <td>${member.total}</td>
            <td>${member.late}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="3" class="empty">Không có dữ liệu trong tháng này.</td></tr>';

    $("reportTotalCount").textContent = String(records.length);
    $("reportOnTimeCount").textContent = String(records.filter((record) => record.status === "Đúng giờ").length);
    $("reportLateCount").textContent = String(records.filter((record) => record.status === "Đi trễ").length);
    $("reportPendingCount").textContent = String(records.filter((record) => record.checkIn && !record.checkOut).length);
  }
  async function loadMonthlyReport() {
    if (!state.user || !state.profile || state.profile.role !== "admin") return;
    const monthValue = $("adminMonthPicker").value || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    const [year, month] = monthValue.split("-").map(Number);
    const start = `${year}-${pad(month)}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const end = `${year}-${pad(month)}-${String(endDay).padStart(2, "0")}`;
    try {
      const snap = await withTimeout(
        state.db.collection("attendance").where("workDate", ">=", start).where("workDate", "<=", end).get(),
        15000,
        "Hết thời gian tải báo cáo tháng."
      );
      const records = snap.docs.map((doc) => doc.data());
      state.monthlyReport = records;
      renderMonthlyReport(records, monthValue);
    } catch (error) {
      setMessage("historyMessage", "Không tải được báo cáo tháng: " + friendlyError(error), "error");
    }
  }
  function renderAdminSettings() {
    const input = $("adminEmailAlertUrl");
    if (!input) return;
    const storedValue = localStorage.getItem("worktime_email_alert_url") || window.WORKTIME_EMAIL_ALERT_URL || "";
    input.value = storedValue;
    window.WORKTIME_EMAIL_ALERT_URL = storedValue;
    const projectId = $("settingsProjectId");
    if (projectId && window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId) {
      projectId.textContent = window.FIREBASE_CONFIG.projectId;
    }
  }
  function saveAdminSettings() {
    const input = $("adminEmailAlertUrl");
    if (!input) return;
    const url = input.value.trim();
    if (url) {
      window.WORKTIME_EMAIL_ALERT_URL = url;
      localStorage.setItem("worktime_email_alert_url", url);
      toast("Đã lưu URL cảnh báo email.", "success");
    } else {
      window.WORKTIME_EMAIL_ALERT_URL = "";
      localStorage.removeItem("worktime_email_alert_url");
      toast("Đã xóa URL cảnh báo email.", "success");
    }
  }
  function populateAdminEmployeeSelect(rows) {
    const select = $("adminEmployeeSelect");
    if (!select) return;
    const value = select.value || "";
    const options = rows.map((member) => `<option value="${esc(member.uid)}">${esc(member.name || member.employeeId || member.email || "Nhân viên")}</option>`).join("");
    select.innerHTML = `<option value="">-- Chọn nhân viên --</option>${options}`;
    if (rows.some((member) => member.uid === value)) {
      select.value = value;
    }
  }
  async function loadMembers() {
    if (!state.user || !state.profile || state.profile.role !== "admin") return;
    try {
      const [userSnap, faceSnap] = await Promise.all([
        withTimeout(state.db.collection("users").orderBy("name").get(), 15000, "Hết thời gian tải danh sách nhân viên."),
        withTimeout(state.db.collection("faceProfiles").get(), 15000, "Hết thời gian tải trạng thái khuôn mặt.")
      ]);
      const faceMap = {};
      faceSnap.forEach((doc) => {
        const data = doc.data() || {};
        const hasFace = Array.isArray(data.descriptor) || Array.isArray(data.maskedDescriptor);
        faceMap[doc.id] = {
          hasFace,
          faceStatus: Array.isArray(data.maskedDescriptor)
            ? "Đã đăng ký (khẩu trang)"
            : (hasFace ? "Đã đăng ký" : "Chưa đăng ký")
        };
      });
      const rows = userSnap.docs.map((doc) => {
        const data = doc.data() || {};
        const face = faceMap[doc.id] || { faceStatus: "Chưa đăng ký", hasFace: false };
        return {
          uid: doc.id,
          name: data.name || "Không rõ",
          employeeId: data.employeeId || "—",
          email: data.email || "",
          role: data.role === "admin" ? "admin" : "employee",
          faceStatus: face.faceStatus,
          hasFace: face.hasFace
        };
      });
      state.members = rows;
      renderAdminMembers(rows);
      populateAdminEmployeeSelect(rows);
      const adminCount = rows.filter((member) => member.role === "admin").length;
      $("adminMemberCount").textContent = `${rows.length} thành viên · ${adminCount} admin`;
      const today = $("filterDate").value || localDate();
      const todaySnapshot = await withTimeout(
        state.db.collection("attendance").where("workDate", "==", today).get(),
        15000,
        "Hết thời gian tải thống kê chấm công hôm nay."
      );
      const todayRecords = todaySnapshot.docs.map((doc) => doc.data());
      renderAdminSummary(rows, todayRecords);
    } catch (error) {
      $("adminMemberCount").textContent = "Không tải được";
      setMessage("historyMessage", "Không tải được danh sách nhân viên: " + friendlyError(error), "error");
    }
  }
  async function loadAdminMemberHistory() {
    const uid = $("adminEmployeeSelect").value;
    const selectedDate = $("adminEmployeeDate").value || localDate();
    if (!uid) {
      $("adminMemberHistoryRows").innerHTML = '<tr><td colspan="7" class="empty">Vui lòng chọn nhân viên.</td></tr>';
      return;
    }
    try {
      const snap = await withTimeout(
        state.db.collection("attendance").where("employeeUid", "==", uid).where("workDate", "==", selectedDate).get(),
        15000,
        "Hết thời gian tải lịch sử chấm công của nhân viên."
      );
      const rows = snap.docs.map((doc) => ({ key: doc.id, ...doc.data() }));
      rows.sort((a, b) => String(b.checkIn || "").localeCompare(String(a.checkIn || "")));
      const tbody = $("adminMemberHistoryRows");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">Không có bản ghi trong ngày này.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map((record) => `
        <tr>
          <td><strong>${esc(record.employeeName || "Nhân viên")}</strong><br><span class="muted">${esc(record.employeeId || "")}</span></td>
          <td>${esc(record.workDate || "—")}</td>
          <td>${esc(record.shift || "—")}</td>
          <td>${esc(displayTime(record.checkIn))}</td>
          <td><span class="tag ${record.status === "Đi trễ" ? "late" : "on-time"}">${esc(record.status || "Đã ghi nhận")}</span></td>
          <td>${esc(displayTime(record.checkOut))}</td>
          <td>${renderPhoto(record.checkInPhotoData || "", "Ảnh vào")}${record.checkOutPhotoData ? "<br>" : ""}${renderPhoto(record.checkOutPhotoData || "", "Ảnh ra")}</td>
        </tr>
      `).join("");
    } catch (error) {
      setMessage("historyMessage", "Không tải lịch sử của nhân viên: " + friendlyError(error), "error");
      $("adminMemberHistoryRows").innerHTML = '<tr><td colspan="7" class="empty">Không tải được dữ liệu.</td></tr>';
    }
  }
  async function deleteMemberAttendanceForDate() {
    const uid = $("adminEmployeeSelect").value;
    const selectedDate = $("adminEmployeeDate").value || localDate();
    if (!uid) {
      toast("Vui lòng chọn nhân viên trước khi xóa bản ghi.", "error");
      return;
    }
    try {
      const snap = await withTimeout(
        state.db.collection("attendance").where("employeeUid", "==", uid).where("workDate", "==", selectedDate).get(),
        15000,
        "Hết thời gian tải dữ liệu chấm công cần xóa."
      );
      if (snap.empty) {
        toast(`Không có dữ liệu chấm công cho nhân viên này trong ngày ${selectedDate}.`, "error");
        return;
      }
      const confirmMessage = `Xóa toàn bộ ${snap.size} bản ghi chấm công của nhân viên này trong ngày ${selectedDate}?`;
      if (!window.confirm(confirmMessage)) return;
      for (let offset = 0; offset < snap.docs.length; offset += 450) {
        const batch = state.db.batch();
        snap.docs.slice(offset, offset + 450).forEach((doc) => batch.delete(doc.ref));
        await withTimeout(batch.commit(), 20000, "Hết thời gian xóa bản ghi chấm công của nhân viên.");
      }
      toast(`Đã xóa ${snap.size} bản ghi chấm công của nhân viên trong ngày ${selectedDate}.`, "success");
      await loadAdminMemberHistory();
      await loadMembers();
    } catch (error) {
      toast("Không xóa được dữ liệu: " + friendlyError(error), "error");
    }
  }
  async function updateMemberRole(uid, nextRole) {
    if (!uid) return;
    if (uid === state.user.uid && nextRole === "employee") {
      toast("Bạn không thể hạ quyền quản trị cho chính mình.", "error");
      return;
    }
    try {
      await withTimeout(
        state.db.collection("users").doc(uid).update({ role: nextRole }),
        15000,
        "Hết thời gian cập nhật vai trò cho nhân viên."
      );
      toast(nextRole === "admin" ? "Đã cấp quyền quản trị cho nhân viên." : "Đã gỡ quyền quản trị của nhân viên.", "success");
      await loadMembers();
    } catch (error) {
      toast("Không cập nhật được vai trò: " + friendlyError(error), "error");
    }
  }
  async function updateFaceStatus() {
    try {
      const snap = await withTimeout(
        state.db.collection("faceProfiles").doc(state.user.uid).get(),
        15000,
        "Hết thời gian chờ kiểm tra hồ sơ khuôn mặt."
      );
      const profile = snap.exists ? snap.data() : null;
      $("profileFaceStatus").textContent = !profile
        ? "Chưa đăng ký"
        : (Array.isArray(profile.maskedDescriptor) ? "Đã đăng ký (có khẩu trang)" : "Đã đăng ký");
      $("deleteFaceProfileBtn").classList.toggle("hidden", !profile);
    } catch (error) {
      $("profileFaceStatus").textContent = "Không kiểm tra được";
      $("deleteFaceProfileBtn").classList.add("hidden");
      console.error("Không kiểm tra được hồ sơ khuôn mặt:", error);
    }
  }
  async function deleteFaceProfile() {
    if (!state.user) return;
    if (!window.confirm("Bạn có chắc muốn hủy đăng ký và xóa hồ sơ khuôn mặt? Bạn sẽ cần đăng ký lại để chấm công bằng nhận diện.")) return;
    const button = $("deleteFaceProfileBtn");
    setButtonBusy(button, true, "Đang xóa...");
    try {
      await withTimeout(
        state.db.collection("faceProfiles").doc(state.user.uid).delete(),
        15000,
        "Hết thời gian xóa hồ sơ khuôn mặt khỏi Firestore."
      );
      await updateFaceStatus();
      toast("Đã hủy đăng ký và xóa hồ sơ khuôn mặt.", "success");
    } catch (error) {
      toast("Không xóa được hồ sơ khuôn mặt: " + friendlyError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }
  async function registerAccount(event) {
    event.preventDefault();
    const name = $("registerName").value.trim();
    const employeeId = $("registerEmployeeId").value.trim().toUpperCase();
    const email = $("registerEmail").value.trim();
    const password = $("registerPassword").value;
    if (!name || !employeeId || !email || !isStrongPassword(password)) {
      setMessage("authMessage", "Vui lòng nhập đầy đủ thông tin. Mật khẩu cần ít nhất 12 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.", "error");
      return;
    }
    setButtonBusy($("registerForm").querySelector("button[type=submit]"), true, "Đang tạo...");
    let credential = null;
    state.registrationInProgress = true;
    try {
      const codeRef = state.db.collection("employeeCodes").doc(employeeCodeDocId(employeeId));
      credential = await state.auth.createUserWithEmailAndPassword(email, password);
      const profile = { name, employeeId, email, role: "employee", createdAt: localDateTime() };
      const userRef = state.db.collection("users").doc(credential.user.uid);
      await withTimeout(state.db.runTransaction(async (transaction) => {
        const code = await transaction.get(codeRef);
        if (code.exists) throw new Error("Mã nhân viên đã được sử dụng.");
        transaction.set(codeRef, { uid: credential.user.uid });
        transaction.set(userRef, profile);
      }), 20000, "Hết thời gian tạo hồ sơ trong Firestore.");
      state.user = credential.user;
      state.profile = profile;
      setMessage("authMessage", "Tạo tài khoản thành công.", "success");
      await showApp();
    } catch (error) {
      let message = friendlyError(error);
      if (credential && credential.user) {
        try {
          await credential.user.delete();
        } catch (cleanupError) {
          console.error("Không thể xóa tài khoản Auth được tạo khi lưu hồ sơ thất bại:", cleanupError);
          message += " Firebase đã tạo tài khoản nhưng chưa lưu hồ sơ; sau khi sửa cấu hình, hãy đăng nhập lại để hoàn tất.";
          try {
            await state.auth.signOut();
          } catch (signOutError) {
            console.error("Không thể đăng xuất sau khi lưu hồ sơ đăng ký thất bại:", signOutError);
          }
        }
      }
      setMessage("authMessage", message, "error");
    } finally {
      state.registrationInProgress = false;
      setButtonBusy($("registerForm").querySelector("button[type=submit]"), false);
    }
  }
  async function login(event) {
    event.preventDefault();
    setButtonBusy($("loginForm").querySelector("button[type=submit]"), true, "Đang đăng nhập...");
    try {
      await state.auth.signInWithEmailAndPassword($("loginEmail").value.trim(), $("loginPassword").value);
      setMessage("authMessage", "");
    } catch (error) {
      setMessage("authMessage", friendlyError(error), "error");
    } finally {
      setButtonBusy($("loginForm").querySelector("button[type=submit]"), false);
    }
  }
  function isStrongPassword(password) {
    return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH &&
      /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) &&
      /[^A-Za-z0-9]/.test(password);
  }
  async function forgotPassword() {
    const email = $("loginEmail").value.trim();
    if (!email) {
      setMessage("authMessage", "Nhập email tài khoản trước để nhận thư đặt lại mật khẩu.", "error");
      $("loginEmail").focus();
      return;
    }
    const button = $("forgotPasswordBtn");
    setButtonBusy(button, true, "Đang gửi email...");
    try {
      state.auth.languageCode = "vi";
      await state.auth.sendPasswordResetEmail(email);
      setMessage("authMessage", "Nếu email thuộc tài khoản WorkTime, hướng dẫn đặt lại mật khẩu sẽ được gửi tới hộp thư đó.", "success");
    } catch (error) {
      if (error && error.code === "auth/user-not-found") {
        setMessage("authMessage", "Nếu email thuộc tài khoản WorkTime, hướng dẫn đặt lại mật khẩu sẽ được gửi tới hộp thư đó.", "success");
      } else {
        setMessage("authMessage", friendlyError(error), "error");
      }
    } finally {
      setButtonBusy(button, false);
    }
  }
  async function changePasswordByEmail() {
    const email = state.user && state.user.email;
    if (!email) {
      toast("Tài khoản hiện tại không có email để gửi hướng dẫn đặt lại mật khẩu.", "error");
      return;
    }
    const button = $("changePasswordBtn");
    setButtonBusy(button, true, "Đang gửi email...");
    try {
      state.auth.languageCode = "vi";
      await state.auth.sendPasswordResetEmail(email);
      toast("Đã gửi hướng dẫn đặt lại mật khẩu tới email tài khoản. Hãy mở email để xác nhận và tạo mật khẩu mới.", "success");
    } catch (error) {
      toast("Không gửi được email đặt lại mật khẩu: " + friendlyError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }
  function friendlyError(error) {
    const code = error && error.code;
    const map = {
      "auth/invalid-email": "Địa chỉ email không hợp lệ.",
      "auth/user-not-found": "Không tìm thấy tài khoản.",
      "auth/wrong-password": "Mật khẩu không đúng.",
      "auth/invalid-credential": "Email hoặc mật khẩu không đúng.",
      "auth/email-already-in-use": "Email này đã có tài khoản.",
      "auth/weak-password": "Mật khẩu chưa đáp ứng chính sách bảo mật của Firebase.",
      "auth/too-many-requests": "Bạn đã yêu cầu quá nhiều lần. Hãy đợi rồi thử lại.",
      "auth/operation-not-allowed": "Firebase chưa bật phương thức Email/Password. Vào Authentication > Sign-in method và bật Email/Password.",
      "auth/network-request-failed": "Không kết nối được Firebase. Kiểm tra mạng rồi thử lại.",
      "auth/unauthorized-domain": "Tên miền trang web chưa được cấp phép trong Firebase Authentication.",
      "PERMISSION_DENIED": "Firebase từ chối quyền truy cập. Kiểm tra Firestore Rules.",
      "permission-denied": "Firestore Rules từ chối thao tác. Publish nội dung firestore.rules mới vào đúng Firebase project rồi thử lại.",
      "failed-precondition": "Firestore chưa được thiết lập hoặc yêu cầu chỉ mục chưa sẵn sàng."
    };
    return map[code] || error.message || "Đã xảy ra lỗi.";
  }
  async function loadModels() {
    if (state.modelsReady) return true;
    if (!window.faceapi) throw new Error("Không tải được thư viện nhận diện khuôn mặt. Kiểm tra Internet.");
    $("aiStatus").textContent = "Đang tải AI…";
    try {
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      state.modelsReady = true;
      $("aiStatus").textContent = "AI sẵn sàng";
      $("aiStatus").classList.add("ready");
      return true;
    } catch (error) {
      $("aiStatus").textContent = "Lỗi tải AI";
      throw new Error("Không tải được model AI. Kiểm tra mạng hoặc đường dẫn model. " + error.message);
    }
  }
  function waitForVideoReady(video) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("error", onError);
      };
      const onReady = () => {
        if (video.videoWidth > 0) {
          cleanup();
          resolve();
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error("Không nhận được hình ảnh từ camera. Hãy thử tắt rồi bật lại camera."));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Camera chưa phát hình ảnh. Hãy kiểm tra quyền camera rồi thử lại."));
      }, 10000);
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("error", onError);
    });
  }
  async function startCamera() {
    setMessage("cameraMessage", "");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMessage("cameraMessage", "Trình duyệt không hỗ trợ camera hoặc trang chưa chạy bằng HTTPS/localhost.", "error");
      return;
    }
    try {
      await loadModels();
      stopCamera();
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const video = $("camera");
      video.srcObject = state.stream;
      await video.play();
      await waitForVideoReady(video);
      video.classList.remove("hidden");
      $("cameraPlaceholder").classList.add("hidden");
      $("registerFaceBtn").disabled = false;
      $("registerMaskedFaceBtn").disabled = false;
      $("attendanceBtn").disabled = false;
      setMessage("cameraMessage", "Camera đã bật. Hãy nhìn thẳng vào camera.", "success");
    } catch (error) {
      stopCamera();
      setMessage("cameraMessage", friendlyError(error), "error");
    }
  }
  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
    if ($("camera")) $("camera").srcObject = null;
    if ($("cameraPlaceholder")) $("cameraPlaceholder").classList.remove("hidden");
    if ($("camera")) $("camera").classList.add("hidden");
    if ($("registerFaceBtn")) $("registerFaceBtn").disabled = true;
    if ($("registerMaskedFaceBtn")) $("registerMaskedFaceBtn").disabled = true;
    if ($("attendanceBtn")) $("attendanceBtn").disabled = true;
  }
  async function detectFace() {
    if (!state.stream || !$("camera").videoWidth) throw new Error("Hãy bật camera và đợi hình ảnh xuất hiện.");
    const result = await faceapi.detectSingleFace($("camera"), new faceapi.SsdMobilenetv1Options(FACE_DETECTION_OPTIONS))
      .withFaceLandmarks().withFaceDescriptor();
    if (!result) throw new Error("Chưa phát hiện khuôn mặt rõ. Hãy nhìn thẳng, đủ sáng và bỏ khẩu trang nếu phù hợp.");
    return Array.from(result.descriptor);
  }
  async function detectStableFace() {
    const sampleCount = 3;
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      samples.push(await detectFace());
      if (i < sampleCount - 1) {
        await new Promise(resolve => setTimeout(resolve, 180));
      }
    }
    return samples[0].map((_, index) =>
      samples.reduce((sum, sample) => sum + sample[index], 0) / sampleCount
    );
  }
  async function registerFace() {
    return saveFaceDescriptor(false);
  }
  async function registerMaskedFace() {
    return saveFaceDescriptor(true);
  }
  async function findDuplicateFace(descriptor, currentUid = null) {
    if (state.profile.role !== "admin") return null;
    const snap = await withTimeout(
      state.db.collection("faceProfiles").get(),
      15000,
      "Hết thời gian kiểm tra khuôn mặt trùng."
    );
    let bestMatch = null;
    for (const doc of snap.docs) {
      if (doc.id === currentUid) continue;
      const data = doc.data() || {};
      const candidates = [data.descriptor, data.maskedDescriptor].filter(Array.isArray);
      for (const candidate of candidates) {
        if (!Array.isArray(candidate) || candidate.length !== descriptor.length) continue;
        const distance = faceapi.euclideanDistance(
          new Float32Array(descriptor),
          new Float32Array(candidate)
        );
        if (distance <= MATCH_THRESHOLD && (!bestMatch || distance < bestMatch.distance)) {
          bestMatch = { uid: doc.id, distance, name: data.name || "Người dùng khác" };
        }
      }
    }
    return bestMatch;
  }
  async function saveFaceDescriptor(masked) {
    if (!state.user || !state.profile) return;
    const button = $(masked ? "registerMaskedFaceBtn" : "registerFaceBtn");
    setButtonBusy(button, true, "Đang nhận diện...");
    try {
      setMessage("cameraMessage", "Giữ yên, nhìn thẳng và đủ sáng; đang lấy nhiều mẫu khuôn mặt...");
      const descriptor = await detectStableFace();
      const duplicate = await findDuplicateFace(descriptor, state.user.uid);
      if (duplicate) {
        const message = `Khuôn mặt này đã được đăng ký cho một tài khoản khác. Vui lòng dùng camera hoặc mẫu khuôn mặt khác.`;
        setMessage("cameraMessage", message, "error");
        toast(message, "error");
        return;
      }
      const profile = {
        [masked ? "maskedDescriptor" : "descriptor"]: descriptor,
        employeeId: state.profile.employeeId, updatedAt: localDateTime(),
        model: "face-api.js"
      };
      await withTimeout(
        state.db.collection("faceProfiles").doc(state.user.uid).set(profile, { merge: true }),
        15000,
        "Hết thời gian lưu hồ sơ khuôn mặt vào Firestore."
      );
      await updateFaceStatus();
      const successMessage = masked
        ? "Đã lưu mẫu khuôn mặt khi đeo khẩu trang. Hãy giữ khẩu trang khi chấm công."
        : "Đã đăng ký khuôn mặt cho tài khoản này.";
      toast(successMessage, "success");
      setMessage("cameraMessage", successMessage, "success");
    } catch (error) {
      setMessage("cameraMessage", friendlyError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }
  async function getCandidateProfiles() {
    if (state.profile.role === "admin") {
      const snap = await withTimeout(
        state.db.collection("faceProfiles").get(),
        15000,
        "Hết thời gian chờ tải hồ sơ khuôn mặt từ Firebase."
      );
      return snap.docs
        .filter((doc) =>
          (Array.isArray(doc.data().descriptor) || Array.isArray(doc.data().maskedDescriptor)))
        .map((doc) => ({ uid: doc.id, ...doc.data() }));
    }
    const snap = await withTimeout(
      state.db.collection("faceProfiles").doc(state.user.uid).get(),
      15000,
      "Hết thời gian chờ tải hồ sơ khuôn mặt từ Firebase."
    );
    const p = snap.exists ? snap.data() : null;
    return p && (Array.isArray(p.descriptor) || Array.isArray(p.maskedDescriptor))
      ? [{ uid: state.user.uid, ...p }]
      : [];
  }
  async function identifyFace() {
    setMessage("cameraMessage", "Đang nhận diện khuôn mặt...");
    const descriptor = await withTimeout(
      detectFace(),
      20000,
      "Nhận diện khuôn mặt mất quá lâu. Hãy thử bật lại camera hoặc tải lại trang."
    );
    setMessage("cameraMessage", "Đang kiểm tra hồ sơ khuôn mặt...");
    const candidates = await getCandidateProfiles();
    if (!candidates.length) throw new Error(state.profile.role === "admin"
      ? "Firebase chưa có hồ sơ khuôn mặt hợp lệ. Hãy đăng ký khuôn mặt cho tài khoản cần chấm công."
      : "Bạn chưa đăng ký khuôn mặt. Nhấn “Đăng ký khuôn mặt” trước.");
    let best = null;
    for (const candidate of candidates) {
      for (const savedDescriptor of [candidate.descriptor, candidate.maskedDescriptor]) {
        if (!Array.isArray(savedDescriptor) || savedDescriptor.length !== descriptor.length) continue;
        const distance = faceapi.euclideanDistance(
          new Float32Array(descriptor),
          new Float32Array(savedDescriptor)
        );
        if (!best || distance < best.distance) best = { ...candidate, distance };
      }
    }
    if (!best || best.distance > MATCH_THRESHOLD) {
      throw new Error("Khuôn mặt chưa khớp. Nếu đang đeo khẩu trang, hãy đăng ký thêm mẫu khi đeo khẩu trang; thử lại nơi đủ sáng.");
    }
    return best;
  }
  async function capturePhoto() {
    const video = $("camera");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx || !video.videoWidth || !video.videoHeight) {
      throw new Error("Camera chưa sẵn sàng để chụp ảnh.");
    }
    const scale = Math.min(1, 640 / video.videoWidth, 640 / video.videoHeight);
    let width = Math.round(video.videoWidth * scale);
    let height = Math.round(video.videoHeight * scale);
    let blob = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = width;
      canvas.height = height;
      // Giữ ảnh đúng chiều camera, không lật để lưu bằng chứng.
      ctx.drawImage(video, 0, 0, width, height);
      for (const quality of [0.7, 0.58, 0.46, 0.34]) {
        blob = await new Promise((resolve, reject) => {
          canvas.toBlob(
            (result) => result ? resolve(result) : reject(new Error("Không nén được ảnh chấm công.")),
            "image/jpeg",
            quality
          );
        });
        if (blob.size <= MAX_PHOTO_BYTES) break;
      }
      if (blob.size <= MAX_PHOTO_BYTES) break;
      width = Math.max(240, Math.round(width * 0.8));
      height = Math.max(240, Math.round(height * 0.8));
    }
    if (!blob || blob.size > MAX_PHOTO_BYTES) {
      throw new Error("Ảnh vượt giới hạn lưu Firestore. Hãy thử lại ở khung hình gọn hơn.");
    }
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Không đọc được ảnh chấm công."));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }
  function getEmailAlertEndpoint() {
    return (window.WORKTIME_EMAIL_ALERT_URL || localStorage.getItem("worktime_email_alert_url") || "").trim();
  }
  async function requestLateAttendanceEmail(recordId, action = "notify") {
    const endpoint = getEmailAlertEndpoint();
    if (!endpoint) {
      throw new Error("Chấm công đã lưu, nhưng chưa cấu hình URL Google Apps Script để gửi email.");
    }
    const idToken = await state.user.getIdToken();
    const payload = {
      idToken,
      recordId,
      action
    };
    try {
      await withTimeout(
        fetch(endpoint, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload)
        }),
        20000,
        "Hết thời gian gửi yêu cầu Gmail. Kiểm tra Apps Script > Executions."
      );
    } catch (error) {
      throw new Error(
        "Không xác nhận được yêu cầu tới Apps Script: " +
        (error && error.message ? error.message : String(error)) +
        " Kiểm tra URL Web app, quyền truy cập Anyone và Apps Script > Executions."
      );
    }
    return { submitted: true };
  }
  async function writeAttendance() {
    setButtonBusy($("attendanceBtn"), true, "Đang xác minh...");
    try {
      const match = await identifyFace();
      setMessage("cameraMessage", "Đã nhận diện. Đang tải hồ sơ nhân viên...");
      const employeeSnap = await withTimeout(
        state.db.collection("users").doc(match.uid).get(),
        15000,
        "Hết thời gian chờ tải hồ sơ nhân viên từ Firestore."
      );
      const employee = employeeSnap.exists ? employeeSnap.data() : null;
      if (!employee) throw new Error("Không tìm thấy hồ sơ nhân viên khớp khuôn mặt.");
      const now = new Date();
      let shift = shiftInfo(now);
      let recordRef = state.db.collection("attendance").doc(`${match.uid}_${shift.key}`);
      setMessage("cameraMessage", "Đang kiểm tra ca làm việc...");
      let existingSnap = await withTimeout(
        recordRef.get(),
        15000,
        "Hết thời gian chờ kiểm tra ca làm việc trong Firestore."
      );
      let previous = existingSnap.exists ? existingSnap.data() : null;

      if (previous && previous.checkIn && previous.checkOut) {
        throw new Error("Ca này đã có giờ vào và giờ ra.");
      }
      if ((!previous || !previous.checkIn) && (now < shift.start || now >= shift.end)) {
        throw new Error("Ca hành chính chỉ nhận chấm công vào từ 08:00 đến trước 17:00.");
      }
      // Lưu ảnh nén dạng data URL cùng tài liệu Firestore; thời gian vẫn cần được xác minh phía máy chủ.
      setMessage("cameraMessage", "Đang chụp ảnh chấm công...");
      const photoDataUrl = await withTimeout(
        capturePhoto(),
        10000,
        "Chụp ảnh mất quá lâu. Hãy tắt rồi bật lại camera."
      );
      setMessage("cameraMessage", "Đang lưu ảnh và dữ liệu vào Firestore...");
      const stamp = localDateTime(now);
      if (!previous || !previous.checkIn) {
        const status = statusForCheckIn(now, shift);
        const record = {
          employeeUid: match.uid, employeeName: employee.name || "Nhân viên",
          employeeId: employee.employeeId || "", workDate: shift.workDate, shift: shift.shift,
          checkIn: stamp, checkInTimestamp: now.getTime(), status,
          checkInPhotoData: photoDataUrl, updatedAt: stamp
        };
        setMessage("cameraMessage", "Đang lưu giờ vào...");
        await withTimeout(
          recordRef.set(record),
          15000,
          "Firestore chưa xác nhận lưu giờ vào. Hãy kiểm tra lịch sử trước khi thử chấm công lại."
        );
        if (status === "Đi trễ") {
          setMessage("cameraMessage", "Đã lưu chấm công đi trễ. Đang gửi yêu cầu cảnh báo Gmail...");
          try {
            await requestLateAttendanceEmail(recordRef.id);
            toast(
              "Đã gửi yêu cầu cảnh báo Gmail. Trình duyệt không xác nhận được email đã đến; hãy kiểm tra hộp thư và Apps Script > Executions.",
              "success"
            );
          } catch (emailError) {
            console.error("Không gửi được yêu cầu cảnh báo đi trễ:", emailError);
            toast("Đã lưu chấm công đi trễ nhưng chưa gửi được yêu cầu Gmail: " + emailError.message, "error");
          }
        } else {
          toast(`Chấm công vào thành công: ${status}.`, "success");
        }
      } else {
        const record = {
          ...previous, checkOut: stamp, checkOutTimestamp: now.getTime(),
          checkOutPhotoData: photoDataUrl, updatedAt: stamp
        };
        setMessage("cameraMessage", "Đang lưu giờ ra...");
        await withTimeout(
          recordRef.set(record),
          15000,
          "Firestore chưa xác nhận lưu giờ ra. Hãy kiểm tra lịch sử trước khi thử chấm công lại."
        );
        if (previous.status === "Đi trễ") {
          try {
            await requestLateAttendanceEmail(recordRef.id, "cancelReminders");
          } catch (cancelError) {
            console.error("Không gửi được yêu cầu hủy email nhắc đi trễ:", cancelError);
            toast("Đã lưu giờ ra nhưng chưa xác nhận được yêu cầu dừng email nhắc. Kiểm tra Apps Script > Executions.", "error");
          }
        }
        toast("Đã ghi nhận giờ ra.", "success");
      }
      await loadAttendance();
      await updateFaceStatus();
      setMessage("cameraMessage", `Đã ghi nhận ${employee.name || employee.employeeId}.`, "success");
    } catch (error) {
      setMessage("cameraMessage", friendlyError(error), "error");
    } finally {
      setButtonBusy($("attendanceBtn"), false);
    }
  }
  async function loadAttendance() {
    if (!state.user || !state.profile) return;
    const date = $("filterDate").value || localDate();
    $("statDate").textContent = date;
    setMessage("historyMessage", "");
    try {
      const attendance = state.db.collection("attendance");
      const query = state.profile.role === "admin"
        ? attendance.where("workDate", "==", date)
        : attendance.where("employeeUid", "==", state.user.uid).where("workDate", "==", date);
      const snap = await withTimeout(
        query.get(),
        15000,
        "Hết thời gian chờ tải lịch sử chấm công."
      );
      const rows = snap.docs
        .map(doc => ({ uid: doc.data().employeeUid, key: doc.id, ...doc.data() }))
        .filter(record => record.workDate === date);
      rows.sort((a, b) => String(b.checkIn || "").localeCompare(String(a.checkIn || "")));
      state.records = rows;
      renderRows(rows);
      const mine = rows.find(r => r.uid === state.user.uid);
      $("statCheckIn").textContent = mine ? displayTime(mine.checkIn) : "Chưa có";
      $("statCheckInStatus").textContent = mine ? mine.status || "Đã ghi nhận" : "Chưa chấm công";
      $("statCheckOut").textContent = mine ? displayTime(mine.checkOut) : "Chưa có";
    } catch (error) {
      setMessage("historyMessage", "Không tải được lịch sử: " + friendlyError(error), "error");
    }
  }
  async function deleteAttendanceForDate() {
    if (!state.user || !state.profile || state.profile.role !== "admin") {
      setMessage("historyMessage", "Chỉ admin mới được xóa chấm công theo ngày.", "error");
      return;
    }

    const date = $("filterDate").value || localDate();
    const button = $("deleteAttendanceDateBtn");
    setButtonBusy(button, true, "Đang kiểm tra...");
    setMessage("historyMessage", "");
    try {
      const snap = await withTimeout(
        state.db.collection("attendance")
          .where("workDate", "==", date)
          .get(),
        15000,
        "Hết thời gian tải bản ghi chấm công trong ngày cần xóa."
      );
      if (snap.empty) {
        toast(`Không có dữ liệu chấm công trong ngày ${date}.`, "error");
        return;
      }

      const confirmMessage = `Xóa toàn bộ ${snap.size} bản ghi chấm công của tất cả nhân viên trong ngày ${date}? Dữ liệu đã xóa không thể khôi phục.`;
      if (!window.confirm(confirmMessage)) return;

      for (let offset = 0; offset < snap.docs.length; offset += 450) {
        const batch = state.db.batch();
        snap.docs.slice(offset, offset + 450).forEach(doc => batch.delete(doc.ref));
        await withTimeout(
          batch.commit(),
          20000,
          "Hết thời gian xóa dữ liệu chấm công. Hãy làm mới lịch sử để kiểm tra kết quả."
        );
      }

      toast(`Đã xóa ${snap.size} bản ghi chấm công của tất cả nhân viên trong ngày ${date}.`, "success");
      await loadAttendance();
    } catch (error) {
      const message = "Không xóa được chấm công ngày này: " + friendlyError(error);
      setMessage("historyMessage", message, "error");
      toast(message, "error");
    } finally {
      setButtonBusy(button, false);
    }
  }
  function renderRows(rows) {
    const tbody = $("attendanceRows");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Chưa có bản ghi trong ngày này.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const statusClass = r.status === "Đi trễ" ? "late" : "on-time";
      const checkInPhoto = r.checkInPhotoData || "";
      const checkOutPhoto = r.checkOutPhotoData || "";
      const photo = renderPhoto(checkInPhoto, "Ảnh chấm công vào");
      const checkoutPhoto = renderPhoto(checkOutPhoto, "Ảnh chấm công ra", true);
      return `<tr>
        <td><strong>${esc(r.employeeName || "Nhân viên")}</strong><br><span class="muted">${esc(r.employeeId || "")}</span></td>
        <td>${esc(r.workDate || "—")}</td><td>${esc(r.shift || "—")}</td>
        <td>${esc(displayTime(r.checkIn))}</td>
        <td><span class="tag ${statusClass}">${esc(r.status || "Đã ghi nhận")}</span></td>
        <td>${esc(displayTime(r.checkOut))}</td>
        <td>${photo}${checkoutPhoto}</td></tr>`;
    }).join("");
  }
  function isSafePhoto(value) {
    return typeof value === "string" && value.startsWith("data:image/jpeg;base64,");
  }
  function renderPhoto(value, label, withBreak = false) {
    if (!isSafePhoto(value)) return "";
    const prefix = withBreak ? "<br>" : "";
    return `${prefix}<img alt="${label}" loading="lazy" width="72" src="${esc(value)}">`;
  }
  function exportCsv() {
    if (!state.records.length) { toast("Không có dữ liệu để xuất.", "error"); return; }
    const records = state.records;
    const date = $("filterDate").value || localDate();
    const lateCount = records.filter(record => record.status === "Đi trễ").length;
    const onTimeCount = records.filter(record => record.status === "Đúng giờ").length;
    const pendingCheckOutCount = records.filter(record => record.checkIn && !record.checkOut).length;
    const formatDate = (value) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
      return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || "");
    };
    const formatTime = (value) => {
      if (!value) return "";
      const match = /T(\d{2}:\d{2}(?::\d{2})?)/.exec(String(value));
      return match ? match[1] : displayTime(value);
    };
    const formatDuration = (record) => {
      if (!record.checkInTimestamp || !record.checkOutTimestamp) return "";
      const minutes = Math.floor((record.checkOutTimestamp - record.checkInTimestamp) / 60000);
      if (!Number.isFinite(minutes) || minutes < 0) return "";
      return `${Math.floor(minutes / 60)} giờ ${String(minutes % 60).padStart(2, "0")} phút`;
    };
    const csvCell = (value) => {
      let text = String(value ?? "");
      if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = [
      ["WORKTIME", "BÁO CÁO CHẤM CÔNG"],
      ["Ngày làm việc", formatDate(date)],
      ["Ngày xuất báo cáo", `${formatDate(localDate())} ${formatTime(localDateTime())}`],
      [],
      ["TỔNG QUAN"],
      ["Tổng lượt chấm công", records.length],
      ["Đúng giờ", onTimeCount],
      ["Đi trễ", lateCount],
      ["Chưa chấm giờ ra", pendingCheckOutCount],
      [],
      ["STT", "Mã nhân viên", "Họ và tên", "Ngày làm việc", "Ca làm", "Giờ vào", "Trạng thái", "Giờ ra", "Thời lượng", "Ảnh vào", "Ảnh ra"],
      ...records.map((record, index) => [
        index + 1,
        record.employeeId,
        record.employeeName || "Nhân viên",
        formatDate(record.workDate),
        record.shift,
        formatTime(record.checkIn),
        record.status || "Đã ghi nhận",
        formatTime(record.checkOut),
        formatDuration(record),
        record.checkInPhotoData ? "Có" : "Không",
        record.checkOutPhotoData ? "Có" : "Không"
      ])
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `WorkTime_Bao-cao-cham-cong_${date}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportMonthlyReportCsv() {
    const monthValue = $("adminMonthPicker").value || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    if (!state.monthlyReport.length) {
      toast("Chưa có dữ liệu để xuất báo cáo tháng.", "error");
      return;
    }
    const rows = [
      ["WORKTIME", "BÁO CÁO THEO THÁNG"],
      ["Tháng", monthValue],
      ["Tổng lượt", state.monthlyReport.length],
      ["Đúng giờ", state.monthlyReport.filter((record) => record.status === "Đúng giờ").length],
      ["Đi trễ", state.monthlyReport.filter((record) => record.status === "Đi trễ").length],
      ["Chưa chấm giờ ra", state.monthlyReport.filter((record) => record.checkIn && !record.checkOut).length],
      [],
      ["Nhân viên", "Mã NV", "Ngày", "Ca", "Giờ vào", "Trạng thái", "Giờ ra"]
    ];
    state.monthlyReport.forEach((record) => {
      rows.push([
        record.employeeName || "Nhân viên",
        record.employeeId || "",
        record.workDate || "",
        record.shift || "",
        record.checkIn || "",
        record.status || "",
        record.checkOut || ""
      ]);
    });
    const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `WorkTime_Bao-cao-thang_${monthValue}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function bindEvents() {
    $("loginTab").addEventListener("click", () => setAuthTab("login"));
    $("registerTab").addEventListener("click", () => setAuthTab("register"));
    $("loginForm").addEventListener("submit", login);
    $("forgotPasswordBtn").addEventListener("click", forgotPassword);
    $("registerForm").addEventListener("submit", registerAccount);
    $("changePasswordBtn").addEventListener("click", changePasswordByEmail);
    $("logoutBtn").addEventListener("click", async () => { stopCamera(); await state.auth.signOut(); });
    $("startCameraBtn").addEventListener("click", startCamera);
    $("registerFaceBtn").addEventListener("click", registerFace);
    $("registerMaskedFaceBtn").addEventListener("click", registerMaskedFace);
    $("deleteFaceProfileBtn").addEventListener("click", deleteFaceProfile);
    $("attendanceBtn").addEventListener("click", writeAttendance);
    $("refreshBtn").addEventListener("click", loadAttendance);
    $("deleteAttendanceDateBtn").addEventListener("click", deleteAttendanceForDate);
    $("filterDate").addEventListener("change", loadAttendance);
    $("exportBtn").addEventListener("click", exportCsv);
    $("adminMemberSearch").addEventListener("input", () => renderAdminMembers(state.members));
    $("adminMemberRoleFilter").addEventListener("change", () => renderAdminMembers(state.members));
    $("adminEmployeeDate").value = localDate();
    $("adminEmployeeSelect").addEventListener("change", loadAdminMemberHistory);
    $("adminViewMemberHistoryBtn").addEventListener("click", loadAdminMemberHistory);
    $("adminDeleteMemberAttendanceBtn").addEventListener("click", deleteMemberAttendanceForDate);
    $("adminReloadReportBtn").addEventListener("click", loadMonthlyReport);
    $("adminMonthPicker").addEventListener("change", loadMonthlyReport);
    $("adminExportMonthBtn").addEventListener("click", exportMonthlyReportCsv);
    $("adminSaveSettingsBtn").addEventListener("click", saveAdminSettings);
    $("adminDrawerOverlay").addEventListener("click", () => setAdminDrawer(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setAdminDrawer(false);
    });
    document.querySelectorAll(".admin-tab").forEach((button) => {
      button.addEventListener("click", () => setAdminTab(button.dataset.adminTab));
    });
    $("adminMembersTableBody").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action='toggle-role']");
      if (!button) return;
      const uid = button.dataset.uid;
      const role = button.dataset.role;
      const nextRole = role === "admin" ? "employee" : "admin";
      await updateMemberRole(uid, nextRole);
    });
    window.addEventListener("beforeunload", stopCamera);
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("camera").classList.add("hidden");
    bindEvents();
    initFirebase();
  });
})();
