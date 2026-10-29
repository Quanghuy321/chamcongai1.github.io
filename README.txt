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
   Ứng dụng lưu hồ sơ và chấm công trong Cloud Firestore.
   databaseURL chỉ cần nếu muốn ứng dụng nhập dữ liệu cũ từ Realtime Database.

B. BẬT DỊCH VỤ
1. Firebase Console > Authentication > Get started > Sign-in method > Email/Password > Enable.
2. Firebase Console > Firestore Database > Create database.
3. Mở Firestore Database > Rules, dán nội dung firestore.rules rồi Publish.
4. Tạo composite index theo firestore.indexes.json (hoặc chọn Create index khi Firestore báo yêu cầu).
5. Ảnh chấm công được nén và lưu trực tiếp trong tài liệu Firestore.
6. Nếu có dữ liệu phiên bản cũ, giữ Realtime Database hoạt động và databaseURL trong config:
   ứng dụng sẽ nhập hồ sơ, khuôn mặt và lịch sử của từng tài khoản khi tài khoản đó đăng nhập lần đầu.
   Dữ liệu cũ sẽ không bị xóa khỏi Realtime Database.
7. Để gửi email cảnh báo khi nhân viên đi trễ, cần bật thanh toán Firebase (Blaze), cài Firebase
   CLI, rồi cài extension gửi email và cấu hình SMTP của nhà cung cấp email:
       firebase ext:install firebase/firestore-send-email --project=chamcongai-158f5
   Khi được hỏi, đặt collection nhận email là "mail" và nhập SMTP host, cổng, tài khoản,
   mật khẩu/app password cùng địa chỉ gửi theo hướng dẫn của nhà cung cấp.
8. Trong thư mục dự án, cài dependencies backend và triển khai function cùng Rules:
       cd functions
       npm.cmd install
       cd ..
       firebase deploy --only functions,firestore:rules,firestore:indexes --project=chamcongai-158f5
   Function sẽ gửi cảnh báo đến email nhân viên và các tài khoản có role "admin" trong Firestore.
   Không mở quyền đọc/ghi collection "mail" cho trình duyệt và không đưa mật khẩu SMTP vào mã nguồn.

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
1. Tạo repository GitHub và upload các file web: index.html, style.css,
   firebase-config.js, app.js, firestore.rules và firestore.indexes.json.
2. Repository > Settings > Pages > Deploy from a branch > chọn main và /(root) > Save.
3. Đợi GitHub Pages tạo URL HTTPS rồi mở URL đó.
4. Thêm domain GitHub Pages vào Firebase Authentication > Settings > Authorized domains
   nếu đăng nhập bị chặn.
5. Đảm bảo firestore.rules đã được Publish trong Firebase Console. Không upload private key/service
   account. firebase-config.js là cấu hình web công khai, nhưng vẫn phải bảo vệ bằng Firebase Rules.

E. TẠO TÀI KHOẢN VÀ QUYỀN ADMIN
1. Mở web, tạo tài khoản nhân viên.
2. Đăng nhập, nhấn Bật camera, cho phép quyền camera.
3. Đợi trạng thái AI sẵn sàng; nhấn Đăng ký khuôn mặt.
4. Muốn nhận diện khi đeo khẩu trang, hãy đeo khẩu trang và nhấn Đăng ký thêm khi đeo khẩu trang.
   Khi chấm công bằng mẫu này, giữ khẩu trang trên mặt và nhìn thẳng vào camera.
5. Nhấn Nhận diện & chấm công để ghi giờ vào; lần tiếp theo trong cùng ca sẽ ghi giờ ra.
6. Để cấp admin cho một tài khoản thử nghiệm: vào Authentication, sao chép UID.
   Trong Firestore Database > Data, mở collection users > tài liệu có ID là UID đó và sửa role
   thành "admin".
   Chỉ chủ dự án được thực hiện bước này. Không cấp quyền admin cho tài khoản không tin cậy.
7. Tài khoản admin cũ được nhập từ Realtime Database sẽ cần được cấp lại role admin trong Firestore.

F. CA LÀM VIỆC
- Ca ngày: 06:00 đến trước 18:00.
- Ca đêm: 18:00 đến trước 06:00 hôm sau.
- Trễ khi giờ vào sau giờ bắt đầu ca quá 5 phút.
- Giờ trên bản này lấy từ đồng hồ thiết bị. Người dùng có thể chỉnh giờ máy; vì vậy
  KHÔNG dùng dữ liệu này làm căn cứ tính lương chính thức khi chưa có backend xác minh.

G. LỖI THƯỜNG GẶP
- "Firebase: Error (auth/operation-not-allowed)": bật Email/Password trong Authentication.
- "Missing or insufficient permissions": kiểm tra và Publish firestore.rules.
- Nếu tạo tài khoản bị Firestore từ chối, hãy tải phiên bản app.js mới và Publish firestore.rules
  trong đúng Firebase project. Ứng dụng cần đăng nhập tài khoản mới trước khi kiểm tra mã nhân viên
  và ghi hồ sơ; không cho phép đọc employeeCodes khi chưa đăng nhập.
- Nếu nhân viên bị từ chối ngay lần chấm công đầu tiên, hãy cập nhật và Publish firestore.rules mới:
  quyền đọc bản ghi ca chưa tồn tại là cần thiết để kiểm tra trước khi tạo giờ vào.
- Camera không bật: chạy trên HTTPS hoặc localhost, cấp quyền camera, đóng app đang dùng camera.
- Không tải được model AI: kiểm tra Internet/CDN; thử tải lại trang.
- Nhận diện khi đeo khẩu trang: phải đăng ký thêm mẫu lúc đang đeo khẩu trang; webcam phổ thông
  không quét võng mạc và nhận diện mặt có thể sai, nên cần thử nghiệm trên thiết bị thực tế.
- Chấm công cứ hiện "Đang xác minh": tải lại trang; ứng dụng sẽ báo bước nhận diện hoặc Firestore
  bị quá thời gian chờ. Kiểm tra ánh sáng/camera, kết nối Internet và Firestore Rules.
- Nút "Xuất CSV" tạo báo cáo UTF-8 có tổng quan lượt chấm công, đúng giờ, đi trễ,
  chưa chấm giờ ra và bảng chi tiết; thời lượng tính theo giờ thiết bị đã ghi nhận.
- Admin có nút "Reset chấm công của tôi": chỉ xóa bản ghi của chính tài khoản admin
  trong ngày đang chọn, sau khi xác nhận. Nút không xóa dữ liệu của nhân viên khác.
- Email cảnh báo đi trễ không đến: kiểm tra Firebase Functions đã triển khai, extension
  "Trigger Email" đã cài với collection "mail", SMTP/địa chỉ gửi hợp lệ và email nhân viên/admin
  có trong tài liệu users của Firestore. Xem nhật ký Functions và trạng thái gửi trong tài liệu mail.
- Ảnh được nén và lưu dạng Base64 cùng tài liệu chấm công trong Firestore.
- Nếu nhận diện khuôn mặt cũ chưa được nhập, đăng nhập tài khoản đó khi Realtime Database cũ còn hoạt động.

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
6. API có token chỉ được gọi qua HTTPS. Ứng dụng web hiện tại dùng Firebase Authentication và
   Cloud Firestore; muốn thay hoặc đồng bộ dữ liệu chấm công với API công ty cần biết hợp đồng API
   cụ thể và nên gọi qua backend
   có xác thực, phân quyền và kiểm tra dữ liệu phía máy chủ.

CẢNH BÁO BẢO MẬT
================
Đây là starter/demo, KHÔNG phải hệ thống chấm công chống gian lận hoặc production-ready.
- Dữ liệu khuôn mặt và ảnh Base64 trong Firestore là dữ liệu sinh trắc học nhạy cảm. Hãy xin phép,
  giới hạn quyền truy cập, đặt thời hạn lưu, có quy trình xóa và tuân thủ quy định áp dụng.
- Firestore giới hạn mỗi tài liệu dưới 1 MiB; ứng dụng giới hạn ảnh nén để có thể lưu ảnh vào và ảnh
  ra trong cùng tài liệu. Không lưu thêm ảnh lớn vào các trường này.
- Nhận diện chạy trong trình duyệt, có thể bị giả mạo bằng ảnh/video; chưa có liveness detection.
- Quy tắc demo cho phép tài khoản tự ghi attendance của chính mình. Kẻ có kỹ năng có thể sửa dữ liệu
  hoặc đồng hồ trình duyệt. Không dùng làm căn cứ trả lương.
- Bản dùng thực tế cần backend/Cloud Functions, timestamp phía server, kiểm tra quyền ở server,
  liveness detection, audit log, giới hạn truy cập ảnh và kiểm thử bảo mật.
- Không lưu dữ liệu nhân viên thật khi chưa được đơn vị cho phép và chưa đánh giá bảo mật.
