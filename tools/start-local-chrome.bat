@echo off
REM Contoh untuk akun dengan slug "mamangnya".
REM Login Canva sekali di Chrome yang terbuka. Jika ada verifikasi keamanan, selesaikan manual.
start "Canva Mamangnya" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\canva-checker-mamangnya" "https://www.canva.com/settings/people"
