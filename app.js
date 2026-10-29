"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    auth: null, db: null, legacyDb: null, user: null, profile: null,
    stream: null, modelsReady: false, faceTimer: null, records: [], toastTimer: null,
    registrationInProgress: false
  };
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
  const MATCH_THRESHOLD = 0.48; // Cần hiệu chỉnh bằng dữ liệu thật; không phải bảo đảm chống giả mạo.
  const GRACE_MINUTES = 5;
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
    $("resetAttendanceBtn").classList.toggle("hidden", state.profile.role !== "admin");
    $("filterDate").value = localDate();
    $("statDate").textContent = localDate();
    await updateFaceStatus();
    await loadAttendance();
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
    } catch (error) {
      $("profileFaceStatus").textContent = "Không kiểm tra được";
      console.error("Không kiểm tra được hồ sơ khuôn mặt:", error);
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
    const result = await faceapi.detectSingleFace($("camera"), new faceapi.SsdMobilenetv1Options({ minConfidence: 0.55 }))
      .withFaceLandmarks().withFaceDescriptor();
    if (!result) throw new Error("Chưa phát hiện khuôn mặt rõ. Hãy nhìn thẳng, đủ sáng và bỏ khẩu trang nếu phù hợp.");
    return Array.from(result.descriptor);
  }
  async function registerFace() {
    return saveFaceDescriptor(false);
  }
  async function registerMaskedFace() {
    return saveFaceDescriptor(true);
  }
  async function saveFaceDescriptor(masked) {
    if (!state.user || !state.profile) return;
    const button = $(masked ? "registerMaskedFaceBtn" : "registerFaceBtn");
    setButtonBusy(button, true, "Đang nhận diện...");
    try {
      const descriptor = await detectFace();
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
  async function requestLateAttendanceEmail(recordId) {
    const endpoint = window.WORKTIME_EMAIL_ALERT_URL;
    if (!endpoint) {
      throw new Error("Chấm công đã lưu, nhưng chưa cấu hình URL Google Apps Script để gửi email.");
    }
    const idToken = await state.user.getIdToken();
    await fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ idToken, recordId })
    });
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
        const nightRef = state.db.collection("attendance").doc(`${match.uid}_${nightShift.key}`);
        const nightSnap = await withTimeout(
          nightRef.get(),
          15000,
          "Hết thời gian chờ kiểm tra ca đêm trong Firestore."
        );
        const nightRecord = nightSnap.exists ? nightSnap.data() : null;
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
            toast("Đã gửi yêu cầu cảnh báo đi trễ. Kiểm tra Apps Script > Executions nếu chưa nhận được email.", "success");
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
  async function resetOwnAttendance() {
    if (!state.user || !state.profile || state.profile.role !== "admin") {
      setMessage("historyMessage", "Chỉ admin mới được reset chấm công.", "error");
      return;
    }

    const date = $("filterDate").value || localDate();
    const button = $("resetAttendanceBtn");
    setButtonBusy(button, true, "Đang kiểm tra...");
    setMessage("historyMessage", "");
    try {
      const snap = await withTimeout(
        state.db.collection("attendance")
          .where("employeeUid", "==", state.user.uid)
          .where("workDate", "==", date)
          .get(),
        15000,
        "Hết thời gian tìm bản ghi chấm công cần reset."
      );
      if (snap.empty) {
        toast("Tài khoản của bạn không có dữ liệu chấm công trong ngày này.", "error");
        return;
      }

      const confirmMessage = `Xóa ${snap.size} bản ghi chấm công của tài khoản admin đang đăng nhập trong ngày ${date}? Dữ liệu đã xóa không thể khôi phục.`;
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

      toast(`Đã xóa ${snap.size} bản ghi chấm công của bạn trong ngày ${date}.`, "success");
      await loadAttendance();
    } catch (error) {
      const message = "Không reset được chấm công: " + friendlyError(error);
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
  function bindEvents() {
    $("loginTab").addEventListener("click", () => setAuthTab("login"));
    $("registerTab").addEventListener("click", () => setAuthTab("register"));
    $("loginForm").addEventListener("submit", login);
    $("registerForm").addEventListener("submit", registerAccount);
    $("logoutBtn").addEventListener("click", async () => { stopCamera(); await state.auth.signOut(); });
    $("startCameraBtn").addEventListener("click", startCamera);
    $("registerFaceBtn").addEventListener("click", registerFace);
    $("registerMaskedFaceBtn").addEventListener("click", registerMaskedFace);
    $("attendanceBtn").addEventListener("click", writeAttendance);
    $("refreshBtn").addEventListener("click", loadAttendance);
    $("resetAttendanceBtn").addEventListener("click", resetOwnAttendance);
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
