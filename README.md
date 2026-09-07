# Canva Access Manager v3

Telegram Bot + Mini App + Supabase + Vercel + GitHub Actions daily Canva checker.

## Alur user

1. User mengirim token `CVA-...` ke bot Telegram.
2. Bot meminta email Canva.
3. Token menentukan **akun Canva** dan **paket/durasi**.
4. Akses disimpan ke Supabase.
5. Bot mengirim email, nama akun Canva, paket, masa aktif, dan public invite link.
6. `/status` menampilkan akses user.

Mini App juga dapat redeem token dan menampilkan status yang sama.

## Alur admin

Tab **Admin selalu terlihat** di Mini App. API tetap memverifikasi Telegram Mini App `initData` dan `ADMIN_TELEGRAM_IDS`, jadi user biasa tidak dapat menggunakan fungsi admin.

Admin dapat:

- membuat/mengedit Akun Canva 1, Akun Canva 2, dst;
- memasang URL daftar member + public invite link per akun;
- memilih file session Supabase per akun;
- memasukkan email Owner/Admin yang tidak boleh dikeluarkan;
- mengaktifkan/nonaktifkan daily checker per akun;
- mengaktifkan Auto Remove per akun;
- membuat paket 30/90/180 hari, dll;
- generate token per akun + paket;
- melihat akses user;
- melihat hasil scan checker dan audit penghapusan.

## Mengapa Admin sebelumnya tidak terlihat

v3 tidak lagi menyembunyikan tombol Admin secara diam-diam. Jika akun belum diizinkan, panel menjelaskan Telegram ID mana yang harus dimasukkan ke `ADMIN_TELEGRAM_IDS`.

Kirim ke bot:

```
/id
```

Lalu pasang ID tersebut di:

- Vercel -> Project -> Settings -> Environment Variables -> `ADMIN_TELEGRAM_IDS`
- GitHub -> Repository -> Settings -> Secrets and variables -> Actions -> `ADMIN_TELEGRAM_IDS`

Redeploy Vercel setelah mengubah Environment Variable.

## 1. Upgrade database Supabase

Buka Supabase -> SQL Editor. Jalankan seluruh isi:

```
sql/schema.sql
```

Script aman untuk instalasi v2: kolom checker v3 menggunakan `add column if not exists`.

Tabel utama:

- `canva_accounts`
- `canva_packages`
- `canva_access_tokens`
- `canva_access`
- `canva_audit`
- `telegram_states`

## 2. Supabase Storage session

Bucket harus private:

```
canva-private
```

Contoh multi akun:

```
canva-private/
  sessions/
    akun-1.json
    akun-2.json
```

Jangan pernah membuat file session public.

## 3. Export session per akun

Buka Chrome khusus dengan remote debugging, login Canva secara normal, lalu:

```
npm install
npm run export-session -- akun-1
```

File hasil:

```
data/akun-1.json
```

Upload ke Supabase Storage sebagai:

```
sessions/akun-1.json
```

Ulangi dengan akun Canva kedua dan profile/session login kedua.

## 4. Vercel Environment Variables

Pasang:

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_BOT_TOKEN=...
MINIAPP_URL=https://PROJECT.vercel.app
ADMIN_TELEGRAM_IDS=123456789
```

`SUPABASE_SERVICE_ROLE_KEY` hanya backend. Jangan ditaruh di frontend.

## 5. Telegram webhook

Set webhook ke:

```
https://DOMAIN-VERCEL/api/telegram
```

Jika menggunakan `TELEGRAM_WEBHOOK_SECRET`, set webhook dengan secret token yang sama.

Bot commands:

- `/start`
- `/status`
- `/admin`
- `/id`
- `/cancel`

## 6. Setting akun Canva di Admin Mini App

Untuk setiap akun isi:

- Nama akun: `Canva 1`
- Slug: `canva-1`
- URL daftar anggota Canva
- Link undangan publik
- Bucket: `canva-private`
- Session file: `sessions/akun-1.json`
- Protected emails: email Owner/Admin Canva
- Akun aktif: ON
- Auto Remove: awalnya OFF

### Penting

Lakukan scan pertama dengan Auto Remove OFF. Setelah `Scan terakhir` menunjukkan jumlah member yang masuk akal, baru aktifkan Auto Remove.

Worker memakai safety gate: jika scan berikutnya tiba-tiba hanya membaca kurang dari 60% jumlah member scan sebelumnya, penghapusan otomatis diblokir untuk run tersebut. Ini mengurangi risiko penghapusan salah saat UI Canva gagal memuat atau berubah.

## 7. Checker otomatis setiap 24 jam via GitHub Actions

File sudah tersedia:

```
.github/workflows/canva-checker.yml
```

Schedule bawaan:

```
0 1 * * *
```

Itu berarti setiap hari pukul **08:00 WIB**.

Di GitHub buka:

Repository -> Settings -> Secrets and variables -> Actions

Buat Repository Secrets:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
ADMIN_TELEGRAM_IDS
```

Kemudian buka tab **Actions -> Canva Daily Checker -> Run workflow** untuk test manual pertama.

GitHub Actions akan:

1. install Node;
2. install Chromium Playwright;
3. download session akun dari private Supabase Storage;
4. membuka URL member masing-masing akun Canva;
5. membaca email member;
6. menandai akses expired;
7. membandingkan email member dengan `canva_access` aktif untuk akun tersebut;
8. mengabaikan `protected_emails`;
9. jika `auto_remove=ON`, mencoba mengeluarkan email yang tidak punya akses aktif;
10. menyimpan hasil ke `canva_audit` dan `canva_accounts.last_scan_*`;
11. mengirim ringkasan ke Telegram admin.

## Aturan checker

Email Canva dianggap BERIZIN jika semua benar:

- ada di `canva_access` untuk akun Canva yang sedang diperiksa;
- status `active`;
- `ends_at` belum lewat.

Email dianggap TIDAK BERIZIN jika:

- sama sekali tidak ada di database untuk akun itu; atau
- akses `expired`, `blocked`, atau `removed`; atau
- masa paket sudah habis.

Email dalam `protected_emails` tidak pernah menjadi target penghapusan.

## Batasan Canva Business

Canva Business tidak menyediakan API public provisioning/removal setara Canva Enterprise. Checker ini menggunakan browser automation terhadap halaman member milik akun admin. Karena UI Canva dapat berubah, fitur penghapusan dibuat konservatif, diaudit, dan memiliki safety gate. Script tidak mencoba melewati CAPTCHA atau MFA. Jika session habis, checker memberi notifikasi `session_needs_reauth` agar session diexport ulang.
