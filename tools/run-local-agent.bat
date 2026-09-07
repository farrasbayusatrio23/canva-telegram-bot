@echo off
cd /d "%~dp0\.."
if not exist .env.local (
  echo File .env.local belum ada. Copy .env.local.example menjadi .env.local lalu isi nilainya.
  pause
  exit /b 1
)
node --env-file=.env.local worker\check-canva.js
