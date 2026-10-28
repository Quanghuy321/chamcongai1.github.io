/*
  DÁN CẤU HÌNH WEB APP CỦA BẠN TỪ FIREBASE CONSOLE VÀO ĐÂY.
  Firebase Console > Project settings (bánh răng) > General > Your apps > SDK setup and configuration.
  Không lấy apiKey hoặc databaseURL của dự án khác. apiKey Firebase không phải mật khẩu,
  nhưng không được đưa private service-account key vào website.
*/
const firebaseConfig = {
  apiKey: "AIzaSyDhP02DtLarvgPQZ2YFW7udByDoos6reYE",
  authDomain: "chamcongai-158f5.firebaseapp.com",
  databaseURL: "https://chamcongai-158f5-default-rtdb.firebaseio.com",
  projectId: "chamcongai-158f5",
  messagingSenderId: "654846141477",
  appId: "1:654846141477:web:3610fa70bc7b667e8c4bcc",
  measurementId: "G-TDJZ3Q7H15"
};

window.FIREBASE_CONFIG = firebaseConfig;