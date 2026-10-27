"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    auth: null, db: null, storage: null, user: null, profile: null,
    stream: null, modelsReady: false, faceTimer: null, records: [], toastTimer: null
  };
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
  const MATCH_THRESHOLD = 0.48; // Cần hiệu chỉnh bằng dữ liệu thật; không phải bảo đảm chống giả mạo.
  const GRACE_MINUTES = 5;

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
  function setAuthTab(tab) {
    const login = tab === "login";
    $("loginTab").classList.toggle("active", login);
    $("registerTab").classList.toggle("active", !login);
    $("loginForm").classList.toggle("hidden", !login);
    $("registerForm").classList.toggle("hidden", login);
    setMessage("authMessage", "");
  }
  function shiftInfo(now = new Date()) {
    const hour = now.getHours();
    if (hour >= 6 && hour < 18) {
      const start = new Date(now); start.setHours(6, 0, 0, 0);
      const end = new Date(now); end.setHours(18, 0, 0, 0);
      return { key: `${localDate(now)}_day`, workDate: localDate(now), shift: "Ca ngày", start, end };
    }
    const start = new Date(now);
    const end = new Date(now);
    if (hour >= 18) {
      start.setHours(18, 0, 0, 0);
      end.setDate(end.getDate() + 1); end.setHours(6, 0, 0, 0);
      return { key: `${localDate(now)}_night`, workDate: localDate(now), shift: "Ca đêm", start, end };
    }
    start.setDate(start.getDate() - 1); start.setHours(18, 0, 0, 0);
    end.setHours(6, 0, 0, 0);
    return { key: `${localDate(start)}_night`, workDate: localDate(start), shift: "Ca đêm", start, end };
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
      state.db = app.database();
      state.storage = app.storage();
      state.auth.onAuthStateChanged(async (user) => {
        if (!user) {
          state.user = null; state.profile = null;
          stopCamera();
          $("authView").classList.remove("hidden");
          $("appView").classList.add("hidden");
          $("userBadge").classList.add("hidden");
          return;
        }
        state.user = user;
        try {
          const snap = await state.db.ref(`users/${user.uid}`).once("value");
          let profile = snap.val();
          if (!profile) {
            profile = {
              name: user.displayName || user.email.split("@")[0],
              employeeId: "NV-" + user.uid.slice(0, 6).toUpperCase(),
              email: user.email || "", role: "employee", createdAt: localDateTime()
            };
            await state.db.ref(`users/${user.uid}`).set(profile);
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
    $("filterDate").value = localDate();
    $("statDate").textContent = localDate();
    await updateFaceStatus();
    await loadAttendance();
  }
  async function updateFaceStatus() {
    try {
      const snap = await state.db.ref(`faceProfiles/${state.user.uid}`).once("value");
      $("profileFaceStatus").textContent = snap.exists() ? "Đã đăng ký" : "Chưa đăng ký";
    } catch (_) {
      $("profileFaceStatus").textContent = "Không kiểm tra được";
    }
  }
  async function registerAccount(event) {
    event.preventDefault();
    const name = $("registerName").value.trim();
    const employeeId = $("registerEmployeeId").value.trim().toUpperCase();
    const email = $("registerEmail").value.trim();
    const password = $("registerPassword").value;
    if (!name || !employeeId || !email || password.length < 6) {
      setMessage("authMessage", "Vui lòng nhập đầy đủ thông tin; mật khẩu tối thiểu 6 ký tự.", "error");
      return;
    }
    setButtonBusy($("registerForm").querySelector("button[type=submit]"), true, "Đang tạo...");
    try {
      const existing = await state.db.ref(`employeeCodes/${employeeId}`).once("value");
      if (existing.exists()) throw new Error("Mã nhân viên đã được sử dụng.");
      const credential = await state.auth.createUserWithEmailAndPassword(email, password);
      const profile = { name, employeeId, email, role: "employee", createdAt: localDateTime() };
      const updates = {};
      updates[`users/${credential.user.uid}`] = profile;
      updates[`employeeCodes/${employeeId}`] = credential.user.uid;
      await state.db.ref().update(updates);
      setMessage("authMessage", "Tạo tài khoản thành công.", "success");
    } catch (error) {
      setMessage("authMessage", friendlyError(error), "error");
    } finally {
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
  function friendlyError(error) {
    const code = error && error.code;
    const map = {
      "auth/invalid-email": "Địa chỉ email không hợp lệ.",
      "auth/user-not-found": "Không tìm thấy tài khoản.",
      "auth/wrong-password": "Mật khẩu không đúng.",
      "auth/invalid-credential": "Email hoặc mật khẩu không đúng.",
      "auth/email-already-in-use": "Email này đã có tài khoản.",
      "auth/weak-password": "Mật khẩu phải có ít nhất 6 ký tự.",
      "auth/too-many-requests": "Thử quá nhiều lần. Vui lòng đợi rồi thử lại.",
      "PERMISSION_DENIED": "Firebase từ chối quyền truy cập. Kiểm tra Realtime Database Rules.",
      "storage/unauthorized": "Firebase Storage Rules từ chối lưu ảnh."
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
    if ($("attendanceBtn")) $("attendanceBtn").disabled = true;
  }
  async function detectFace() {
    if (!state.stream || !$("camera").videoWidth) throw new Error("Hãy bật camera và đợi hình ảnh xuất hiện.");
    const result = await faceapi.detectSingleFace($("camera"), new faceapi.SsdMobilenetv1Options({ minConfidence: 0.55 }))
      .withFaceLandmarks().withFaceDescriptor();
    if (!result) throw new Error("Chưa phát hiện khuôn mặt rõ. Hãy nhìn thẳng, đủ sáng và bỏ khẩu trang nếu phù hợp.");
    return Array.from(result.descriptor);
  }
  async function registerFace() {
    if (!state.user || !state.profile) return;
    setButtonBusy($("registerFaceBtn"), true, "Đang nhận diện...");
    try {
      const descriptor = await detectFace();
      await state.db.ref(`faceProfiles/${state.user.uid}`).set({
        descriptor, employeeId: state.profile.employeeId, updatedAt: localDateTime(),
        model: "face-api.js"
      });
      await updateFaceStatus();
      toast("Đã đăng ký khuôn mặt cho tài khoản này.", "success");
      setMessage("cameraMessage", "Đăng ký khuôn mặt thành công. Thử chấm công để kiểm tra.", "success");
    } catch (error) {
      setMessage("cameraMessage", error.message, "error");
    } finally {
      setButtonBusy($("registerFaceBtn"), false);
    }
  }
  async function getCandidateProfiles() {
    if (state.profile.role === "admin") {
      const snap = await state.db.ref("faceProfiles").once("value");
      const all = snap.val() || {};
      return Object.entries(all).filter(([uid, p]) => uid !== state.user.uid && p && Array.isArray(p.descriptor))
        .map(([uid, p]) => ({ uid, ...p }));
    }
    const snap = await state.db.ref(`faceProfiles/${state.user.uid}`).once("value");
    const p = snap.val();
    return p && Array.isArray(p.descriptor) ? [{ uid: state.user.uid, ...p }] : [];
  }
  async function identifyFace() {
    const descriptor = await detectFace();
    const candidates = await getCandidateProfiles();
    if (!candidates.length) throw new Error(state.profile.role === "admin"
      ? "Chưa có nhân viên nào đăng ký khuôn mặt."
      : "Bạn chưa đăng ký khuôn mặt. Nhấn “Đăng ký khuôn mặt” trước.");
    let best = null;
    for (const candidate of candidates) {
      if (!candidate.descriptor || candidate.descriptor.length !== descriptor.length) continue;
      const distance = faceapi.euclideanDistance(new Float32Array(descriptor), new Float32Array(candidate.descriptor));
      if (!best || distance < best.distance) best = { ...candidate, distance };
    }
    if (!best || best.distance > MATCH_THRESHOLD) {
      throw new Error("Khuôn mặt chưa khớp với hồ sơ đã đăng ký. Thử lại trong điều kiện sáng tốt.");
    }
    return best;
  }
  function capturePhoto() {
    const video = $("camera");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    // Giữ ảnh đúng chiều camera, không lật để lưu bằng chứng.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Không chụp được ảnh.")), "image/jpeg", 0.82));
  }
  async function uploadPhoto(blob, employeeUid, key) {
    const path = `attendancePhotos/${state.user.uid}/${employeeUid}_${key}.jpg`;
    const ref = state.storage.ref(path);
    await ref.put(blob, { contentType: "image/jpeg" });
    return await ref.getDownloadURL();
  }
  async function writeAttendance() {
    setButtonBusy($("attendanceBtn"), true, "Đang xác minh...");
    try {
      const match = await identifyFace();
      const employeeSnap = await state.db.ref(`users/${match.uid}`).once("value");
      const employee = employeeSnap.val();
      if (!employee) throw new Error("Không tìm thấy hồ sơ nhân viên khớp khuôn mặt.");
      const now = new Date();
      let shift = shiftInfo(now);
      let recordRef = state.db.ref(`attendance/${match.uid}/${shift.key}`);
      let existingSnap = await recordRef.once("value");
      let previous = existingSnap.val();

      // Nếu đang từ 06:00 đến trước 12:00, ưu tiên đóng ca đêm hôm trước
      // nếu nhân viên đã chấm vào nhưng chưa chấm ra.
      if (now.getHours() >= 6 && now.getHours() < 12) {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const nightShift = {
          key: `${localDate(yesterday)}_night`,
          workDate: localDate(yesterday),
          shift: "Ca đêm"
        };
        const nightRef = state.db.ref(`attendance/${match.uid}/${nightShift.key}`);
        const nightSnap = await nightRef.once("value");
        const nightRecord = nightSnap.val();
        if (nightRecord && nightRecord.checkIn && !nightRecord.checkOut) {
          shift = nightShift;
          recordRef = nightRef;
          existingSnap = nightSnap;
          previous = nightRecord;
        }
      }

      if (previous && previous.checkIn && previous.checkOut) {
        throw new Error("Ca này đã có giờ vào và giờ ra.");
      }
      // Giới hạn ảnh và lưu bằng chứng. Thời gian trên trình duyệt có thể bị sửa; bản production phải xác minh ở máy chủ.
      const photoBlob = await capturePhoto();
      const photoURL = await uploadPhoto(photoBlob, match.uid, shift.key);
      const stamp = localDateTime(now);
      if (!previous || !previous.checkIn) {
        const status = statusForCheckIn(now, shift);
        const record = {
          employeeUid: match.uid, employeeName: employee.name || "Nhân viên",
          employeeId: employee.employeeId || "", workDate: shift.workDate, shift: shift.shift,
          checkIn: stamp, checkInTimestamp: now.getTime(), status,
          checkInPhoto: photoURL, updatedAt: stamp
        };
        await recordRef.set(record);
        toast(`Chấm công vào thành công: ${status}.`, "success");
      } else {
        const record = {
          ...previous, checkOut: stamp, checkOutTimestamp: now.getTime(),
          checkOutPhoto: photoURL, updatedAt: stamp
        };
        await recordRef.set(record);
        toast("Đã ghi nhận giờ ra.", "success");
      }
      await loadAttendance();
      await updateFaceStatus();
      setMessage("cameraMessage", `Đã ghi nhận ${employee.name || employee.employeeId}.`, "success");
    } catch (error) {
      setMessage("cameraMessage", error.message || friendlyError(error), "error");
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
      const snap = state.profile.role === "admin"
        ? await state.db.ref("attendance").once("value")
        : await state.db.ref(`attendance/${state.user.uid}`).once("value");
      const root = snap.val() || {};
      const rows = [];
      if (state.profile.role === "admin") {
        for (const [uid, shifts] of Object.entries(root)) {
          for (const [key, record] of Object.entries(shifts || {})) {
            if (record && record.workDate === date) rows.push({ uid, key, ...record });
          }
        }
      } else {
        for (const [key, record] of Object.entries(root)) {
          if (record && record.workDate === date) rows.push({ uid: state.user.uid, key, ...record });
        }
      }
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
  function renderRows(rows) {
    const tbody = $("attendanceRows");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Chưa có bản ghi trong ngày này.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const statusClass = r.status === "Đi trễ" ? "late" : "on-time";
      const photo = r.checkInPhoto ? `<a class="photo-link" href="${esc(r.checkInPhoto)}" target="_blank" rel="noopener noreferrer">Xem ảnh vào</a>` : "—";
      const checkoutPhoto = r.checkOutPhoto ? `<br><a class="photo-link" href="${esc(r.checkOutPhoto)}" target="_blank" rel="noopener noreferrer">Ảnh ra</a>` : "";
      return `<tr>
        <td><strong>${esc(r.employeeName || "Nhân viên")}</strong><br><span class="muted">${esc(r.employeeId || "")}</span></td>
        <td>${esc(r.workDate || "—")}</td><td>${esc(r.shift || "—")}</td>
        <td>${esc(displayTime(r.checkIn))}</td>
        <td><span class="tag ${statusClass}">${esc(r.status || "Đã ghi nhận")}</span></td>
        <td>${esc(displayTime(r.checkOut))}</td>
        <td>${photo}${checkoutPhoto}</td></tr>`;
    }).join("");
  }
  function exportCsv() {
    if (!state.records.length) { toast("Không có dữ liệu để xuất.", "error"); return; }
    const headers = ["Nhân viên", "Mã nhân viên", "Ngày", "Ca", "Giờ vào", "Trạng thái", "Giờ ra", "Ảnh vào"];
    const rows = state.records.map(r => [r.employeeName, r.employeeId, r.workDate, r.shift, r.checkIn, r.status, r.checkOut, r.checkInPhoto]);
    const csv = [headers, ...rows].map(row => row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `worktime-${$("filterDate").value || localDate()}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function bindEvents() {
    $("loginTab").addEventListener("click", () => setAuthTab("login"));
    $("registerTab").addEventListener("click", () => setAuthTab("register"));
    $("loginForm").addEventListener("submit", login);
    $("registerForm").addEventListener("submit", registerAccount);
    $("logoutBtn").addEventListener("click", async () => { stopCamera(); await state.auth.signOut(); });
    $("startCameraBtn").addEventListener("click", startCamera);
    $("registerFaceBtn").addEventListener("click", registerFace);
    $("attendanceBtn").addEventListener("click", writeAttendance);
    $("refreshBtn").addEventListener("click", loadAttendance);
    $("filterDate").addEventListener("change", loadAttendance);
    $("exportBtn").addEventListener("click", exportCsv);
    window.addEventListener("beforeunload", stopCamera);
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("camera").classList.add("hidden");
    bindEvents();
    initFirebase();
  });
})();
