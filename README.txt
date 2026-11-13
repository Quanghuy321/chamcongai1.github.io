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
   Muốn bật đăng nhập/liên kết Google, vào cùng mục Sign-in method > Google > Enable và thêm
   domain website trong Authentication > Settings > Authorized domains.
   Trong Authentication > Settings > Password policy, đặt tối thiểu 12 ký tự và yêu cầu chữ hoa,
   chữ thường, số, ký tự đặc biệt; bật chế độ Require để Firebase kiểm tra ở phía dịch vụ.
   Web có nút Quên mật khẩu và Đổi mật khẩu qua email. Firebase gửi email có liên kết đặt lại
   một lần (chứa mã thao tác); người dùng mở liên kết để đặt mật khẩu mới, không nhập OTP 6 số.
2. Firebase Console > Firestore Database > Create database.
3. Mở Firestore Database > Rules, dán nội dung firestore.rules rồi Publish.
   Quy tắc giới hạn kích thước ảnh hồ sơ và chỉ cho admin xóa hồ sơ hoặc gỡ mẫu khuôn mặt;
   cần Publish để áp dụng các giới hạn này.
4. Tạo composite index theo firestore.indexes.json (hoặc chọn Create index khi Firestore báo yêu cầu).
5. Ảnh chấm công được nén và lưu trực tiếp trong tài liệu Firestore.
6. Nếu có dữ liệu phiên bản cũ, giữ Realtime Database hoạt động và databaseURL trong config:
   ứng dụng sẽ nhập hồ sơ, khuôn mặt và lịch sử của từng tài khoản khi tài khoản đó đăng nhập lần đầu.
   Dữ liệu cũ sẽ không bị xóa khỏi Realtime Database.
7. Gửi cảnh báo Gmail miễn phí bằng Google Apps Script (không cần Cloud Functions/Blaze):
   a. Mở https://script.new, tạo dự án Apps Script và dán nội dung apps-script/Code.gs vào Code.gs.
   b. Trong Project Settings > Script Properties, thêm:
       FIREBASE_API_KEY = giá trị apiKey trong firebase-config.js
       FIREBASE_PROJECT_ID = chamcongai-158f5
       ADMIN_EMAIL = Gmail admin nhận cảnh báo
   c. Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone.
      Cấp quyền cho Apps Script gửi email khi Google yêu cầu. Email gửi đi từ Gmail chủ sở hữu script.
      Trong Apps Script editor, chọn setupLateAttendanceReminderWorker rồi bấm Run một lần và cấp quyền.
      Lịch sẽ gửi cảnh báo ngay, nhắc lại khoảng 30 và 60 phút sau; chấm công ra sẽ yêu cầu hủy nhắc.
   d. Sao chép URL web app kết thúc bằng /exec, điền vào WORKTIME_EMAIL_ALERT_URL trong
      firebase-config.js, ví dụ:
       window.WORKTIME_EMAIL_ALERT_URL = "https://script.google.com/macros/s/DEPLOYMENT_ID/exec";
      rồi cập nhật firebase-config.js cùng app.js lên website.
   e. Thử một lượt chấm công "Đi trễ" mới. Apps Script xác thực Firebase ID token, đọc lại bản ghi
      Firestore và chỉ gửi nếu người gọi là nhân viên đó hoặc admin. Nhân viên nhận ở email tài khoản
      Firebase Auth; admin nhận ở ADMIN_EMAIL. Trình duyệt gửi yêu cầu cross-origin ở chế độ no-cors
      nên không đọc được kết quả xử lý; xác minh việc gửi thành công trong Apps Script > Executions
      và hộp thư (bao gồm Spam). Không bấm Run cho doPost trong Apps Script; Run không có dữ liệu POST.
   Gmail cá nhân có giới hạn gửi hằng ngày. Xem Apps Script > Executions để kiểm tra lỗi; không đưa
   mật khẩu Gmail, App Password hoặc token vào mã nguồn. Nếu đã deploy Cloud Function cũ, xóa
   sendLateAttendanceEmail trong Firebase Console > Functions để tránh chạy song song.

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
   Tài khoản admin cũng có thể đăng ký và nhận diện khuôn mặt của chính mình để kiểm thử.
6. Để cấp admin cho một tài khoản thử nghiệm: vào Authentication, sao chép UID.
   Trong Firestore Database > Data, mở collection users > tài liệu có ID là UID đó và sửa role
   thành "admin".
   Chỉ chủ dự án được thực hiện bước này. Không cấp quyền admin cho tài khoản không tin cậy.
7. Tài khoản admin cũ được nhập từ Realtime Database sẽ cần được cấp lại role admin trong Firestore.

F. CA LÀM VIỆC
- Ca hành chính: 08:00 đến 17:00 từ thứ Hai đến thứ Sáu.
- Thứ Bảy: 08:00 đến 12:00; Chủ nhật nghỉ.
- Trễ khi giờ vào sau giờ bắt đầu ca quá 5 phút.
- Chấm công không dùng Cloud Functions; ngày/giờ và trạng thái lấy từ đồng hồ trình duyệt.

G. LỖI THƯỜNG GẶP
- "Firebase: Error (auth/operation-not-allowed)": bật Email/Password trong Authentication.
- "Missing or insufficient permissions": kiểm tra và Publish firestore.rules.
- Nếu tạo tài khoản bị Firestore từ chối, hãy tải phiên bản app.js mới và Publish firestore.rules
  trong đúng Firebase project. Ứng dụng cần đăng nhập tài khoản mới trước khi kiểm tra mã nhân viên
  và ghi hồ sơ; không cho phép đọc employeeCodes khi chưa đăng nhập.
- Nếu chấm công bị từ chối, hãy Publish firestore.rules mới trong đúng Firebase project và kiểm
  tra đăng nhập, xác nhận dữ liệu khuôn mặt, dung lượng ảnh.
- Camera không bật: chạy trên HTTPS hoặc localhost, cấp quyền camera, đóng app đang dùng camera.
- Không tải được model AI: kiểm tra Internet/CDN; thử tải lại trang.
- Nhận diện khi đeo khẩu trang: phải đăng ký thêm mẫu lúc đang đeo khẩu trang; webcam phổ thông
  không quét võng mạc và nhận diện mặt có thể sai, nên cần thử nghiệm trên thiết bị thực tế.
- Chấm công cứ hiện "Đang xác minh": tải lại trang; ứng dụng sẽ báo bước nhận diện hoặc Firestore
  bị quá thời gian chờ. Kiểm tra ánh sáng/camera, kết nối Internet và Firestore Rules.
- Nút "Xuất Excel" tạo tệp .xlsx gồm trang tổng quan, tổng hợp nhân viên và chi tiết
  chấm công có định dạng; cần kết nối Internet để tải thư viện Excel.
  Thời lượng tính từ timestamp Firestore; ngày làm việc và trạng thái do trình duyệt khai báo
  nên chưa đủ độ tin cậy để tính lương chính thức.
- Nút "Làm mới" chỉ tải lại lịch sử. Admin có nút "Xóa chấm công ngày này" để xóa
  toàn bộ bản ghi của tất cả nhân viên trong ngày đang chọn sau bước xác nhận.
- Admin có thể đổi thứ tự bảng chấm công giữa tên A-Z và Z-A bằng nút "Tên A-Z"/"Tên Z-A".
- Email cảnh báo đi trễ không đến: kiểm tra WORKTIME_EMAIL_ALERT_URL là URL /exec mới nhất,
  Apps Script đã Deploy dạng Web app (Execute as Me, Anyone), Script Properties có đủ 3 khóa,
  và xem Apps Script > Executions. Kiểm tra thư Spam và giới hạn gửi Gmail. Chỉ lượt chấm công
  mới sau khi cập nhật website mới gửi yêu cầu.
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

I. GIAO DIỆN XEM TRƯỚC (CHƯA CÓ BACKEND)
- Admin có thể xem trước giao diện tạo/xóa ca làm, gán nhân viên, lọc báo cáo và duyệt yêu cầu.
- Admin có thể tạo phòng ban, gán nhân viên vào phòng ban, lọc danh sách và đặt trạng thái hồ sơ
  xem trước là đang làm hoặc tạm ngưng. Trạng thái này chưa khóa tài khoản hay thay đổi quyền truy cập.
- Nút "Lưu hồ sơ" và phòng ban chỉ lưu trong bộ nhớ của trang hiện tại; tải lại trang sẽ mất.
- Nhân viên có thể tạo yêu cầu sửa chấm công/nghỉ phép trong giao diện.
- Ca làm và yêu cầu chỉ giữ trong bộ nhớ của trang hiện tại; tải lại trang sẽ mất.
  Thao tác này chưa cập nhật lịch chấm công, chưa gửi yêu cầu đến quản lý và không tạo dữ liệu Firebase.
- Danh sách nhân viên, lịch sử chấm công và báo cáo hiện có vẫn đọc dữ liệu Firebase như trước.
- Chỉ admin có thể xóa hồ sơ/gỡ mẫu khuôn mặt; Firestore Rules cũng từ chối thao tác đó từ tài khoản nhân viên.
  Sau khi sửa Rules, phải Publish firestore.rules lên đúng Firebase project.

CẢNH BÁO BẢO MẬT
================
Đây là starter/demo, KHÔNG phải hệ thống chấm công hoặc tính lương production-ready.
- Không cần triển khai hoặc bật Cloud Functions; chỉ cần publish Firestore Rules. Thao tác chấm công,
  xác nhận dữ liệu và tính lương chạy trực tiếp từ trình duyệt.
- Đồng hồ, ngày làm việc, trạng thái đúng giờ/đi trễ và dữ liệu ngày công đều do trình duyệt gửi.
  Firestore Rules yêu cầu một trường server timestamp nhưng không thể xác minh nhận diện khuôn mặt,
  liveness, ngày làm việc hay trạng thái đi trễ do client khai báo. Người dùng có thể gọi Firestore
  trực tiếp và giả mạo bản ghi của chính mình. Không dùng làm căn cứ chấm công/lương chính thức.
- Kết quả tính lương chạy trên trình duyệt; nhân viên/quản trị viên có thể sửa mã phía client hoặc
  dữ liệu chấm công. Lương, phụ cấp, khấu trừ được bảo vệ quyền ghi bằng Firestore Rules cho admin,
  nhưng công thức/dữ liệu tính ra không được backend độc lập xác minh.
- Backend chưa tự xác minh descriptor khuôn mặt từ camera. Nhận diện và so khớp vẫn chạy ở trình
  duyệt; người dùng có thể bỏ qua hoặc giả lập luồng client. Đây KHÔNG phải xác thực liveness
  đáng tin cậy, và chưa thể coi là chống gian lận. Cần tích hợp nhà cung cấp liveness có xác thực
  kết quả phía server trước khi dùng chấm công chính thức.
- Dữ liệu khuôn mặt và ảnh Base64 trong Firestore là dữ liệu sinh trắc học nhạy cảm. Màn hình
  yêu cầu xác nhận thông báo và lưu dấu thời gian Firestore, nhưng việc ghi xác nhận do client gửi,
  không có backend xác minh. Đây không thay thế tư vấn pháp lý/chính sách quyền riêng tư. Chỉ thu
  thập khi có căn cứ phù hợp; cần xác định thời hạn lưu, quy trình xóa ảnh chấm công và phân công
  người xử lý yêu cầu xóa trước khi vận hành.
- Firestore giới hạn mỗi tài liệu dưới 1 MiB; ứng dụng giới hạn ảnh nén để có thể lưu ảnh vào và ảnh
  ra trong cùng tài liệu. Không lưu thêm ảnh lớn vào các trường này.
- Phân quyền đọc dữ liệu chấm công vẫn cho phép nhân viên xem bản ghi của mình và quản trị viên
  xem tất cả; ảnh đang nằm trong tài liệu chấm công. Cần kiểm thử Rules trên project trước khi dùng.
- Tab "Tính lương" chạy trên trình duyệt: lương cơ bản theo tháng được chia theo ngày công trong
  Firestore (thứ Bảy tính nửa ngày), cộng phụ cấp, trừ khấu trừ/tạm ứng. Chưa có tăng ca, thuế,
  bảo hiểm, ngày nghỉ hưởng lương hoặc quy tắc theo luật; HR/kế toán cần phê duyệt công thức.
- Chưa có App Check, dịch vụ liveness, nhật ký kiểm toán đầy đủ hoặc chính sách lưu/xóa tự động.
- Không lưu dữ liệu nhân viên thật khi chưa được đơn vị cho phép và chưa đánh giá bảo mật.
