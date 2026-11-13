"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    auth: null, db: null, legacyDb: null, user: null, profile: null,
    stream: null, modelsReady: false, faceTimer: null, records: [], members: [], monthlyReport: [], payrollRows: [], payrollDirty: false, toastTimer: null,
    biometricConsentConfirmed: false, registrationInProgress: false,
    attendanceNameSort: "asc",
    demoDepartments: [],
    demoEmployeeData: {},
    demoShifts: [
      { id: "demo-office", name: "Ca hành chính", start: "08:00", end: "17:00", graceMinutes: 5, days: ["T2", "T3", "T4", "T5", "T6"], employeeUids: [] },
      { id: "demo-saturday", name: "Ca thứ Bảy", start: "08:00", end: "12:00", graceMinutes: 5, days: ["T7"], employeeUids: [] }
    ],
    demoRequests: []
  };
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
  const MATCH_THRESHOLD = 0.48; // Cần hiệu chỉnh bằng dữ liệu thật; không phải bảo đảm chống giả mạo.
  const FACE_DETECTION_OPTIONS = { minConfidence: 0.55, inputSize: 320, maxResults: 1 };
  const MIN_PASSWORD_LENGTH = 12;
  const MAX_PHOTO_BYTES = 180 * 1024;
  const MAX_PROFILE_PHOTO_CHARS = 180000;
  const MAX_PAYROLL_AMOUNT_VND = 1000000000000;
  const BIOMETRIC_NOTICE_VERSION = "2026-11-v1";

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
  function shiftInfo(now = new Date()) {
    const workDate = localDate(now);
    const start = new Date(now); start.setHours(8, 0, 0, 0);
    const dayOfWeek = now.getDay();
    const isWorkday = dayOfWeek !== 0;
    const end = new Date(now);
    end.setHours(dayOfWeek === 6 ? 12 : 17, 0, 0, 0);
    return { key: `${workDate}_day`, workDate, shift: "Ca hành chính", start, end, isWorkday };
  }
  function statusForCheckIn(now, shift) {
    const lateAt = new Date(shift.start.getTime() + 5 * 60000);
    return now > lateAt ? "Đi trễ" : "Đúng giờ";
  }
  function displayTime(value) {
    if (!value) return "—";
    const d = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function sortAttendanceRows(rows) {
    const direction = state.attendanceNameSort === "desc" ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const byName = String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "vi");
      return direction * byName ||
        String(a.employeeId || "").localeCompare(String(b.employeeId || ""), "vi") ||
        String(a.uid || "").localeCompare(String(b.uid || "")) ||
        String(a.workDate || "").localeCompare(String(b.workDate || "")) ||
        String(a.checkIn || "").localeCompare(String(b.checkIn || ""));
    });
  }
  function updateAttendanceSortButton() {
    const button = $("sortAttendanceByNameBtn");
    if (!button) return;
    const ascending = state.attendanceNameSort === "asc";
    button.textContent = ascending ? "Tên A–Z" : "Tên Z–A";
    button.setAttribute("aria-label", `Đổi thứ tự tên, hiện ${ascending ? "A đến Z" : "Z đến A"}`);
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
    const [userSnap, faceSnap] = await Promise.all([
      withTimeout(state.legacyDb.ref(`users/${uid}`).once("value"), 15000, "Hết thời gian đọc hồ sơ cũ."),
      withTimeout(state.legacyDb.ref(`faceProfiles/${uid}`).once("value"), 15000, "Hết thời gian đọc hồ sơ khuôn mặt cũ.")
    ]);
    const profile = userSnap.val() || fallbackProfile;
    if (profile.role === "admin") {
      profile.role = "employee";
      console.warn("Vai trò quản trị cũ cần được cấp lại trong Firestore.");
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
  async function migrateLegacyAttendance() {
    if (!state.legacyDb || state.profile.legacyAttendanceMigratedAt) return;
    const legacySnapshot = await withTimeout(
      state.legacyDb.ref(`attendance/${state.user.uid}`).once("value"),
      15000,
      "Hết thời gian đọc lịch sử chấm công cũ."
    );
    const entries = Object.entries(legacySnapshot.val() || {})
      .filter(([, record]) => record && typeof record === "object");
    let importedCount = 0;
    for (let offset = 0; offset < entries.length; offset += 400) {
      const batch = state.db.batch();
      const chunk = entries.slice(offset, offset + 400)
        .filter(([, record]) => /^\d{4}-\d{2}-\d{2}$/.test(String(record.workDate || "")));
      const refs = chunk.map(([key]) =>
        state.db.collection("attendance").doc(`${state.user.uid}_${key}`)
      );
      const existing = await Promise.all(refs.map((ref) => ref.get()));
      let chunkImported = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (existing[index].exists) continue;
        const record = chunk[index][1];
        const imported = {
          employeeUid: state.user.uid,
          employeeName: String(record.employeeName || state.profile.name || "Nhân viên").slice(0, 100),
          employeeId: String(record.employeeId || state.profile.employeeId || "").slice(0, 40),
          workDate: record.workDate,
          shift: String(record.shift || "Ca cũ").slice(0, 40),
          checkIn: String(record.checkIn || ""),
          checkInTimestamp: Number.isFinite(record.checkInTimestamp) ? record.checkInTimestamp : 0,
          checkInServerTimestamp: firebase.firestore.FieldValue.serverTimestamp(),
          status: String(record.status || "Đã ghi nhận").slice(0, 40),
          checkInPhotoData: typeof record.checkInPhotoData === "string" && record.checkInPhotoData.length <= 250000
            ? record.checkInPhotoData : "",
          updatedAt: localDateTime(),
          migratedFromLegacy: true
        };
        if (record.checkOut) {
          imported.checkOut = String(record.checkOut);
          imported.checkOutTimestamp = Number.isFinite(record.checkOutTimestamp) ? record.checkOutTimestamp : 0;
          imported.checkOutServerTimestamp = firebase.firestore.FieldValue.serverTimestamp();
          imported.checkOutPhotoData = typeof record.checkOutPhotoData === "string" && record.checkOutPhotoData.length <= 250000
            ? record.checkOutPhotoData : "";
        }
        batch.set(refs[index], imported);
        importedCount += 1;
        chunkImported += 1;
      }
      if (chunkImported) {
        await withTimeout(batch.commit(), 20000, "Hết thời gian chuyển lịch sử chấm công cũ.");
      }
    }
    await withTimeout(
      state.db.collection("users").doc(state.user.uid).set({
        legacyAttendanceMigratedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }),
      15000,
      "Hết thời gian đánh dấu lịch sử cũ đã chuyển."
    );
    state.profile.legacyAttendanceMigratedAt = true;
    if (importedCount) {
      toast(`Đã chuyển ${importedCount} bản ghi lịch sử cũ. Dữ liệu cũ không được xác minh; không dùng làm căn cứ trả lương.`, "success");
      await loadAttendance();
    }
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
          state.biometricConsentConfirmed = false;
          stopCamera();
          $("authView").classList.remove("hidden");
          $("appView").classList.add("hidden");
          $("userBadge").classList.add("hidden");
          $("accountSettingsToggle").classList.add("hidden");
          $("accountSettingsMenu").classList.add("hidden");
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
          const isGoogleUser = (user.providerData || []).some((provider) => provider.providerId === "google.com");
          if (!profile && isGoogleUser && state.legacyDb) {
            const legacyUserSnap = await withTimeout(
              state.legacyDb.ref(`users/${user.uid}`).once("value"),
              15000,
              "Hết thời gian kiểm tra hồ sơ Google trong Realtime Database cũ."
            );
            if (legacyUserSnap.exists()) {
              const fallbackProfile = {
                name: user.displayName || user.email.split("@")[0],
                employeeId: "NV-" + user.uid.slice(0, 6).toUpperCase(),
                email: user.email || "", role: "employee", createdAt: localDateTime()
              };
              profile = await importLegacyAccount(user.uid, fallbackProfile);
            }
          }
          if (!profile && isGoogleUser) {
            await state.auth.signOut();
            setMessage("authMessage", "Tài khoản Google chưa có hồ sơ WorkTime. Hãy đăng nhập tài khoản WorkTime hiện có rồi liên kết Google trong hồ sơ.", "error");
            return;
          }
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
          if (state.legacyDb && !state.profile.legacyAttendanceMigratedAt) {
            try {
              await migrateLegacyAttendance();
            } catch (error) {
              toast("Chưa chuyển được lịch sử cũ: " + friendlyError(error), "error");
              console.error("Không chuyển được lịch sử chấm công cũ:", error);
            }
          }
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
  function renderProfileAvatar() {
    const initials = $("avatarInitials");
    const image = $("avatarImage");
    if (!initials || !image || !state.profile) return;
    initials.textContent = (state.profile.name || "NV").split(/\s+/).slice(-2).map((part) => part[0]).join("").toUpperCase();
    const photo = state.profile.photoData || state.profile.googlePhotoURL || (state.user && state.user.photoURL) || "";
    if (!photo) {
      image.classList.add("hidden");
      image.removeAttribute("src");
      initials.classList.remove("hidden");
      return;
    }
    image.onerror = () => {
      image.classList.add("hidden");
      initials.classList.remove("hidden");
    };
    image.src = photo;
    image.classList.remove("hidden");
    initials.classList.add("hidden");
  }
  async function showApp() {
    $("authView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("dashboardPage").classList.remove("hidden");
    $("employeeProfilePage").classList.add("hidden");
    $("userBadge").classList.remove("hidden");
    $("accountSettingsToggle").classList.remove("hidden");
    $("userBadge").textContent = state.profile.name || state.user.email;
    $("welcomeTitle").textContent = `Xin chào, ${state.profile.name || "bạn"}!`;
    $("welcomeSub").textContent = state.profile.role === "admin"
      ? "Chế độ quản trị · xem dữ liệu chấm công toàn bộ nhân viên."
      : "Đây là bảng điều khiển chấm công của bạn.";
    $("profileName").textContent = state.profile.name || "—";
    $("profileEmployeeId").textContent = state.profile.employeeId || "—";
    $("profileEmail").textContent = state.profile.email || state.user.email || "—";
    $("profileRole").textContent = state.profile.role === "admin" ? "Quản trị viên" : "Nhân viên";
    $("menuProfileName").textContent = state.profile.name || "—";
    $("menuProfileEmployeeId").textContent = state.profile.employeeId || "—";
    $("menuProfileEmail").textContent = state.profile.email || state.user.email || "—";
    $("menuProfileRole").textContent = state.profile.role === "admin" ? "Quản trị viên" : "Nhân viên";
    renderProfileAvatar();
    const googleLinked = (state.user.providerData || []).some((provider) => provider.providerId === "google.com");
    $("linkGoogleBtn").textContent = googleLinked ? "Google đã liên kết" : "Liên kết Google";
    $("linkGoogleBtn").disabled = googleLinked;
    $("adminNote").classList.toggle("hidden", state.profile.role !== "admin");
    $("employeeRequestsPanel").classList.toggle("hidden", state.profile.role === "admin");
    $("deleteAttendanceDateBtn").classList.toggle("hidden", state.profile.role !== "admin");
    $("sortAttendanceByNameBtn").classList.toggle("hidden", state.profile.role !== "admin");
    $("showAllAttendanceBtn").classList.remove("hidden");
    $("adminPanel").classList.toggle("hidden", state.profile.role !== "admin");
    $("adminDashboardToggle").classList.toggle("hidden", state.profile.role !== "admin");
    $("filterDate").value = localDate();
    $("adminEmployeeDate").value = localDate();
    $("adminMonthPicker").value = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    $("payrollMonthPicker").value = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    $("statDate").textContent = localDate();
    updateAttendanceSortButton();
    $("requestStartDate").value = localDate();
    $("requestEndDate").value = localDate();
    updateEmployeeRequestForm();
    updateAdminButtonState();
    if (state.profile.role === "admin") {
      setAdminDrawer(false);
      setAdminTab("overview");
      renderAdminSettings();
    }
    await loadBiometricConsent();
    await updateFaceStatus();
    if (state.profile.role === "admin") {
      await loadMembers();
      await loadMonthlyReport();
      renderDemoShifts();
      renderDemoRequests();
    } else {
      state.members = [];
      renderAdminMembers([]);
    }
    renderDemoRequests();
    await loadAttendance();
  }
  function renderDemoDepartments() {
    const list = $("departmentList");
    const employeeFilter = $("adminMemberDepartmentFilter");
    const reportFilter = $("reportDepartmentFilter");
    if (!list || !employeeFilter || !reportFilter) return;
    const employeeDepartment = employeeFilter.value;
    const reportDepartment = reportFilter.value;
    const options = state.demoDepartments.map((department) =>
      `<option value="${esc(department)}">${esc(department)}</option>`
    ).join("");
    employeeFilter.innerHTML = `<option value="all">Tất cả</option>${options}`;
    reportFilter.innerHTML = `<option value="all">Tất cả phòng ban</option>${options}`;
    if (state.demoDepartments.includes(employeeDepartment)) employeeFilter.value = employeeDepartment;
    if (state.demoDepartments.includes(reportDepartment)) reportFilter.value = reportDepartment;
    list.innerHTML = state.demoDepartments.length
      ? state.demoDepartments.map((department) => {
        const assignedCount = Object.values(state.demoEmployeeData)
          .filter((metadata) => metadata.department === department).length;
        return `<span class="department-chip">${esc(department)}<small>${assignedCount} nhân viên</small>
          <button type="button" aria-label="Xóa phòng ban ${esc(department)}" data-action="delete-department" data-department="${esc(department)}">×</button></span>`;
      }).join("")
      : '<span class="muted">Chưa tạo phòng ban.</span>';
  }
  function addDemoDepartment(event) {
    event.preventDefault();
    if (!state.profile || state.profile.role !== "admin") return;
    const input = $("departmentName");
    const name = input.value.trim();
    if (!name) return;
    if (state.demoDepartments.some((department) => department.toLocaleLowerCase("vi") === name.toLocaleLowerCase("vi"))) {
      toast("Phòng ban này đã có trong bản xem trước.", "error");
      return;
    }
    state.demoDepartments.push(name);
    input.value = "";
    renderDemoDepartments();
    renderAdminMembers(state.members);
    toast("Đã thêm phòng ban vào bản xem trước trong phiên này; chưa lưu lên máy chủ.", "success");
  }
  function deleteDemoDepartment(name) {
    if (!state.profile || state.profile.role !== "admin" || !name) return;
    const assigned = Object.values(state.demoEmployeeData)
      .some((metadata) => metadata.department === name);
    if (assigned) {
      toast("Không thể xóa phòng ban đang được gán. Hãy chuyển nhân viên sang phòng ban khác trước.", "error");
      return;
    }
    state.demoDepartments = state.demoDepartments.filter((department) => department !== name);
    renderDemoDepartments();
    renderAdminMembers(state.members);
    renderMonthlyReport(state.monthlyReport, $("adminMonthPicker").value);
    toast("Đã xóa phòng ban khỏi bản xem trước trong phiên này; chưa lưu lên máy chủ.", "success");
  }
  function saveDemoEmployeeProfile(button) {
    if (!state.profile || state.profile.role !== "admin") return;
    const row = button.closest("tr[data-member-uid]");
    if (!row) return;
    const uid = row.dataset.memberUid;
    const department = row.querySelector("[data-member-field='department']").value;
    const status = row.querySelector("[data-member-field='status']").value;
    if (department && !state.demoDepartments.includes(department)) {
      toast("Phòng ban không còn tồn tại. Hãy chọn lại trước khi lưu.", "error");
      return;
    }
    state.demoEmployeeData[uid] = { department, status };
    renderDemoDepartments();
    renderAdminMembers(state.members);
    renderMonthlyReport(state.monthlyReport, $("adminMonthPicker").value);
    toast("Đã lưu hồ sơ xem trước trong phiên này; trạng thái chưa ảnh hưởng quyền đăng nhập.", "success");
  }
  function renderAdminMembers(rows) {
    const tbody = $("adminMembersTableBody");
    if (!tbody) return;
    const search = ($("adminMemberSearch").value || "").trim().toLowerCase();
    const roleFilter = ($("adminMemberRoleFilter").value || "all");
    const departmentFilter = $("adminMemberDepartmentFilter").value || "all";
    const statusFilter = $("adminMemberStatusFilter").value || "all";
    const filtered = rows.filter((member) => {
      const matchRole = roleFilter === "all" || member.role === roleFilter;
      const haystack = `${member.name} ${member.employeeId} ${member.email}`.toLowerCase();
      const matchSearch = !search || haystack.includes(search);
      const metadata = state.demoEmployeeData[member.uid] || { department: "", status: "active" };
      const matchDepartment = departmentFilter === "all" || metadata.department === departmentFilter;
      const matchStatus = statusFilter === "all" || metadata.status === statusFilter;
      return matchRole && matchSearch && matchDepartment && matchStatus;
    });
    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">Không tìm thấy thành viên phù hợp.</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map((member) => {
      const isSelf = state.user && member.uid === state.user.uid;
      const metadata = state.demoEmployeeData[member.uid] || { department: "", status: "active" };
      const roleLabel = member.role === "admin" ? "Quản trị viên" : "Nhân viên";
      const roleButton = isSelf
        ? '<span class="member-self-tag">Bạn</span>'
        : `<button type="button" class="btn mini ${member.role === "admin" ? "secondary" : "primary"}" data-action="toggle-role" data-uid="${esc(member.uid)}" data-role="${member.role}">${member.role === "admin" ? "Gỡ quyền admin" : "Cấp quyền admin"}</button>`;
      const departmentOptions = `<option value="">Chưa phân công</option>${state.demoDepartments.map((department) =>
        `<option value="${esc(department)}" ${metadata.department === department ? "selected" : ""}>${esc(department)}</option>`
      ).join("")}`;
      const faceButton = member.hasFace
        ? `<button type="button" class="btn mini outline" data-action="delete-face-profile" data-uid="${esc(member.uid)}" data-name="${esc(member.name || member.employeeId || "nhân viên")}">Hủy khuôn mặt</button>`
        : "";
      return `<tr data-member-uid="${esc(member.uid)}">
        <td><strong>${esc(member.name || "Không rõ")}</strong></td>
        <td>${esc(member.employeeId || "—")}</td>
        <td>${esc(member.email || "—")}</td>
        <td><span class="tag ${member.role === "admin" ? "admin-role" : "employee-role"}">${esc(roleLabel)}</span></td>
        <td><select class="admin-filter member-edit-select" data-member-field="department" aria-label="Phòng ban của ${esc(member.name)}">${departmentOptions}</select></td>
        <td><select class="admin-filter member-edit-select" data-member-field="status" aria-label="Tình trạng của ${esc(member.name)}">
          <option value="active" ${metadata.status === "active" ? "selected" : ""}>Đang làm</option>
          <option value="inactive" ${metadata.status === "inactive" ? "selected" : ""}>Tạm ngưng</option>
        </select></td>
        <td>${esc(member.faceStatus || "Chưa đăng ký")}</td>
        <td class="member-actions"><button type="button" class="btn mini secondary" data-action="save-member-preview" data-uid="${esc(member.uid)}">Lưu hồ sơ</button>${roleButton}${faceButton}</td>
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
  function renderDemoShifts() {
    const tbody = $("shiftRows");
    const employeeSelect = $("shiftEmployeeSelect");
    if (!tbody || !employeeSelect) return;
    const selectedUid = employeeSelect.value;
    const employees = state.members.filter((member) => member.role === "employee");
    employeeSelect.innerHTML = `<option value="">Chưa gán</option>${employees.map((member) =>
      `<option value="${esc(member.uid)}">${esc(member.name || member.employeeId || member.email)}</option>`
    ).join("")}`;
    if (employees.some((member) => member.uid === selectedUid)) employeeSelect.value = selectedUid;
    tbody.innerHTML = state.demoShifts.length
      ? state.demoShifts.map((shift) => {
        const assigned = shift.employeeUids.map((uid) => {
          const member = employees.find((item) => item.uid === uid);
          return member ? member.name : "";
        }).filter(Boolean);
        return `<tr>
          <td><strong>${esc(shift.name)}</strong></td>
          <td>${esc(shift.start)}–${esc(shift.end)}</td>
          <td>${esc(shift.days.join(", "))}</td>
          <td>${shift.graceMinutes} phút</td>
          <td>${assigned.length ? esc(assigned.join(", ")) : "Chưa gán"}</td>
          <td><button class="btn mini outline" type="button" data-action="delete-demo-shift" data-id="${esc(shift.id)}">Xóa</button></td>
        </tr>`;
      }).join("")
      : '<tr><td colspan="6" class="empty">Chưa có ca làm trong bản xem trước.</td></tr>';
  }
  function submitDemoShift(event) {
    event.preventDefault();
    if (!state.profile || state.profile.role !== "admin") return;
    const name = $("shiftName").value.trim();
    const start = $("shiftStart").value;
    const end = $("shiftEnd").value;
    const graceMinutes = Number($("shiftGrace").value);
    const days = Array.from(document.querySelectorAll("input[name='shiftDay']:checked"))
      .map((input) => input.value);
    if (!name || !start || !end || start >= end || !Number.isInteger(graceMinutes) ||
        graceMinutes < 0 || graceMinutes > 180 || !days.length) {
      toast("Kiểm tra tên ca, giờ bắt đầu/kết thúc, thời gian cho phép trễ và ít nhất một ngày áp dụng.", "error");
      return;
    }
    const employeeUid = $("shiftEmployeeSelect").value;
    state.demoShifts.push({
      id: `demo-${Date.now()}`,
      name,
      start,
      end,
      graceMinutes,
      days,
      employeeUids: employeeUid ? [employeeUid] : []
    });
    $("shiftForm").reset();
    $("shiftStart").value = "08:00";
    $("shiftEnd").value = "17:00";
    $("shiftGrace").value = "5";
    document.querySelectorAll("input[name='shiftDay']").forEach((input) => {
      input.checked = ["T2", "T3", "T4", "T5", "T6"].includes(input.value);
    });
    renderDemoShifts();
    toast("Đã thêm ca vào bản xem trước trong phiên này; chưa lưu lên máy chủ.", "success");
  }
  function requestTypeLabel(type) {
    return type === "leave" ? "Nghỉ phép" : "Sửa chấm công";
  }
  function requestStatusLabel(status) {
    return status === "approved" ? "Đã duyệt" : status === "rejected" ? "Từ chối" : "Chờ duyệt";
  }
  function filteredMonthlyRecords(records) {
    const employeeSelect = $("reportEmployeeFilter");
    const departmentSelect = $("reportDepartmentFilter");
    const shiftSelect = $("reportShiftFilter");
    const selectedEmployee = employeeSelect ? employeeSelect.value : "all";
    const selectedDepartment = departmentSelect ? departmentSelect.value : "all";
    const selectedShift = shiftSelect ? shiftSelect.value : "all";
    return records.filter((record) =>
      (selectedEmployee === "all" || record.employeeUid === selectedEmployee) &&
      (selectedDepartment === "all" ||
        (state.demoEmployeeData[record.employeeUid] || {}).department === selectedDepartment) &&
      (selectedShift === "all" || record.shift === selectedShift)
    );
  }
  function renderDemoRequests() {
    const adminRows = $("adminRequestRows");
    const employeeRows = $("employeeRequestRows");
    const typeFilter = $("requestTypeFilter") ? $("requestTypeFilter").value : "all";
    const statusFilter = $("requestStatusFilter") ? $("requestStatusFilter").value : "all";
    const visibleRequests = state.demoRequests.filter((request) =>
      (typeFilter === "all" || request.type === typeFilter) &&
      (statusFilter === "all" || request.status === statusFilter)
    ).slice().reverse();
    if (adminRows) {
      adminRows.innerHTML = visibleRequests.length
        ? visibleRequests.map((request) => {
          const dates = request.type === "leave" && request.endDate !== request.startDate
            ? `${request.startDate} – ${request.endDate}` : request.startDate;
          const action = request.status === "pending"
            ? `<button class="btn mini primary" type="button" data-action="review-request" data-id="${esc(request.id)}" data-status="approved">Duyệt</button>
               <button class="btn mini outline" type="button" data-action="review-request" data-id="${esc(request.id)}" data-status="rejected">Từ chối</button>`
            : "—";
          return `<tr>
            <td>${esc(request.employeeName)}</td>
            <td>${requestTypeLabel(request.type)}</td>
            <td>${esc(dates)}</td>
            <td>${esc(request.details)}</td>
            <td><span class="request-status ${esc(request.status)}">${requestStatusLabel(request.status)}</span></td>
            <td class="member-actions">${action}</td>
          </tr>`;
        }).join("")
        : '<tr><td colspan="6" class="empty">Không có yêu cầu phù hợp trong phiên này.</td></tr>';
    }
    if (employeeRows) {
      const mine = state.demoRequests.filter((request) => state.user && request.employeeUid === state.user.uid).slice().reverse();
      employeeRows.innerHTML = mine.length
        ? mine.map((request) => {
          const dates = request.type === "leave" && request.endDate !== request.startDate
            ? `${request.startDate} – ${request.endDate}` : request.startDate;
          return `<tr>
            <td>${requestTypeLabel(request.type)}</td>
            <td>${esc(dates)}</td>
            <td>${esc(request.details)}</td>
            <td><span class="request-status ${esc(request.status)}">${requestStatusLabel(request.status)}</span></td>
          </tr>`;
        }).join("")
        : '<tr><td colspan="4" class="empty">Bạn chưa tạo yêu cầu nào trong phiên này.</td></tr>';
    }
  }
  function updateEmployeeRequestForm() {
    const isLeave = $("employeeRequestType").value === "leave";
    $("requestEndDateWrap").classList.toggle("hidden", !isLeave);
    $("requestEndDate").required = isLeave;
    $("requestTimeWrap").classList.toggle("hidden", isLeave);
    $("requestTime").required = false;
    $("requestStartDateLabel").textContent = isLeave ? "Ngày bắt đầu nghỉ" : "Ngày cần sửa";
  }
  function submitDemoRequest(event) {
    event.preventDefault();
    if (!state.user || !state.profile || state.profile.role === "admin") return;
    const type = $("employeeRequestType").value;
    const startDate = $("requestStartDate").value;
    const endDate = type === "leave" ? $("requestEndDate").value : startDate;
    const reason = $("requestReason").value.trim();
    const requestedTime = $("requestTime").value;
    if (!startDate || !endDate || endDate < startDate || !reason ||
        (type === "correction" && !requestedTime)) {
      toast("Hãy kiểm tra ngày, giờ đề nghị và lý do trước khi gửi.", "error");
      return;
    }
    const details = type === "correction"
      ? `Giờ đề nghị: ${requestedTime}. ${reason}`
      : reason;
    state.demoRequests.push({
      id: `request-${Date.now()}`,
      employeeUid: state.user.uid,
      employeeName: state.profile.name || state.user.email || "Nhân viên",
      type,
      startDate,
      endDate,
      details,
      status: "pending"
    });
    $("employeeRequestForm").reset();
    $("requestStartDate").value = localDate();
    $("requestEndDate").value = localDate();
    updateEmployeeRequestForm();
    renderDemoRequests();
    toast("Đã tạo yêu cầu xem trước trong phiên này; chưa gửi đến quản lý hoặc máy chủ.", "success");
  }
  function reviewDemoRequest(id, status) {
    if (!state.profile || state.profile.role !== "admin" ||
        !["approved", "rejected"].includes(status)) return;
    const request = state.demoRequests.find((item) => item.id === id);
    if (!request || request.status !== "pending") return;
    request.status = status;
    renderDemoRequests();
    toast(`Đã đổi trạng thái xem trước thành “${requestStatusLabel(status)}”; chưa lưu lên máy chủ.`, "success");
  }
  function renderMonthlyReport(records, monthValue) {
    const chart = $("monthlyChart");
    const monthRows = $("monthlyEmployeeRows");
    if (!chart || !monthRows) return;

    records = filteredMonthlyRecords(records);
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
  function populateReportEmployeeFilter(rows) {
    const select = $("reportEmployeeFilter");
    const selected = select.value;
    select.innerHTML = `<option value="all">Tất cả nhân viên</option>${rows
      .filter((member) => member.role === "employee")
      .map((member) => `<option value="${esc(member.uid)}">${esc(member.name || member.employeeId || member.email)}</option>`)
      .join("")}`;
    if (rows.some((member) => member.uid === selected)) select.value = selected;
  }
  function populateReportShiftFilter(records) {
    const select = $("reportShiftFilter");
    const selected = select.value;
    const shifts = Array.from(new Set(records.map((record) => record.shift).filter(Boolean))).sort();
    select.innerHTML = `<option value="all">Tất cả ca</option>${shifts.map((shift) =>
      `<option value="${esc(shift)}">${esc(shift)}</option>`
    ).join("")}`;
    if (shifts.includes(selected)) select.value = selected;
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
      populateReportShiftFilter(records);
      renderMonthlyReport(records, monthValue);
    } catch (error) {
      setMessage("historyMessage", "Không tải được báo cáo tháng: " + friendlyError(error), "error");
    }
  }
  function payrollCurrency(value) {
    return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value)} ₫`;
  }
  function scheduledWorkdays(monthValue) {
    const [year, month] = monthValue.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    let workdays = 0;
    for (let day = 1; day <= daysInMonth; day += 1) {
      const weekday = new Date(year, month - 1, day).getDay();
      if (weekday !== 0) workdays += weekday === 6 ? 0.5 : 1;
    }
    return workdays;
  }
  function calculatePayrollNet(row, inputs = null) {
    const baseSalary = inputs ? Number(inputs.baseSalary.value) : row.baseSalaryVnd;
    const expectedWorkdays = inputs ? Number(inputs.expectedWorkdays.value) : row.expectedWorkdays;
    const allowance = inputs ? Number(inputs.allowance.value) : row.allowanceVnd;
    const deduction = inputs ? Number(inputs.deduction.value) : row.deductionVnd;
    if (![baseSalary, allowance, deduction].every(Number.isSafeInteger) ||
        !Number.isFinite(expectedWorkdays) || !Number.isInteger(expectedWorkdays * 2) ||
        baseSalary < 0 || baseSalary > MAX_PAYROLL_AMOUNT_VND ||
        expectedWorkdays < 0.5 || expectedWorkdays > 31 ||
        allowance < 0 || allowance > MAX_PAYROLL_AMOUNT_VND ||
        deduction < 0 || deduction > MAX_PAYROLL_AMOUNT_VND) return null;
    const proratedSalary = Math.round(baseSalary * Math.min(row.workdays, expectedWorkdays) / expectedWorkdays);
    return Math.max(0, proratedSalary + allowance - deduction);
  }
  function payrollInputValues(rowElement) {
    return {
      baseSalary: rowElement.querySelector("[data-payroll-field='baseSalary']"),
      expectedWorkdays: rowElement.querySelector("[data-payroll-field='expectedWorkdays']"),
      allowance: rowElement.querySelector("[data-payroll-field='allowance']"),
      deduction: rowElement.querySelector("[data-payroll-field='deduction']")
    };
  }
  function updatePayrollTotals() {
    const totalWorkdays = state.payrollRows.reduce((sum, row) => sum + row.workdays, 0);
    const invalidCount = state.payrollRows.filter((row) => row.netPayVnd === null).length;
    const totalNet = state.payrollRows.reduce((sum, row) => sum + (row.netPayVnd || 0), 0);
    $("payrollEmployeeCount").textContent = String(state.payrollRows.length);
    $("payrollWorkdayCount").textContent = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(totalWorkdays);
    $("payrollNetTotal").textContent = state.payrollDirty
      ? "Chưa tính lại"
      : invalidCount ? "Kiểm tra dữ liệu" : payrollCurrency(totalNet);
  }
  function renderPayrollReport() {
    const tbody = $("payrollRows");
    if (!state.payrollRows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">Không có hồ sơ nhân viên trong hệ thống.</td></tr>';
      updatePayrollTotals();
      return;
    }
    tbody.innerHTML = state.payrollRows.map((row) => `
      <tr data-payroll-uid="${esc(row.employeeUid)}">
        <td><strong>${esc(row.employeeName)}</strong><br><span class="muted">${esc(row.employeeId)}</span></td>
        <td>${row.workdays}</td>
        <td><input class="admin-filter" type="number" min="0" step="1" data-payroll-field="baseSalary" value="${row.baseSalaryVnd}" aria-label="Lương cơ bản ${esc(row.employeeName)}"></td>
        <td><input class="admin-filter" type="number" min="0.5" max="31" step="0.5" data-payroll-field="expectedWorkdays" value="${row.expectedWorkdays}" aria-label="Ngày công chuẩn ${esc(row.employeeName)}"></td>
        <td><input class="admin-filter" type="number" min="0" step="1" data-payroll-field="allowance" value="${row.allowanceVnd}" aria-label="Phụ cấp ${esc(row.employeeName)}"></td>
        <td><input class="admin-filter" type="number" min="0" step="1" data-payroll-field="deduction" value="${row.deductionVnd}" aria-label="Khấu trừ ${esc(row.employeeName)}"></td>
        <td class="payroll-net">${row.netPayVnd === null ? "Kiểm tra dữ liệu" : payrollCurrency(row.netPayVnd)}</td>
        <td><button class="btn mini outline" type="button" data-action="save-payroll">Lưu</button></td>
      </tr>
    `).join("");
    updatePayrollTotals();
  }
  async function loadPayrollReport() {
    if (!state.user || !state.profile || state.profile.role !== "admin") return;
    const monthValue = $("payrollMonthPicker").value || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    state.payrollDirty = true;
    state.payrollRows = [];
    $("payrollRows").innerHTML = '<tr><td colspan="8" class="empty">Đang tải dữ liệu chấm công và cấu hình lương...</td></tr>';
    updatePayrollTotals();
    try {
      const [year, month] = monthValue.split("-").map(Number);
      const start = `${year}-${pad(month)}-01`;
      const end = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
      const [attendanceSnapshot, settingsSnapshot] = await Promise.all([
        withTimeout(
          state.db.collection("attendance").where("workDate", ">=", start).where("workDate", "<=", end).get(),
          15000,
          "Hết thời gian tải chấm công để tính lương."
        ),
        withTimeout(
          state.db.collection("payrollSettings").where("month", "==", monthValue).get(),
          15000,
          "Hết thời gian tải cấu hình lương."
        )
      ]);
      const settings = new Map(settingsSnapshot.docs.map((document) => [document.data().employeeUid, document.data()]));
      const workdaysByEmployee = new Map();
      attendanceSnapshot.docs.forEach((document) => {
        const record = document.data();
        if (!record.employeeUid || !record.workDate || !record.checkIn) return;
        const days = workdaysByEmployee.get(record.employeeUid) || new Map();
        const weekday = new Date(`${record.workDate}T00:00:00Z`).getUTCDay();
        days.set(record.workDate, weekday === 6 ? 0.5 : 1);
        workdaysByEmployee.set(record.employeeUid, days);
      });
      const defaultWorkdays = scheduledWorkdays(monthValue);
      state.payrollRows = state.members.map((member) => {
        const saved = settings.get(member.uid) || {};
        const row = {
          employeeUid: member.uid,
          employeeName: member.name || "Nhân viên",
          employeeId: member.employeeId || "",
          workdays: Array.from((workdaysByEmployee.get(member.uid) || new Map()).values())
            .reduce((sum, value) => sum + value, 0),
          baseSalaryVnd: Number(saved.baseSalaryVnd) || 0,
          expectedWorkdays: Number(saved.expectedWorkdays) || defaultWorkdays,
          allowanceVnd: Number(saved.allowanceVnd) || 0,
          deductionVnd: Number(saved.deductionVnd) || 0,
          month: monthValue
        };
        row.netPayVnd = calculatePayrollNet(row);
        return row;
      });
      state.payrollDirty = false;
      renderPayrollReport();
      return true;
    } catch (error) {
      state.payrollDirty = true;
      $("payrollRows").innerHTML = `<tr><td colspan="8" class="empty">Không tải được bảng lương: ${esc(friendlyError(error))}</td></tr>`;
      toast("Không tải được bảng lương: " + friendlyError(error), "error");
      console.error("Không tải được dữ liệu tính lương:", error);
      return false;
    }
  }
  async function savePayrollSettings(button) {
    const rowElement = button.closest("tr[data-payroll-uid]");
    if (!rowElement) return;
    const row = state.payrollRows.find((item) => item.employeeUid === rowElement.dataset.payrollUid);
    if (!row) {
      toast("Không tìm thấy nhân viên để lưu cấu hình lương.", "error");
      return;
    }
    const inputs = payrollInputValues(rowElement);
    const values = {
      baseSalaryVnd: Number(inputs.baseSalary.value),
      expectedWorkdays: Number(inputs.expectedWorkdays.value),
      allowanceVnd: Number(inputs.allowance.value),
      deductionVnd: Number(inputs.deduction.value)
    };
    if (!Number.isSafeInteger(values.baseSalaryVnd) || values.baseSalaryVnd < 0 || values.baseSalaryVnd > MAX_PAYROLL_AMOUNT_VND ||
        !Number.isFinite(values.expectedWorkdays) || !Number.isInteger(values.expectedWorkdays * 2) ||
        values.expectedWorkdays < 0.5 || values.expectedWorkdays > 31 ||
        !Number.isSafeInteger(values.allowanceVnd) || values.allowanceVnd < 0 || values.allowanceVnd > MAX_PAYROLL_AMOUNT_VND ||
        !Number.isSafeInteger(values.deductionVnd) || values.deductionVnd < 0 || values.deductionVnd > MAX_PAYROLL_AMOUNT_VND) {
      toast("Lương, phụ cấp và khấu trừ phải là số nguyên từ 0 đến 1.000 tỷ; ngày công chuẩn từ 0,5 đến 31, bước 0,5.", "error");
      return;
    }
    setButtonBusy(button, true, "Đang lưu...");
    try {
      await withTimeout(
        state.db.collection("payrollSettings").doc(`${row.employeeUid}_${row.month}`).set({
          employeeUid: row.employeeUid,
          month: row.month,
          ...values,
          updatedBy: state.user.uid,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }),
        15000,
        "Hết thời gian lưu cấu hình lương."
      );
      Object.assign(row, values);
      row.netPayVnd = calculatePayrollNet(row);
      rowElement.querySelector(".payroll-net").textContent =
        row.netPayVnd === null ? "Kiểm tra dữ liệu" : payrollCurrency(row.netPayVnd);
      state.payrollDirty = state.payrollRows.some((item) => {
        const element = $("payrollRows").querySelector(`[data-payroll-uid="${CSS.escape(item.employeeUid)}"]`);
        if (!element) return false;
        const current = payrollInputValues(element);
        return Number(current.baseSalary.value) !== item.baseSalaryVnd ||
          Number(current.expectedWorkdays.value) !== item.expectedWorkdays ||
          Number(current.allowance.value) !== item.allowanceVnd ||
          Number(current.deduction.value) !== item.deductionVnd;
      });
      updatePayrollTotals();
      toast(`Đã lưu cấu hình lương cho ${row.employeeName}.`, "success");
    } catch (error) {
      toast("Không lưu được cấu hình lương: " + friendlyError(error), "error");
      console.error("Không lưu được cấu hình lương:", error);
    } finally {
      setButtonBusy(button, false);
    }
  }
  function exportPayrollExcel() {
    if (state.payrollDirty) {
      toast("Hãy lưu các thay đổi và tính lại bảng lương trước khi xuất.", "error");
      return;
    }
    if (!state.payrollRows.length) {
      toast("Chưa có dữ liệu bảng lương để xuất.", "error");
      return;
    }
    if (state.payrollRows.some((row) => row.netPayVnd === null)) {
      toast("Kiểm tra cấu hình lương không hợp lệ trước khi xuất.", "error");
      return;
    }
    if (!window.XLSX || !XLSX.utils || typeof XLSX.writeFile !== "function") {
      toast("Không tải được thư viện Excel. Hãy kiểm tra Internet rồi tải lại trang.", "error");
      return;
    }
    const rows = state.payrollRows.map((row) => [
      row.employeeId, row.employeeName, row.workdays, row.expectedWorkdays,
      row.baseSalaryVnd, row.allowanceVnd, row.deductionVnd, row.netPayVnd
    ]);
    const monthValue = $("payrollMonthPicker").value;
    const sheet = XLSX.utils.aoa_to_sheet([
      [`BẢNG LƯƠNG TẠM TÍNH - ${monthValue}`],
      [`Ngày xuất: ${csvFormatDate(localDate())}`],
      [],
      ["Mã nhân viên", "Họ và tên", "Ngày công", "Ngày công chuẩn", "Lương cơ bản (₫)", "Phụ cấp (₫)", "Khấu trừ/tạm ứng (₫)", "Thực nhận tạm tính (₫)"],
      ...rows
    ]);
    sheet["!cols"] = [{ wch: 18 }, { wch: 26 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 24 }, { wch: 25 }];
    const title = sheet.A1;
    if (title) title.s = {
      font: { name: "Aptos Display", sz: 16, bold: true, color: { rgb: "FFFFFF" } },
      fill: { patternType: "solid", fgColor: { rgb: "17365D" } }
    };
    for (let column = 0; column < 8; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: 3, c: column })];
      if (cell) cell.s = {
        font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
        fill: { patternType: "solid", fgColor: { rgb: "315A7D" } },
        alignment: { horizontal: "center", wrapText: true }
      };
    }
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Bảng lương");
    try {
      XLSX.writeFile(workbook, `WorkTime_Bang-luong_${monthValue}.xlsx`, { compression: true });
    } catch (error) {
      console.error("Không xuất được bảng lương:", error);
      toast("Không xuất được bảng lương: " + friendlyError(error), "error");
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
  async function loadBiometricConsent() {
    const checkbox = $("biometricConsentCheckbox");
    if (!checkbox || !state.user) return;
    checkbox.disabled = true;
    state.biometricConsentConfirmed = false;
    checkbox.checked = false;
    try {
      const snap = await withTimeout(
        state.db.collection("biometricConsents").doc(state.user.uid).get(),
        15000,
        "Hết thời gian tải xác nhận dữ liệu khuôn mặt."
      );
      const consent = snap.exists ? snap.data() : null;
      state.biometricConsentConfirmed = Boolean(
        consent && consent.accepted === true && consent.policyVersion === BIOMETRIC_NOTICE_VERSION
      );
      checkbox.checked = state.biometricConsentConfirmed;
    } catch (error) {
      console.error("Không tải được xác nhận dữ liệu khuôn mặt:", error);
      setMessage("cameraMessage", "Không kiểm tra được xác nhận dữ liệu khuôn mặt: " + friendlyError(error), "error");
    } finally {
      checkbox.disabled = false;
    }
  }
  async function saveBiometricConsent() {
    const checkbox = $("biometricConsentCheckbox");
    if (!checkbox || !state.user) return;
    const accepted = checkbox.checked;
    checkbox.disabled = true;
    try {
      const batch = state.db.batch();
      const consentRef = state.db.collection("biometricConsents").doc(state.user.uid);
      if (accepted) {
        batch.set(consentRef, {
          accepted: true,
          policyVersion: BIOMETRIC_NOTICE_VERSION,
          acceptedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else {
        batch.delete(consentRef);
      }
      await withTimeout(batch.commit(), 15000, "Hết thời gian lưu xác nhận dữ liệu khuôn mặt.");
      state.biometricConsentConfirmed = accepted;
      if (!accepted) await updateFaceStatus();
      toast(accepted
        ? "Đã lưu xác nhận thông báo dữ liệu trong Firestore."
        : "Đã hủy xác nhận. Mẫu khuôn mặt chưa bị xóa; chỉ quản trị viên mới có thể xóa mẫu này.", "success");
    } catch (error) {
      checkbox.checked = state.biometricConsentConfirmed;
      toast("Không cập nhật được xác nhận dữ liệu: " + friendlyError(error), "error");
      console.error("Không cập nhật được xác nhận dữ liệu:", error);
    } finally {
      checkbox.disabled = false;
    }
  }
  function requireBiometricConsent() {
    if (state.biometricConsentConfirmed && $("biometricConsentCheckbox").checked) return;
    throw new Error("Hãy đọc và xác nhận thông báo dữ liệu khuôn mặt trước khi tiếp tục.");
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
      renderDemoDepartments();
      renderAdminMembers(rows);
      populateAdminEmployeeSelect(rows);
      populateReportEmployeeFilter(rows);
      renderDemoShifts();
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
      $("adminMemberHistoryRows").innerHTML = '<tr><td colspan="8" class="empty">Vui lòng chọn nhân viên.</td></tr>';
      return;
    }
    try {
      const snap = await withTimeout(
        state.db.collection("attendance").where("employeeUid", "==", uid).where("workDate", "==", selectedDate).get(),
        15000,
        "Hết thời gian tải lịch sử chấm công của nhân viên."
      );
      const rows = snap.docs.map((doc) => ({ key: doc.id, ...doc.data() }));
      rows.sort((a, b) =>
        String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "vi") ||
        String(a.employeeId || "").localeCompare(String(b.employeeId || ""), "vi") ||
        String(a.uid || "").localeCompare(String(b.uid || "")) ||
        String(a.checkIn || "").localeCompare(String(b.checkIn || ""))
      );
      const tbody = $("adminMemberHistoryRows");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">Không có bản ghi trong ngày này.</td></tr>';
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
          <td><button type="button" class="btn mini outline" data-action="delete-attendance-record" data-record-id="${esc(record.key)}">Xóa</button></td>
        </tr>
      `).join("");
    } catch (error) {
      setMessage("historyMessage", "Không tải lịch sử của nhân viên: " + friendlyError(error), "error");
      $("adminMemberHistoryRows").innerHTML = '<tr><td colspan="8" class="empty">Không tải được dữ liệu.</td></tr>';
    }
  }
  async function deleteMemberAttendanceRecord(recordId) {
    if (!state.user || !state.profile || state.profile.role !== "admin" || !recordId) {
      toast("Chỉ admin mới được xóa bản ghi chấm công.", "error");
      return;
    }
    const selectedName = $("adminEmployeeSelect").selectedOptions[0]?.textContent || "nhân viên này";
    const selectedDate = $("adminEmployeeDate").value || localDate();
    if (!window.confirm(`Xóa bản ghi chấm công của ${selectedName} ngày ${selectedDate}?`)) return;
    try {
      await withTimeout(
        state.db.collection("attendance").doc(recordId).delete(),
        15000,
        "Hết thời gian xóa bản ghi chấm công."
      );
      toast("Đã xóa bản ghi chấm công.", "success");
      await loadAdminMemberHistory();
      await loadMembers();
    } catch (error) {
      toast("Không xóa được bản ghi: " + friendlyError(error), "error");
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
      $("deleteFaceProfileBtn").classList.toggle(
        "hidden",
        !profile || !state.profile || state.profile.role !== "admin"
      );
    } catch (error) {
      $("profileFaceStatus").textContent = "Không kiểm tra được";
      $("deleteFaceProfileBtn").classList.add("hidden");
      console.error("Không kiểm tra được hồ sơ khuôn mặt:", error);
    }
  }
  async function deleteFaceProfile() {
    if (!state.user || !state.profile || state.profile.role !== "admin") {
      toast("Chỉ quản trị viên mới được hủy đăng ký khuôn mặt.", "error");
      return;
    }
    await deleteFaceProfileForUid(state.user.uid, $("deleteFaceProfileBtn"), state.profile.name || "tài khoản hiện tại");
  }
  async function deleteFaceProfileForUid(uid, button, displayName) {
    if (!state.profile || state.profile.role !== "admin" || !uid) {
      toast("Chỉ quản trị viên mới được hủy đăng ký khuôn mặt.", "error");
      return;
    }
    if (!window.confirm(`Hủy đăng ký và xóa hồ sơ khuôn mặt của ${displayName}? Nhân viên sẽ cần đăng ký lại để chấm công bằng nhận diện.`)) return;
    setButtonBusy(button, true, "Đang xóa...");
    try {
      await withTimeout(
        state.db.collection("faceProfiles").doc(uid).delete(),
        15000,
        "Hết thời gian xóa hồ sơ khuôn mặt khỏi Firestore."
      );
      if (uid === state.user.uid) await updateFaceStatus();
      await loadMembers();
      toast(`Đã hủy đăng ký khuôn mặt của ${displayName}.`, "success");
    } catch (error) {
      toast("Không xóa được hồ sơ khuôn mặt: " + friendlyError(error), "error");
    } finally {
      if (button) setButtonBusy(button, false);
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
  async function loginWithGoogle() {
    const button = $("googleLoginBtn");
    setButtonBusy(button, true, "Đang đăng nhập Google...");
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope("profile");
      await state.auth.signInWithPopup(provider);
    } catch (error) {
      setMessage("authMessage", friendlyError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }
  async function linkGoogleAccount() {
    if (!state.user) return;
    if ((state.user.providerData || []).some((provider) => provider.providerId === "google.com")) {
      toast("Tài khoản Google đã được liên kết.", "success");
      return;
    }
    const button = $("linkGoogleBtn");
    setButtonBusy(button, true, "Đang liên kết...");
    let linked = false;
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope("profile");
      const result = await state.user.linkWithPopup(provider);
      const googleProfile = result.additionalUserInfo && result.additionalUserInfo.profile;
      const googlePhotoURL = result.user.photoURL || (googleProfile && googleProfile.picture) || "";
      state.user = result.user;
      if (googlePhotoURL && !state.profile.photoData) {
        await withTimeout(
          state.db.collection("users").doc(state.user.uid).set({ googlePhotoURL, updatedAt: localDateTime() }, { merge: true }),
          15000,
          "Hết thời gian lưu ảnh Google vào hồ sơ."
        );
        state.profile = { ...state.profile, googlePhotoURL };
      }
      renderProfileAvatar();
      button.textContent = "Google đã liên kết";
      button.disabled = true;
      linked = true;
      toast("Đã liên kết Google với tài khoản WorkTime.", "success");
    } catch (error) {
      toast("Không liên kết được Google: " + friendlyError(error), "error");
    } finally {
      if (!linked) setButtonBusy(button, false);
    }
  }
  function compressProfileImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
        reject(new Error("Chọn ảnh JPG, PNG hoặc WebP."));
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        reject(new Error("Ảnh gốc phải nhỏ hơn 8 MB."));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Không đọc được tệp ảnh."));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("Tệp ảnh không hợp lệ."));
        image.onload = () => {
          const scale = Math.min(1, 360 / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Không xử lý được ảnh trên trình duyệt này."));
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42]) {
            const dataUrl = canvas.toDataURL("image/jpeg", quality);
            if (dataUrl.length <= MAX_PROFILE_PHOTO_CHARS) {
              resolve(dataUrl);
              return;
            }
          }
          reject(new Error("Không thể nén ảnh xuống dưới giới hạn lưu hồ sơ."));
        };
        image.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    });
  }
  async function uploadProfilePhoto() {
    const input = $("profilePhotoInput");
    const file = input.files && input.files[0];
    if (!state.user || !file) {
      toast("Hãy chọn ảnh hồ sơ trước.", "error");
      return;
    }
    const button = $("uploadProfilePhotoBtn");
    setButtonBusy(button, true, "Đang tải ảnh...");
    let saved = false;
    try {
      const photoData = await compressProfileImage(file);
      await withTimeout(
        state.db.collection("users").doc(state.user.uid).set({ photoData, updatedAt: localDateTime() }, { merge: true }),
        15000,
        "Hết thời gian lưu ảnh hồ sơ vào Firestore."
      );
      state.profile = { ...state.profile, photoData };
      renderProfileAvatar();
      input.value = "";
      button.textContent = button.dataset.originalText || "Tải ảnh lên";
      button.disabled = true;
      saved = true;
      toast("Đã cập nhật ảnh hồ sơ.", "success");
    } catch (error) {
      toast("Không tải được ảnh hồ sơ: " + friendlyError(error), "error");
    } finally {
      if (!saved) setButtonBusy(button, false);
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
      "auth/account-exists-with-different-credential": "Email này đã có tài khoản WorkTime. Hãy đăng nhập bằng email và mật khẩu rồi liên kết Google trong hồ sơ.",
      "auth/credential-already-in-use": "Tài khoản Google này đã được liên kết với một tài khoản Firebase khác.",
      "auth/popup-closed-by-user": "Bạn đã đóng cửa sổ đăng nhập Google.",
      "auth/popup-blocked": "Trình duyệt đã chặn cửa sổ Google. Cho phép popup rồi thử lại.",
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
      requireBiometricConsent();
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
      requireBiometricConsent();
      const match = await identifyFace();
      if (match.uid !== state.user.uid) {
        throw new Error("Chỉ có thể chấm công cho tài khoản đang đăng nhập.");
      }
      const now = new Date();
      const shift = shiftInfo(now);
      const recordRef = state.db.collection("attendance").doc(`${match.uid}_${shift.key}`);
      const existingSnapshot = await withTimeout(
        recordRef.get(),
        15000,
        "Hết thời gian kiểm tra ca làm việc trong Firestore."
      );
      const previous = existingSnapshot.exists ? existingSnapshot.data() : null;
      if (previous && previous.checkIn && previous.checkOut) {
        throw new Error("Ca này đã có giờ vào và giờ ra.");
      }
      if ((!previous || !previous.checkIn) &&
          (!shift.isWorkday || now < shift.start || now >= shift.end)) {
        throw new Error("Lịch làm việc: thứ Hai–thứ Sáu 08:00–17:00, thứ Bảy 08:00–12:00; Chủ nhật nghỉ.");
      }
      setMessage("cameraMessage", "Đang chụp ảnh chấm công...");
      const photoDataUrl = await withTimeout(
        capturePhoto(),
        10000,
        "Chụp ảnh mất quá lâu. Hãy tắt rồi bật lại camera."
      );
      const stamp = localDateTime(now);
      let action;
      let status;
      if (!previous || !previous.checkIn) {
        action = "checkIn";
        status = statusForCheckIn(now, shift);
        const record = {
          employeeUid: state.user.uid,
          employeeName: state.profile.name || "Nhân viên",
          employeeId: state.profile.employeeId || "",
          workDate: shift.workDate,
          shift: shift.shift,
          checkIn: stamp,
          checkInTimestamp: now.getTime(),
          checkInServerTimestamp: firebase.firestore.FieldValue.serverTimestamp(),
          status,
          checkInPhotoData: photoDataUrl,
          updatedAt: stamp
        };
        setMessage("cameraMessage", "Đang lưu giờ vào qua Firestore...");
        await withTimeout(
          recordRef.set(record),
          15000,
          "Firestore chưa xác nhận giờ vào. Hãy kiểm tra lịch sử trước khi thử lại."
        );
      } else {
        action = "checkOut";
        status = previous.status || "Đã ghi nhận";
        setMessage("cameraMessage", "Đang lưu giờ ra qua Firestore...");
        await withTimeout(
          recordRef.update({
            checkOut: stamp,
            checkOutTimestamp: now.getTime(),
            checkOutServerTimestamp: firebase.firestore.FieldValue.serverTimestamp(),
            checkOutPhotoData: photoDataUrl,
            updatedAt: stamp
          }),
          15000,
          "Firestore chưa xác nhận giờ ra. Hãy kiểm tra lịch sử trước khi thử lại."
        );
      }
      if ($("showAllAttendanceBtn").dataset.active !== "true") {
        $("filterDate").value = shift.workDate;
      }
      if (action === "checkIn") {
        if (status === "Đi trễ") {
          setMessage("cameraMessage", "Đã lưu giờ vào theo đồng hồ trình duyệt. Đang gửi cảnh báo Gmail...");
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
        if (status === "Đi trễ") {
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
      setMessage("cameraMessage", `Đã ghi nhận ${state.profile.name || state.profile.employeeId || "nhân viên"}.`, "success");
    } catch (error) {
      setMessage("cameraMessage", friendlyError(error), "error");
    } finally {
      setButtonBusy($("attendanceBtn"), false);
    }
  }
  async function loadAttendance() {
    if (!state.user || !state.profile) return;
    const date = $("filterDate").value || localDate();
    const allDates = $("showAllAttendanceBtn").dataset.active === "true";
    $("statDate").textContent = allDates ? "Tất cả ngày" : date;
    $("filterDate").disabled = allDates;
    $("deleteAttendanceDateBtn").disabled = allDates;
    setMessage("historyMessage", "");
    try {
      const attendance = state.db.collection("attendance");
      const query = allDates
        ? state.profile.role === "admin"
          ? attendance
          : attendance.where("employeeUid", "==", state.user.uid)
        : state.profile.role === "admin"
          ? attendance.where("workDate", "==", date)
          : attendance.where("employeeUid", "==", state.user.uid).where("workDate", "==", date);
      const snap = await withTimeout(
        query.get(),
        15000,
        "Hết thời gian chờ tải lịch sử chấm công."
      );
      const rows = snap.docs
        .map(doc => ({ uid: doc.data().employeeUid, key: doc.id, ...doc.data() }))
        .filter(record => allDates || record.workDate === date);
      const sortedRows = sortAttendanceRows(rows);
      state.records = sortedRows;
      renderRows(sortedRows);
      const mine = rows.filter(r => r.uid === state.user.uid)
        .sort((a, b) => String(b.workDate || "").localeCompare(String(a.workDate || "")) || String(b.checkIn || "").localeCompare(String(a.checkIn || "")))[0];
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
    if ($("showAllAttendanceBtn").dataset.active === "true") {
      setMessage("historyMessage", "Hãy tắt chế độ tất cả ngày trước khi xóa chấm công.", "error");
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
      const allDates = $("showAllAttendanceBtn").dataset.active === "true";
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${allDates ? "Chưa có dữ liệu chấm công." : "Chưa có bản ghi trong ngày này."}</td></tr>`;
      return;
    }
    const counts = new Map();
    rows.forEach((record) => {
      const key = record.uid || record.employeeId || record.employeeName || "unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    let previousEmployee = null;
    tbody.innerHTML = rows.map(r => {
      const employeeKey = r.uid || r.employeeId || r.employeeName || "unknown";
      const employeeHeading = employeeKey !== previousEmployee
        ? `<tr class="attendance-group"><td colspan="8"><strong>${esc(r.employeeName || "Nhân viên")}</strong>${r.employeeId ? ` <span class="muted">· ${esc(r.employeeId)}</span>` : ""}<span class="muted"> · ${counts.get(employeeKey)} lượt</span></td></tr>`
        : "";
      previousEmployee = employeeKey;
      const statusClass = r.status === "Đi trễ" ? "late" : "on-time";
      const checkInPhoto = r.checkInPhotoData || "";
      const checkOutPhoto = r.checkOutPhotoData || "";
      const photo = renderPhoto(checkInPhoto, "Ảnh chấm công vào");
      const checkoutPhoto = renderPhoto(checkOutPhoto, "Ảnh chấm công ra", true);
      return `${employeeHeading}<tr>
        <td><strong>${esc(r.employeeName || "Nhân viên")}</strong><br><span class="muted">${esc(r.employeeId || "")}</span></td>
        <td>${esc(r.workDate || "—")}</td><td>${esc(r.shift || "—")}</td>
        <td>${esc(displayTime(r.checkIn))}</td>
        <td><span class="tag ${statusClass}">${esc(r.status || "Đã ghi nhận")}</span></td>
        <td>${esc(displayTime(r.checkOut))}</td>
        <td>${photo}${checkoutPhoto}</td>
        <td>${state.profile.role === "admin" ? `<button type="button" class="btn mini outline" data-action="delete-attendance-record" data-record-id="${esc(r.key)}">Xóa</button>` : "—"}</td></tr>`;
    }).join("");
  }
  async function deleteAttendanceRecord(recordId) {
    if (!state.user || !state.profile || state.profile.role !== "admin" || !recordId) {
      toast("Chỉ admin mới được xóa bản ghi chấm công.", "error");
      return;
    }
    const record = state.records.find((item) => item.key === recordId);
    const name = record && record.employeeName || "nhân viên này";
    const date = record && record.workDate || "ngày đã chọn";
    const shift = record && record.shift ? `, ca ${record.shift}` : "";
    if (!window.confirm(`Xóa bản ghi chấm công của ${name} ngày ${date}${shift}?`)) return;
    try {
      await withTimeout(state.db.collection("attendance").doc(recordId).delete(), 15000, "Hết thời gian xóa bản ghi chấm công.");
      toast("Đã xóa bản ghi chấm công.", "success");
      await loadAttendance();
      if (state.profile.role === "admin") await loadMembers();
    } catch (error) {
      toast("Không xóa được bản ghi: " + friendlyError(error), "error");
    }
  }
  function isSafePhoto(value) {
    return typeof value === "string" && value.startsWith("data:image/jpeg;base64,");
  }
  function renderPhoto(value, label, withBreak = false) {
    if (!isSafePhoto(value)) return "";
    const prefix = withBreak ? "<br>" : "";
    return `${prefix}<img alt="${label}" loading="lazy" width="72" src="${esc(value)}">`;
  }
  function csvFormatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || "");
  }
  function csvFormatTime(value) {
    if (!value) return "";
    const match = /T(\d{2}:\d{2}(?::\d{2})?)/.exec(String(value));
    return match ? match[1] : displayTime(value);
  }
  function attendanceMinutes(record) {
    if (record.migratedFromLegacy) {
      if (!record.checkInTimestamp || !record.checkOutTimestamp) return null;
      const legacyMinutes = Math.floor((record.checkOutTimestamp - record.checkInTimestamp) / 60000);
      return Number.isFinite(legacyMinutes) && legacyMinutes >= 0 ? legacyMinutes : null;
    }
    const checkIn = record.checkInServerTimestamp && typeof record.checkInServerTimestamp.toMillis === "function"
      ? record.checkInServerTimestamp.toMillis()
      : record.checkInTimestamp;
    const checkOut = record.checkOutServerTimestamp && typeof record.checkOutServerTimestamp.toMillis === "function"
      ? record.checkOutServerTimestamp.toMillis()
      : record.checkOutTimestamp;
    if (!checkIn || !checkOut) return null;
    const minutes = Math.floor((checkOut - checkIn) / 60000);
    return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
  }
  function csvFormatDuration(record) {
    const minutes = attendanceMinutes(record);
    return minutes === null ? "" : `${Math.floor(minutes / 60)} giờ ${String(minutes % 60).padStart(2, "0")} phút`;
  }
  function csvWeekday(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return "";
    const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
    return ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"][day];
  }
  function attendanceSort(a, b) {
    return String(a.workDate || "").localeCompare(String(b.workDate || "")) ||
      String(a.checkIn || "").localeCompare(String(b.checkIn || "")) ||
      String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "vi");
  }
  function createAttendanceWorkbook(records, reportTitle, periodLabel, periodValue) {
    if (!window.XLSX || !XLSX.utils || typeof XLSX.writeFile !== "function") {
      toast("Không tải được thư viện Excel. Hãy kiểm tra Internet rồi tải lại trang.", "error");
      return null;
    }

    const sortedRecords = records.slice().sort(attendanceSort);
    const onTimeCount = sortedRecords.filter((record) => record.status === "Đúng giờ").length;
    const lateCount = sortedRecords.filter((record) => record.status === "Đi trễ").length;
    const pendingCount = sortedRecords.filter((record) => record.checkIn && !record.checkOut).length;
    const totalMinutes = sortedRecords.reduce((sum, record) => sum + (attendanceMinutes(record) || 0), 0);
    const employees = new Map();
    sortedRecords.forEach((record) => {
      const key = record.employeeUid || record.employeeId || record.employeeName || "unknown";
      const employee = employees.get(key) || {
        employeeId: record.employeeId || "",
        employeeName: record.employeeName || "Nhân viên",
        total: 0, onTime: 0, late: 0, pending: 0, minutes: 0
      };
      employee.total += 1;
      if (record.status === "Đúng giờ") employee.onTime += 1;
      if (record.status === "Đi trễ") employee.late += 1;
      if (record.checkIn && !record.checkOut) employee.pending += 1;
      employee.minutes += attendanceMinutes(record) || 0;
      employees.set(key, employee);
    });

    const durationLabel = (minutes) =>
      `${Math.floor(minutes / 60)} giờ ${String(minutes % 60).padStart(2, "0")} phút`;
    const employeeRows = Array.from(employees.values())
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName, "vi"))
      .map((employee) => [
        employee.employeeId, employee.employeeName, employee.total, employee.onTime,
        employee.late, employee.pending, durationLabel(employee.minutes)
      ]);
    const generatedAt = `${csvFormatDate(localDate())} ${csvFormatTime(localDateTime())}`;
    const summaryRows = [
      [`WORKTIME | ${reportTitle}`],
      [periodLabel, periodValue],
      ["Ngày xuất báo cáo", generatedAt],
      [],
      ["TỔNG QUAN"],
      ["Tổng lượt chấm công", sortedRecords.length, "Đúng giờ", onTimeCount],
      ["Đi trễ", lateCount, "Chưa chấm giờ ra", pendingCount],
      ["Tổng thời lượng đã ghi nhận", durationLabel(totalMinutes)],
      [],
      ["TỔNG HỢP NHÂN VIÊN"],
      ["Mã nhân viên", "Họ và tên", "Tổng lượt", "Đúng giờ", "Đi trễ", "Chưa chấm giờ ra", "Tổng thời lượng"],
      ...employeeRows
    ];
    const detailRows = [
      [`${reportTitle} - CHI TIẾT`],
      [periodLabel, periodValue],
      [],
      ["STT", "Ngày", "Thứ", "Mã nhân viên", "Họ và tên", "Ca làm", "Giờ vào", "Giờ ra", "Trạng thái", "Thời lượng", "Ảnh vào", "Ảnh ra"],
      ...sortedRecords.map((record, index) => [
        index + 1,
        csvFormatDate(record.workDate),
        csvWeekday(record.workDate),
        record.employeeId || "",
        record.employeeName || "Nhân viên",
        record.shift || "",
        csvFormatTime(record.checkIn),
        csvFormatTime(record.checkOut),
        record.status || "Đã ghi nhận",
        csvFormatDuration(record),
        record.checkInPhotoData ? "Có" : "Không",
        record.checkOutPhotoData ? "Có" : "Không"
      ])
    ];

    const border = {
      top: { style: "thin", color: { rgb: "D8E1EC" } },
      bottom: { style: "thin", color: { rgb: "D8E1EC" } },
      left: { style: "thin", color: { rgb: "D8E1EC" } },
      right: { style: "thin", color: { rgb: "D8E1EC" } }
    };
    const titleStyle = {
      font: { name: "Aptos Display", sz: 18, bold: true, color: { rgb: "FFFFFF" } },
      fill: { patternType: "solid", fgColor: { rgb: "17365D" } },
      alignment: { vertical: "center" }
    };
    const sectionStyle = {
      font: { name: "Aptos", sz: 11, bold: true, color: { rgb: "FFFFFF" } },
      fill: { patternType: "solid", fgColor: { rgb: "2878B5" } },
      alignment: { vertical: "center" }
    };
    const headerStyle = {
      font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
      fill: { patternType: "solid", fgColor: { rgb: "315A7D" } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border
    };
    const bodyStyle = {
      font: { name: "Aptos", sz: 10, color: { rgb: "253449" } },
      alignment: { vertical: "center" },
      border
    };
    const workbook = XLSX.utils.book_new();
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet["!cols"] = [
      { wch: 23 }, { wch: 25 }, { wch: 15 }, { wch: 14 },
      { wch: 14 }, { wch: 22 }, { wch: 24 }
    ];
    summarySheet["!rows"] = [{ hpt: 34 }, { hpt: 22 }, { hpt: 20 }, { hpt: 8 }, { hpt: 23 }, { hpt: 25 }, { hpt: 25 }, { hpt: 25 }, { hpt: 8 }, { hpt: 23 }, { hpt: 32 }];
    summarySheet["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      { s: { r: 4, c: 0 }, e: { r: 4, c: 6 } },
      { s: { r: 9, c: 0 }, e: { r: 9, c: 6 } }
    ];
    summarySheet["!autofilter"] = { ref: `A11:G${Math.max(11, summaryRows.length)}` };
    const setStyle = (sheet, row, column, style) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) cell.s = style;
    };
    setStyle(summarySheet, 0, 0, titleStyle);
    [4, 9].forEach((row) => setStyle(summarySheet, row, 0, sectionStyle));
    for (let column = 0; column < 7; column += 1) {
      setStyle(summarySheet, 10, column, headerStyle);
    }
    [1, 2].forEach((row) => {
      for (let column = 0; column < 2; column += 1) setStyle(summarySheet, row, column, bodyStyle);
      setStyle(summarySheet, row, 0, { ...bodyStyle, font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "52677E" } } });
    });
    [
      [5, 0, 1, "EAF2F8"], [5, 2, 3, "E8F5EE"],
      [6, 0, 1, "FCEEEE"], [6, 2, 3, "FFF5E5"]
    ].forEach(([row, labelColumn, valueColumn, fillColor]) => {
      const fill = { patternType: "solid", fgColor: { rgb: fillColor } };
      setStyle(summarySheet, row, labelColumn, { ...bodyStyle, font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "52677E" } }, fill });
      setStyle(summarySheet, row, valueColumn, { ...bodyStyle, font: { name: "Aptos", sz: 14, bold: true, color: { rgb: "17365D" } }, fill, alignment: { horizontal: "center", vertical: "center" } });
    });
    [0, 1].forEach((column) => setStyle(summarySheet, 7, column, bodyStyle));
    if (summarySheet.A8) summarySheet.A8.s = { ...bodyStyle, font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "52677E" } } };
    if (summarySheet.B8) summarySheet.B8.s = { ...bodyStyle, font: { name: "Aptos", sz: 11, bold: true, color: { rgb: "17365D" } } };
    for (let row = 11; row < summaryRows.length; row += 1) {
      for (let column = 0; column < 7; column += 1) {
        setStyle(summarySheet, row, column, {
          ...bodyStyle,
          fill: { patternType: "solid", fgColor: { rgb: row % 2 ? "F3F7FB" : "FFFFFF" } },
          alignment: { horizontal: column >= 2 && column <= 5 ? "center" : "left", vertical: "center" }
        });
      }
    }

    const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
    detailSheet["!cols"] = [
      { wch: 7 }, { wch: 13 }, { wch: 16 }, { wch: 16 }, { wch: 25 }, { wch: 14 },
      { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 24 }, { wch: 12 }, { wch: 12 }
    ];
    detailSheet["!rows"] = [{ hpt: 34 }, { hpt: 22 }, { hpt: 8 }, { hpt: 32 }];
    detailSheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }];
    detailSheet["!autofilter"] = { ref: `A4:L${Math.max(4, detailRows.length)}` };
    setStyle(detailSheet, 0, 0, titleStyle);
    [0, 1].forEach((column) => setStyle(detailSheet, 1, column, bodyStyle));
    setStyle(detailSheet, 1, 0, { ...bodyStyle, font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "52677E" } } });
    for (let column = 0; column < 12; column += 1) setStyle(detailSheet, 3, column, headerStyle);
    for (let row = 4; row < detailRows.length; row += 1) {
      for (let column = 0; column < 12; column += 1) {
        const fill = { patternType: "solid", fgColor: { rgb: row % 2 ? "F3F7FB" : "FFFFFF" } };
        setStyle(detailSheet, row, column, {
          ...bodyStyle,
          fill,
          alignment: { horizontal: [0, 1, 2, 5, 6, 7, 8, 9, 10, 11].includes(column) ? "center" : "left", vertical: "center" }
        });
      }
      const statusCell = detailSheet[XLSX.utils.encode_cell({ r: row, c: 8 })];
      if (statusCell && statusCell.v === "Đi trễ") {
        statusCell.s = { ...bodyStyle, fill: { patternType: "solid", fgColor: { rgb: "FCE4E4" } }, font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "B42318" } }, alignment: { horizontal: "center", vertical: "center" } };
      } else if (statusCell && statusCell.v === "Đúng giờ") {
        statusCell.s = { ...bodyStyle, fill: { patternType: "solid", fgColor: { rgb: "E5F4EA" } }, font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "18794E" } }, alignment: { horizontal: "center", vertical: "center" } };
      }
    }

    XLSX.utils.book_append_sheet(workbook, summarySheet, "Tổng quan");
    XLSX.utils.book_append_sheet(workbook, detailSheet, "Chi tiết");
    workbook.Props = {
      Title: reportTitle,
      Subject: "Báo cáo chấm công",
      Author: "WorkTime",
      CreatedDate: new Date()
    };
    return workbook;
  }
  function downloadAttendanceExcel(records, reportTitle, periodLabel, periodValue, filename) {
    const workbook = createAttendanceWorkbook(records, reportTitle, periodLabel, periodValue);
    if (!workbook) return;
    try {
      XLSX.writeFile(workbook, filename, { compression: true });
    } catch (error) {
      console.error("Không thể tạo tệp Excel:", error);
      toast("Không thể tạo tệp Excel: " + friendlyError(error), "error");
    }
  }
  function printAttendanceReport(records, reportTitle, periodLabel, periodValue) {
    if (!records.length) {
      toast("Không có dữ liệu để in.", "error");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      toast("Trình duyệt đã chặn cửa sổ in. Hãy cho phép popup rồi thử lại.", "error");
      return;
    }
    const sortedRecords = records.slice().sort(attendanceSort);
    const onTimeCount = sortedRecords.filter((record) => record.status === "Đúng giờ").length;
    const lateCount = sortedRecords.filter((record) => record.status === "Đi trễ").length;
    const pendingCount = sortedRecords.filter((record) => record.checkIn && !record.checkOut).length;
    const totalMinutes = sortedRecords.reduce((sum, record) => sum + (attendanceMinutes(record) || 0), 0);
    const employeeMap = new Map();
    sortedRecords.forEach((record) => {
      const key = record.employeeUid || record.employeeId || record.employeeName || "unknown";
      const employee = employeeMap.get(key) || {
        id: record.employeeId || "", name: record.employeeName || "Nhân viên",
        total: 0, onTime: 0, late: 0, pending: 0, minutes: 0
      };
      employee.total += 1;
      if (record.status === "Đúng giờ") employee.onTime += 1;
      if (record.status === "Đi trễ") employee.late += 1;
      if (record.checkIn && !record.checkOut) employee.pending += 1;
      employee.minutes += attendanceMinutes(record) || 0;
      employeeMap.set(key, employee);
    });
    const durationLabel = (minutes) => `${Math.floor(minutes / 60)} giờ ${String(minutes % 60).padStart(2, "0")} phút`;
    const employeeRows = Array.from(employeeMap.values())
      .sort((a, b) => a.name.localeCompare(b.name, "vi"))
      .map((employee) => `<tr><td>${esc(employee.id)}</td><td>${esc(employee.name)}</td><td>${employee.total}</td><td>${employee.onTime}</td><td>${employee.late}</td><td>${employee.pending}</td><td>${durationLabel(employee.minutes)}</td></tr>`)
      .join("");
    const detailRows = sortedRecords.map((record, index) => `<tr>
      <td>${index + 1}</td><td>${esc(csvFormatDate(record.workDate))}</td><td>${esc(csvWeekday(record.workDate))}</td>
      <td>${esc(record.employeeId || "")}</td><td>${esc(record.employeeName || "Nhân viên")}</td>
      <td>${esc(record.shift || "")}</td><td>${esc(csvFormatTime(record.checkIn) || "—")}</td>
      <td>${esc(csvFormatTime(record.checkOut) || "—")}</td><td>${esc(record.status || "Đã ghi nhận")}</td>
      <td>${esc(csvFormatDuration(record) || "—")}</td><td>${record.checkInPhotoData ? "Có" : "Không"}</td><td>${record.checkOutPhotoData ? "Có" : "Không"}</td>
    </tr>`).join("");
    const generatedAt = `${csvFormatDate(localDate())} ${csvFormatTime(localDateTime())}`;
    const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(reportTitle)}</title>
      <style>
        @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font:12px/1.4 Arial,sans-serif;color:#172033;margin:0}
        h1{font-size:22px;text-align:center;margin:0 0 5px} .period{text-align:center;color:#526174;margin:0 0 18px}
        h2{font-size:14px;margin:18px 0 7px;color:#1d4ed8} .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
        .card{border:1px solid #cbd5e1;border-radius:5px;padding:8px}.card span{display:block;color:#526174;font-size:10px}
        .card strong{display:block;font-size:16px;margin-top:3px}table{width:100%;border-collapse:collapse;margin-top:6px}
        th,td{border:1px solid #9aa6b2;padding:5px 6px;text-align:left;vertical-align:top}th{background:#e8eef5;font-weight:700}
        tbody tr:nth-child(even){background:#f7f9fc}.number{text-align:center}.footer{margin-top:12px;color:#64748b;font-size:10px;text-align:right}
        .tools{display:flex;justify-content:center;gap:8px;margin:0 0 14px}.tools button{padding:8px 14px;border:0;border-radius:5px;background:#245cf2;color:white;font-weight:700;cursor:pointer}
        @media print{.tools{display:none}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid;page-break-inside:avoid}thead{display:table-header-group}}
      </style></head><body>
      <div class="tools"><button id="printNow" type="button">In báo cáo / Lưu PDF</button><button id="closePrint" type="button">Đóng</button></div>
      <h1>${esc(reportTitle)}</h1><p class="period"><strong>${esc(periodLabel)}:</strong> ${esc(periodValue)} &nbsp;·&nbsp; Xuất lúc ${esc(generatedAt)}</p>
      <h2>Tổng quan</h2><div class="summary">
        <div class="card"><span>Tổng lượt chấm công</span><strong>${sortedRecords.length}</strong></div>
        <div class="card"><span>Đúng giờ</span><strong>${onTimeCount}</strong></div>
        <div class="card"><span>Đi trễ</span><strong>${lateCount}</strong></div>
        <div class="card"><span>Chưa chấm giờ ra</span><strong>${pendingCount}</strong></div>
        <div class="card"><span>Tổng thời lượng đã ghi nhận</span><strong>${durationLabel(totalMinutes)}</strong></div>
      </div>
      <h2>Tổng hợp nhân viên</h2><table><thead><tr><th>Mã nhân viên</th><th>Họ và tên</th><th>Tổng lượt</th><th>Đúng giờ</th><th>Đi trễ</th><th>Chưa chấm ra</th><th>Tổng thời lượng</th></tr></thead><tbody>${employeeRows}</tbody></table>
      <h2>Chi tiết chấm công</h2><table><thead><tr><th>STT</th><th>Ngày</th><th>Thứ</th><th>Mã NV</th><th>Họ và tên</th><th>Ca</th><th>Giờ vào</th><th>Giờ ra</th><th>Trạng thái</th><th>Thời lượng</th><th>Ảnh vào</th><th>Ảnh ra</th></tr></thead><tbody>${detailRows}</tbody></table>
      <p class="footer">WorkTime · ${sortedRecords.length} lượt chấm công</p>
      </body></html>`;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.document.getElementById("printNow").addEventListener("click", () => printWindow.print());
    printWindow.document.getElementById("closePrint").addEventListener("click", () => printWindow.close());
    setTimeout(() => printWindow.print(), 350);
  }
  function exportAttendanceExcel() {
    if (!state.records.length) { toast("Không có dữ liệu để xuất.", "error"); return; }
    if ($("showAllAttendanceBtn").dataset.active === "true") {
      downloadAttendanceExcel(
        state.records,
        "BÁO CÁO CHẤM CÔNG TẤT CẢ NGÀY",
        "Phạm vi",
        "Tất cả ngày",
        "WorkTime_Bao-cao-cham-cong_tat-ca-ngay.xlsx"
      );
      return;
    }
    const date = $("filterDate").value || localDate();
    downloadAttendanceExcel(
      state.records,
      "BÁO CÁO CHẤM CÔNG",
      "Ngày làm việc",
      csvFormatDate(date),
      `WorkTime_Bao-cao-cham-cong_${date}.xlsx`
    );
  }
  function exportMonthlyReportExcel() {
    const monthValue = $("adminMonthPicker").value || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    const records = filteredMonthlyRecords(state.monthlyReport);
    if (!records.length) {
      toast("Chưa có dữ liệu để xuất báo cáo tháng.", "error");
      return;
    }
    downloadAttendanceExcel(
      records,
      "BÁO CÁO CHẤM CÔNG THEO THÁNG",
      "Tháng",
      monthValue,
      `WorkTime_Bao-cao-thang_${monthValue}.xlsx`
    );
  }
  function printDailyReport() {
    if ($("showAllAttendanceBtn").dataset.active === "true") {
      printAttendanceReport(state.records, "BẢNG CHI TIẾT CHẤM CÔNG TẤT CẢ NGÀY", "Phạm vi", "Tất cả ngày");
      return;
    }
    const date = $("filterDate").value || localDate();
    printAttendanceReport(state.records, "BẢNG CHI TIẾT CHẤM CÔNG", "Ngày làm việc", csvFormatDate(date));
  }
  function printMonthlyReport() {
    const monthValue = $("adminMonthPicker").value || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`;
    printAttendanceReport(filteredMonthlyRecords(state.monthlyReport), "BẢNG CHI TIẾT CHẤM CÔNG THEO THÁNG", "Tháng", monthValue);
  }
  function bindEvents() {
    $("loginTab").addEventListener("click", () => setAuthTab("login"));
    $("registerTab").addEventListener("click", () => setAuthTab("register"));
    $("loginForm").addEventListener("submit", login);
    $("googleLoginBtn").addEventListener("click", loginWithGoogle);
    $("forgotPasswordBtn").addEventListener("click", forgotPassword);
    $("registerForm").addEventListener("submit", registerAccount);
    $("changePasswordBtn").addEventListener("click", () => {
      $("accountSettingsMenu").classList.add("hidden");
      $("accountSettingsToggle").setAttribute("aria-expanded", "false");
      changePasswordByEmail();
    });
    $("accountSettingsToggle").addEventListener("click", () => {
      const menu = $("accountSettingsMenu");
      const open = menu.classList.contains("hidden");
      menu.classList.toggle("hidden", !open);
      $("accountSettingsToggle").setAttribute("aria-expanded", String(open));
    });
    $("openEmployeeProfileBtn").addEventListener("click", () => {
      $("accountSettingsMenu").classList.add("hidden");
      $("accountSettingsToggle").setAttribute("aria-expanded", "false");
      $("dashboardPage").classList.add("hidden");
      $("employeeProfilePage").classList.remove("hidden");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    $("backToDashboardBtn").addEventListener("click", () => {
      $("employeeProfilePage").classList.add("hidden");
      $("dashboardPage").classList.remove("hidden");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    $("linkGoogleBtn").addEventListener("click", linkGoogleAccount);
    $("profilePhotoInput").addEventListener("change", () => {
      $("uploadProfilePhotoBtn").disabled = !$("profilePhotoInput").files.length;
    });
    $("uploadProfilePhotoBtn").addEventListener("click", uploadProfilePhoto);
    $("logoutBtn").addEventListener("click", async () => { stopCamera(); await state.auth.signOut(); });
    $("startCameraBtn").addEventListener("click", startCamera);
    $("registerFaceBtn").addEventListener("click", registerFace);
    $("registerMaskedFaceBtn").addEventListener("click", registerMaskedFace);
    $("deleteFaceProfileBtn").addEventListener("click", deleteFaceProfile);
    $("attendanceBtn").addEventListener("click", writeAttendance);
    $("biometricConsentCheckbox").addEventListener("change", saveBiometricConsent);
    $("refreshBtn").addEventListener("click", loadAttendance);
    $("showAllAttendanceBtn").addEventListener("click", () => {
      const button = $("showAllAttendanceBtn");
      const active = button.dataset.active !== "true";
      button.dataset.active = String(active);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = active ? "Xem theo ngày" : "Tất cả ngày";
      loadAttendance();
    });
    $("deleteAttendanceDateBtn").addEventListener("click", deleteAttendanceForDate);
    $("attendanceRows").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action='delete-attendance-record']");
      if (!button) return;
      await deleteAttendanceRecord(button.dataset.recordId);
    });
    $("filterDate").addEventListener("change", loadAttendance);
    $("sortAttendanceByNameBtn").addEventListener("click", () => {
      state.attendanceNameSort = state.attendanceNameSort === "asc" ? "desc" : "asc";
      updateAttendanceSortButton();
      state.records = sortAttendanceRows(state.records);
      renderRows(state.records);
    });
    $("exportBtn").addEventListener("click", exportAttendanceExcel);
    $("printDailyBtn").addEventListener("click", printDailyReport);
    $("adminMemberSearch").addEventListener("input", () => renderAdminMembers(state.members));
    $("adminMemberRoleFilter").addEventListener("change", () => renderAdminMembers(state.members));
    $("adminMemberDepartmentFilter").addEventListener("change", () => renderAdminMembers(state.members));
    $("adminMemberStatusFilter").addEventListener("change", () => renderAdminMembers(state.members));
    $("departmentForm").addEventListener("submit", addDemoDepartment);
    $("departmentList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='delete-department']");
      if (button) deleteDemoDepartment(button.dataset.department);
    });
    $("adminEmployeeDate").value = localDate();
    $("adminEmployeeSelect").addEventListener("change", loadAdminMemberHistory);
    $("adminViewMemberHistoryBtn").addEventListener("click", loadAdminMemberHistory);
    $("adminDeleteMemberAttendanceBtn").addEventListener("click", deleteMemberAttendanceForDate);
    $("adminReloadReportBtn").addEventListener("click", loadMonthlyReport);
    $("adminMonthPicker").addEventListener("change", loadMonthlyReport);
    $("adminExportMonthBtn").addEventListener("click", exportMonthlyReportExcel);
    $("adminPrintMonthBtn").addEventListener("click", printMonthlyReport);
    $("payrollReloadBtn").addEventListener("click", loadPayrollReport);
    $("payrollMonthPicker").addEventListener("change", loadPayrollReport);
    $("payrollExportBtn").addEventListener("click", exportPayrollExcel);
    $("payrollRows").addEventListener("input", (event) => {
      if (!event.target.matches("[data-payroll-field]")) return;
      state.payrollDirty = true;
      const row = event.target.closest("tr[data-payroll-uid]");
      if (row) row.querySelector(".payroll-net").textContent = "Lưu để tính lại";
      updatePayrollTotals();
    });
    $("payrollRows").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action='save-payroll']");
      if (button) await savePayrollSettings(button);
    });
    $("adminSaveSettingsBtn").addEventListener("click", saveAdminSettings);
    $("adminDrawerOverlay").addEventListener("click", () => setAdminDrawer(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setAdminDrawer(false);
        $("accountSettingsMenu").classList.add("hidden");
        $("accountSettingsToggle").setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".topbar-actions")) {
        $("accountSettingsMenu").classList.add("hidden");
        $("accountSettingsToggle").setAttribute("aria-expanded", "false");
      }
    });
    document.querySelectorAll(".admin-tab").forEach((button) => {
      button.addEventListener("click", async () => {
        setAdminTab(button.dataset.adminTab);
        if (button.dataset.adminTab === "payroll") await loadPayrollReport();
      });
    });
    $("adminMembersTableBody").addEventListener("click", async (event) => {
      const saveButton = event.target.closest("button[data-action='save-member-preview']");
      if (saveButton) {
        saveDemoEmployeeProfile(saveButton);
        return;
      }
      const button = event.target.closest("button[data-action='toggle-role']");
      if (button) {
        const uid = button.dataset.uid;
        const role = button.dataset.role;
        const nextRole = role === "admin" ? "employee" : "admin";
        await updateMemberRole(uid, nextRole);
        return;
      }
      const deleteFaceButton = event.target.closest("button[data-action='delete-face-profile']");
      if (deleteFaceButton) {
        await deleteFaceProfileForUid(
          deleteFaceButton.dataset.uid,
          deleteFaceButton,
          deleteFaceButton.dataset.name || "nhân viên"
        );
      }
    });
    $("shiftForm").addEventListener("submit", submitDemoShift);
    $("shiftRows").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='delete-demo-shift']");
      if (!button || !state.profile || state.profile.role !== "admin") return;
      state.demoShifts = state.demoShifts.filter((shift) => shift.id !== button.dataset.id);
      renderDemoShifts();
      toast("Đã xóa ca khỏi bản xem trước trong phiên này; chưa lưu lên máy chủ.", "success");
    });
    $("employeeRequestForm").addEventListener("submit", submitDemoRequest);
    $("employeeRequestType").addEventListener("change", updateEmployeeRequestForm);
    $("requestTypeFilter").addEventListener("change", renderDemoRequests);
    $("requestStatusFilter").addEventListener("change", renderDemoRequests);
    $("adminRequestRows").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='review-request']");
      if (button) reviewDemoRequest(button.dataset.id, button.dataset.status);
    });
    $("reportEmployeeFilter").addEventListener("change", () => {
      renderMonthlyReport(state.monthlyReport, $("adminMonthPicker").value);
    });
    $("reportDepartmentFilter").addEventListener("change", () => {
      renderMonthlyReport(state.monthlyReport, $("adminMonthPicker").value);
    });
    $("reportShiftFilter").addEventListener("change", () => {
      renderMonthlyReport(state.monthlyReport, $("adminMonthPicker").value);
    });
    $("adminMemberHistoryRows").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action='delete-attendance-record']");
      if (!button) return;
      await deleteMemberAttendanceRecord(button.dataset.recordId);
    });
    window.addEventListener("beforeunload", stopCamera);
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("camera").classList.add("hidden");
    bindEvents();
    initFirebase();
  });
})();
