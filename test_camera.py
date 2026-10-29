
import requests

CAMERA_URL = "http://10.10.20.133:8080"

try:
    response = requests.get(CAMERA_URL, timeout=5)
    print("Ket noi thanh cong!")
    print("HTTP status:", response.status_code)

except requests.exceptions.RequestException as error:
    print("Chua ket noi duoc camera.")
    print("Chi tiet loi:", error)
