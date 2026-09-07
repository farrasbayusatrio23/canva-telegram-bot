# Canva Access Manager v2

Telegram Bot + Telegram Mini App + Supabase + Canva Checker multi-account.

## Alur yang dibangun

### Admin

1. Admin membuka Mini App dari bot.
2. Admin membuat konfigurasi **Akun Canva 1**, **Akun Canva 2**, dst.
3. Setiap akun punya:
   - URL daftar member Canva
   - link undangan publik
   - file session Canva sendiri di Supabase Storage
   - daftar email owner/admin yang tidak boleh dihapus
   - switch auto-remove
4. Admin membuat paket, misalnya 30 hari / 90 hari / 180 hari.
5. Admin memilih **akun + paket**, lalu generate token akses.
6. Token utuh hanya tampil sekali saat dibuat. Database hanya menyimpan hash token.

### User

Cara paling sederhana melalui chat Telegram:

1. User kirim token seperti `CVA-...`.
2. Bot memvalidasi token lalu meminta email Canva.
3. User mengirim email.
4. Token di-redeem secara atomik di Supabase.
5. Bot mengirim:
   - email Canva
   - akun Canva yang didapat
   - nama paket
   - masa aktif
   - link undangan publik akun tersebut
6. `/status` menampilkan akses user.

User juga dapat redeem token dari Mini App.

### Checker

Worker terpisah:

1. Membaca semua akun Canva aktif dari Supabase.
2. Membuka halaman member masing-masing akun memakai session file akun tersebut.
3. Membaca email yang terlihat di daftar member.
4. Membandingkan dengan `canva_access` yang statusnya aktif dan belum expired.
5. Email protected tidak pernah dianggap unauthorized.
6. Email lain yang tidak punya akses aktif dicatat ke `canva_audit`.
7. Jika `auto_remove=true` pada akun tersebut, worker mencoba mengeluarkan member itu melalui UI Canva.

> Canva Business tidak memiliki API provisioning/removal publik yang stabil seperti Enterprise. Pengecekan/removal pada project ini memakai browser automation. UI Canva dapat berubah. Jangan mencoba melewati CAPTCHA/MFA.

---

# 1. Supabase

Buka **SQL Editor** dan jalankan seluruh isi:

`sql/schema.sql`

Jika sebelumnya kamu memakai project v1, tabel `canva_access` lama otomatis di-rename menjadi `canva_access_legacy_v1` agar data lama tidak dihapus.

Tabel utama v2:

- `canva_accounts`
- `canva_packages`
- `canva_access_tokens`
- `canva_access`
- `telegram_states`
- `canva_audit`

Pastikan bucket Storage private sudah ada:

`canva-private`

---

# 2. Buat session untuk setiap akun Canva

Contoh Akun Canva 1.

Tutup semua Chrome, lalu buka Chrome khusus:

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\canva-profile-1"
```

Login Canva secara normal pada Chrome itu. Jangan bypass MFA/CAPTCHA.

Di folder project:

```bat
npm install
npm run export-session -- akun-1
```

Hasil:

`data/akun-1.json`

Upload ke Supabase Storage private:

`canva-private/sessions/akun-1.json`

Untuk akun kedua, ulangi dengan profile berbeda:

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\canva-profile-2"
```

Login akun Canva 2 lalu:

```bat
npm run export-session -- akun-2
```

Upload sebagai:

`canva-private/sessions/akun-2.json`

Jangan upload file session ke GitHub.

---

# 3. GitHub

Buat repository private lalu upload isi folder project ini.

Jangan commit:

- `.env`
- `data/*.json`
- token bot
- Supabase service role key

`.gitignore` sudah disiapkan.

---

# 4. Vercel

Import repository GitHub ke Vercel.

Framework preset: **Other**.

Environment Variables:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_SIDE_SECRET
TELEGRAM_BOT_TOKEN=123456789:AA...
MINIAPP_URL=https://project-kamu.vercel.app
ADMIN_TELEGRAM_IDS=123456789
```

Jika admin lebih dari satu:

```env
ADMIN_TELEGRAM_IDS=123456789,987654321
```

`ADMIN_TELEGRAM_IDS` adalah Telegram numeric user ID, bukan username.

Setelah domain Vercel tersedia, isi `MINIAPP_URL` dengan domain tersebut lalu Redeploy.

---

# 5. Telegram webhook

Endpoint webhook:

`https://DOMAIN-VERCEL/api/telegram`

Cara sederhana memasangnya:

`https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://DOMAIN-VERCEL/api/telegram`

Jangan membagikan URL yang berisi token bot.

Opsional untuk keamanan tambahan, isi:

```env
TELEGRAM_WEBHOOK_SECRET=string-rahasia-random
```

Jika memakai secret webhook, set `secret_token` yang sama saat memanggil Telegram `setWebhook`.

---

# 6. Setting akun lewat Mini App

Sebagai admin kirim:

`/admin`

Klik **Buka Panel Admin**.

Untuk Akun Canva 1 isi contoh:

- Nama: `Canva 1`
- Slug: `canva-1`
- Members URL: URL halaman member akun/tim tersebut
- Invite URL: link undangan publik tim tersebut
- Storage bucket: `canva-private`
- Session file: `sessions/akun-1.json`
- Protected emails: email owner/admin akun Canva 1
- Akun aktif: ON
- Auto-remove: **OFF dulu**

Untuk akun kedua:

- Nama: `Canva 2`
- Session file: `sessions/akun-2.json`
- Members URL / Invite URL milik akun kedua

Seterusnya sama.

---

# 7. Buat paket

Di Panel Admin buat, misalnya:

- `30 Hari` -> 30
- `90 Hari` -> 90
- `180 Hari` -> 180

Durasi akses dihitung ketika token diredeem.

Jika user memakai token baru pada email yang sama dan aksesnya masih aktif, durasi baru akan **menambah dari tanggal expiry lama**, bukan mulai ulang dari hari ini.

---

# 8. Generate token

Di bagian **Buat token akses**:

1. Pilih Akun Canva.
2. Pilih Paket.
3. Pilih jumlah token.
4. `Maks. penggunaan per token = 1` untuk token sekali pakai.
5. Generate.

Contoh token:

`CVA-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

Token utuh hanya dikembalikan sekali oleh server saat dibuat. Database hanya menyimpan SHA-256 hash dan hint token.

---

# 9. Penggunaan user

User cukup chat ke bot:

```text
CVA-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Bot menjawab meminta email.

User:

```text
user@gmail.com
```

Bot akan menjawab contoh:

```text
Akses berhasil diaktifkan.

Email: user@gmail.com
Akun Canva: Canva 2
Paket: 90 Hari (90 hari)
Aktif sampai: ...

Link undangan:
https://www.canva.com/...
```

User dapat cek lagi dengan:

`/status`

---

# 10. Jalankan Canva Checker

Checker **jangan dijalankan sebagai proses permanen di Vercel**. Jalankan pada Windows/VPS/Render/Railway/container yang mendukung Chromium.

Install:

```bash
npm install
npx playwright install chromium
```

Isi environment worker:

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_BOT_TOKEN=...
ADMIN_TELEGRAM_IDS=123456789
CHECK_INTERVAL_MS=60000
HEADLESS=true
```

Tes satu kali:

```bash
npm run worker:once
```

Lihat:

- output terminal
- tabel `canva_audit`
- `last_seen_in_canva` pada `canva_access`

Pada tahap ini semua akun harus tetap:

`auto_remove = false`

Jika scanner sudah benar-benar membaca member sesuai akun, baru aktifkan **Auto-remove** dari Panel Admin untuk akun yang kamu inginkan.

Jalankan terus:

```bash
npm run worker
```

Interval minimum di code adalah 60 detik.

---

# Safety auto-remove

Sebelum mengaktifkan auto-remove:

1. Masukkan semua Owner/Admin Canva ke **Protected emails**.
2. Pastikan URL member benar untuk masing-masing akun.
3. Pastikan session file sesuai akun.
4. Tes dengan `auto_remove=false`.
5. Periksa tabel `canva_audit` dan daftar `unauthorized_detected`.
6. Baru aktifkan auto-remove pada satu akun terlebih dahulu.

Jika UI Canva berubah dan tombol remove tidak ditemukan, worker mencatat `remove_failed` daripada mencoba tindakan lain secara acak.
