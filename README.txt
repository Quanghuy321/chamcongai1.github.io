WORKTIME - HƯỚNG DẪN CÀI ĐẶT TỪ A ĐẾN Z
=========================================

Đây là bản thử nghiệm chạy bằng HTML/CSS/JavaScript + Firebase.
Cần Internet để tải Firebase SDK và model nhận diện khuôn mặt.

A. TẠO FIREBASE PROJECT
1. Mở https://console.firebase.google.com/
2. Tạo project mới (hoặc dùng project bạn đang có).
3. Vào Project settings > General > Your apps > Add app > Web.
4. Đăng ký app và sao chép firebaseConfig.
5. Mở firebase-config.js và thay các giá trị PASTE... / YOUR_PROJECT_ID bằng giá trị thật.
   databaseURL thường có dạng:
   https://TEN_PROJECT-default-rtdb.firebaseio.com
   Một số dự án/khu vực có URL khác; hãy sao chép chính xác từ Realtime Database > Data.
   storageBucket cũng phải lấy đúng từ Firebase config của dự án.

B. BẬT DỊCH VỤ
1. Firebase Console > Authentication > Get started > Sign-in method > Email/Password > Enable.
2. Firebase Console > Realtime Database > Create database.
3. Mở Realtime Database > Rules, dán nội dung database-rules.json rồi Publish.
4. Firebase Console > Storage > Get started.
5. Mở Storage > Rules, dán nội dung storage.rules rồi Publish.

C. CHẠY TRÊN MÁY TÍNH
Không nên mở index.html bằng cách nhấp đúp vì camera thường bị chặn ở file://.
Cách dễ:
1. Cài Visual Studio Code.
2. Mở thư mục WorkTime.
3. Cài extension "Live Server".
4. Nhấn chuột phải index.html > Open with Live Server.
   Hoặc nếu đã cài Python, mở terminal trong thư mục rồi chạy:
       python -m http.server 8000
   Sau đó mở http://localhost:8000
Lưu ý: python http.server chỉ phục vụ file tĩnh, không phải backend bảo mật.

D. ĐƯA LÊN GITHUB PAGES
1. Tạo repository GitHub và upload 4 file web: index.html, style.css,
   firebase-config.js, app.js.
2. Repository > Settings > Pages > Deploy from a branch > chọn main và /(root) > Save.
3. Đợi GitHub Pages tạo URL HTTPS rồi mở URL đó.
4. Thêm domain GitHub Pages vào Firebase Authentication > Settings > Authorized domains
   nếu đăng nhập bị chặn.
5. Không upload private key/service account. firebase-config.js là cấu hình web công khai,
   nhưng vẫn phải bảo vệ bằng Firebase Security Rules.

E. TẠO TÀI KHOẢN VÀ QUYỀN ADMIN
1. Mở web, tạo tài khoản nhân viên.
2. Đăng nhập, nhấn Bật camera, cho phép quyền camera.
3. Đợi trạng thái AI sẵn sàng; nhấn Đăng ký khuôn mặt.
4. Nhấn Nhận diện & chấm công để ghi giờ vào; lần tiếp theo trong cùng ca sẽ ghi giờ ra.
5. Để cấp admin cho một tài khoản thử nghiệm: vào Authentication, sao chép UID.
   Trong Realtime Database > Data, mở users > UID tài khoản đó và sửa role thành "admin".
   Chỉ chủ dự án được thực hiện bước này. Không cấp quyền admin cho tài khoản không tin cậy.

F. CA LÀM VIỆC
- Ca ngày: 06:00 đến trước 18:00.
- Ca đêm: 18:00 đến trước 06:00 hôm sau.
- Trễ khi giờ vào sau giờ bắt đầu ca quá 5 phút.
- Giờ trên bản này lấy từ đồng hồ thiết bị. Người dùng có thể chỉnh giờ máy; vì vậy
  KHÔNG dùng dữ liệu này làm căn cứ tính lương chính thức khi chưa có backend xác minh.

G. LỖI THƯỜNG GẶP
- "Firebase: Error (auth/operation-not-allowed)": bật Email/Password trong Authentication.
- "PERMISSION_DENIED": kiểm tra Realtime Database Rules, đường dẫn databaseURL.
- "storage/unauthorized": kiểm tra Storage Rules và bucket đúng.
- Camera không bật: chạy trên HTTPS hoặc localhost, cấp quyền camera, đóng app đang dùng camera.
- Không tải được model AI: kiểm tra Internet/CDN; thử tải lại trang.
- Ảnh không hiển thị với admin: Storage Rules mẫu chỉ cho chính người tải lên đọc trực tiếp.
  Link download URL dạng token là đường dẫn có thể chia sẻ; không phát tán link ảnh. Để dùng công ty,
  nên dùng backend có phân quyền để cấp ảnh cho admin.

H. KẾT NỐI API CÔNG TY (MẪU REST/JSON)
1. company_api.py là mẫu kiểm tra kết nối tới API qua HTTP(S); đây chưa phải API thật của công ty.
2. Xin bộ phận IT địa chỉ API, endpoint kiểm tra sức khỏe (nếu có), tài liệu xác thực và endpoint
   nghiệp vụ. Không tự đoán endpoint /health nếu hệ thống không cung cấp.
3. Mở PowerShell trong thư mục WorkTimeAI và cấu hình URL cùng endpoint theo tài liệu công ty:
       $env:COMPANY_API_BASE_URL = "https://api.example.com"
       $env:COMPANY_API_HEALTH_PATH = "/health"
       python company_api.py
4. Nếu API yêu cầu access token, đặt token trong biến môi trường trước khi chạy:
       $env:COMPANY_API_TOKEN = "<token do bộ phận IT cấp>"
   Không ghi token vào mã nguồn, không gửi token vào trình duyệt và không dùng token thật trong log.
5. Để gọi API trong mã Python, dùng request_api("GET", "/duong-dan") hoặc
   request_api("POST", "/duong-dan", {"key": "value"}). Chỉ dùng payload và endpoint đúng theo tài liệu.
6. API có token chỉ được gọi qua HTTPS. Ứng dụng web hiện tại vẫn dùng Firebase; muốn thay hoặc
   đồng bộ dữ liệu chấm công với API công ty cần biết hợp đồng API cụ thể và nên gọi qua backend
   có xác thực, phân quyền và kiểm tra dữ liệu phía máy chủ.

CẢNH BÁO BẢO MẬT
================
Đây là starter/demo, KHÔNG phải hệ thống chấm công chống gian lận hoặc production-ready.
- Dữ liệu khuôn mặt là dữ liệu sinh trắc học nhạy cảm. Hãy xin phép, giới hạn quyền truy cập,
  đặt thời hạn lưu, có quy trình xóa và tuân thủ quy định áp dụng.
- Nhận diện chạy trong trình duyệt, có thể bị giả mạo bằng ảnh/video; chưa có liveness detection.
- Quy tắc demo cho phép tài khoản tự ghi attendance của chính mình. Kẻ có kỹ năng có thể sửa dữ liệu
  hoặc đồng hồ trình duyệt. Không dùng làm căn cứ trả lương.
- Bản dùng thực tế cần backend/Cloud Functions, timestamp phía server, kiểm tra quyền ở server,
  liveness detection, audit log, giới hạn truy cập ảnh và kiểm thử bảo mật.
- Không lưu dữ liệu nhân viên thật khi chưa được đơn vị cho phép và chưa đánh giá bảo mật.
