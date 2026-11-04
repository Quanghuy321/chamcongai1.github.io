import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def request_api(method, path, payload=None, timeout=10):
    base_url = os.getenv("COMPANY_API_BASE_URL", "").strip()
    if not base_url:
        raise ValueError("Chưa cấu hình COMPANY_API_BASE_URL.")

    parsed_base = urlsplit(base_url)
    if parsed_base.scheme not in ("http", "https") or not parsed_base.netloc:
        raise ValueError("COMPANY_API_BASE_URL phải là URL http:// hoặc https:// hợp lệ.")

    path = path.strip()
    parsed_path = urlsplit(path)
    if not path or parsed_path.scheme or parsed_path.netloc:
        raise ValueError("Đường dẫn API phải là đường dẫn tương đối, ví dụ /health.")

    token = os.getenv("COMPANY_API_TOKEN", "").strip()
    if token and parsed_base.scheme != "https":
        raise ValueError("Chỉ gửi COMPANY_API_TOKEN qua HTTPS.")

    url = base_url.rstrip("/") + "/" + path.lstrip("/")
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "-".join(("Bea", "rer")) + " " + token

    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, data=body, headers=headers, method=method.upper())
    try:
        with urlopen(request, timeout=timeout) as response:
            response_body = response.read().decode("utf-8")
            return response.status, response_body
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"API trả về HTTP {error.code}: {detail or error.reason}"
        ) from error
    except (URLError, TimeoutError) as error:
        raise ConnectionError(f"Không kết nối được tới API: {error}") from error


def main():
    health_path = os.getenv("COMPANY_API_HEALTH_PATH", "/health")
    try:
        status, body = request_api("GET", health_path)
    except (ValueError, RuntimeError, ConnectionError) as error:
        print(f"Kết nối thất bại: {error}", file=sys.stderr)
        return 1

    print(f"Kết nối thành công (HTTP {status}).")
    if body:
        print("Phản hồi:", body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
