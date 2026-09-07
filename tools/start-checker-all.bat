@echo off
cd /d "%~dp0\.."

REM Akun contoh: slug Mamangnya -> port 9222.
REM Untuk akun kedua, copy baris start Chrome dan gunakan port/profile berbeda, misalnya 9223.
start "Canva Mamangnya" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\canva-checker-mamangnya" "https://www.canva.com/settings/people"

timeout /t 8 /nobreak >nul

if not exist .env.local (
  echo File .env.local belum ada. Copy .env.local.example menjadi .env.local lalu isi nilainya.
  pause
  exit /b 1
)

node --env-file=.env.local worker\check-canva.js
