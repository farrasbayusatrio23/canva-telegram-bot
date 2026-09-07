# Canva Access Manager v6.4 — Local Chrome Checker

## Kenapa v6.3 gagal di GitHub Actions?
Jika log menunjukkan `title=Just a moment...`, browser GitHub-hosted runner sedang mendapat halaman verifikasi keamanan Canva. Itu bukan halaman daftar member, jadi checker tidak mungkin membaca 11 email dari sana. Session JSON saja tidak menghilangkan verifikasi berbasis browser/IP.

v6.4 mempertahankan Vercel + Supabase + Mini App, tetapi pemindaian Canva dilakukan oleh Chrome normal di PC Windows Anda. Tidak ada bypass CAPTCHA/MFA: jika Canva meminta verifikasi, selesaikan secara manual di profile Chrome checker.

## 1. Jalankan SQL v6.4
Supabase -> SQL Editor -> jalankan seluruh `sql/schema.sql`.
Tabel baru: `canva_scan_requests`.

## 2. Vercel
Tambahkan Environment Variable:
`CHECKER_TRIGGER_MODE=local`
Lalu redeploy.

GITHUB_* tidak lagi diperlukan untuk tombol scan jika mode local dipakai.

## 3. Siapkan Chrome checker di Windows
Jalankan:
`tools\start-local-chrome.bat`

Chrome akan memakai profile `C:\canva-checker-mamangnya` dan port 9222. Login Canva secara normal lalu buka halaman People. Jika muncul halaman verifikasi keamanan, selesaikan manual.

Untuk akun kedua, buat profile/port berbeda, misalnya 9223.

## 4. Buat .env.local
Copy `.env.local.example` menjadi `.env.local` dan isi secret Supabase/Telegram.
Contoh mapping multi akun:
`CANVA_CDP_MAP=mamangnya=http://127.0.0.1:9222,akun-2=http://127.0.0.1:9223`
Slug harus sama dengan slug akun di Mini App Admin.

Jangan upload `.env.local` ke GitHub.

## 5. Jalankan Local Checker Agent
`tools\run-local-agent.bat`

Agent akan:
- scan semua akun ketika start;
- scan penuh otomatis setiap 24 jam;
- mengecek permintaan tombol Mini App setiap 15 detik.

Jendela CMD harus tetap hidup. Untuk otomatis setelah login Windows, buat Task Scheduler dengan trigger `At log on` yang menjalankan `tools\run-local-agent.bat`.

## 6. Mini App
Admin -> Daftar email di tim -> Cek daftar email tim.
Vercel membuat request di Supabase. Local Agent mengambil request, memakai Chrome normal yang sudah login, scan member, lalu menyimpan snapshot ke Supabase. Mini App akan polling hasilnya.

## Keamanan
- Auto Remove tetap OFF sampai scanner benar-benar menemukan seluruh anggota.
- Protected Emails wajib berisi Owner/Admin.
- Jangan bypass CAPTCHA/MFA/security challenge.
- Repository dan bucket session sebaiknya private.
