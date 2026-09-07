# Canva Telegram Bot + Mini App

Alur:
1. User `/start` di Telegram.
2. Bot membuka Mini App.
3. User memasukkan email Canva.
4. Email disimpan di Supabase sebagai whitelist.
5. User langsung menerima link undangan publik Canva.
6. Worker membandingkan email anggota Canva dengan whitelist.
7. Email yang tidak ada di whitelist dicatat dan dapat dicoba dihapus otomatis.

## Arsitektur
- Vercel: Telegram webhook + Mini App + API.
- Supabase: database whitelist/audit + `canva-storage.json`.
- Worker Node.js/Playwright: jalan di PC/VPS/Railway/Render.

## Supabase
Jalankan `sql/schema.sql`.

Bucket private:
- `canva-private`
- `canva-storage.json`

## Environment Vercel
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `MINIAPP_URL`
- `CANVA_PUBLIC_INVITE_URL`

## Deploy
Upload ke GitHub, import ke Vercel, isi env, deploy.

Set webhook Telegram:
`https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://DOMAIN.vercel.app/api/telegram`

## Worker
Install:
`npm install`
`npx playwright install chromium`

Isi:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_ID`
- `CANVA_STORAGE_BUCKET=canva-private`
- `CANVA_STORAGE_FILE=canva-storage.json`
- `CANVA_MEMBERS_URL=...`
- `CANVA_PROTECTED_EMAILS=owner@example.com`
- `AUTO_REMOVE=false`

Tes:
`node worker/check-canva.js --once`

Biarkan `AUTO_REMOVE=false` sampai deteksi anggota sudah benar. Setelah itu baru aktifkan `AUTO_REMOVE=true`.

Catatan: Canva Business tidak menyediakan API provisioning/removal publik seperti Enterprise, jadi checker/remove memakai browser automation dan bisa perlu penyesuaian jika UI Canva berubah. Jangan bypass CAPTCHA/MFA.
