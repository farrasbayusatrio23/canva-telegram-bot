# Canva Access Manager v5

v5 memperbaiki bug aktivasi token setelah email dikirim.

## Bug yang diperbaiki
Flow token sebelumnya berhasil sampai "Token valid", lalu gagal ketika email dikirim karena tahap kedua memanggil RPC database. SQL lama menggunakan `RETURNS TABLE` dengan nama output yang sama seperti beberapa nama kolom. Pada PL/pgSQL ini dapat menyebabkan referensi kolom menjadi ambigu pada saat redeem.

v5 memakai `redeem_canva_token_v2` yang:
- menerima email sebagai `text`,
- mengembalikan satu `jsonb`,
- menghindari output-variable collision,
- tetap melakukan redeem secara atomik dengan row lock,
- tetap menambah durasi jika email yang sama memperpanjang paket.

## Upgrade dari v3/v4
1. Supabase -> SQL Editor.
2. Jalankan seluruh file `sql/fix-redeem-v5.sql`.
3. Replace project GitHub dengan v5.
4. Redeploy Vercel menggunakan Environment Variables yang sekarang.
5. Buat TOKEN BARU untuk test pertama.

## Jika masih gagal
Admin Telegram akan menerima detail error database langsung pada chat jika akun Telegram tersebut masuk `ADMIN_TELEGRAM_IDS`. Detail juga dicetak ke Vercel Function Logs dengan prefix:

- `[telegram redeem]`
- `[redeem]`

## Fitur lain
- Multi akun Canva.
- Paket dan token per akun.
- Mini App user/admin.
- Tombol loading dan animasi tekan.
- Daftar email tim dari hasil checker.
- Checker harian GitHub Actions.
- Auto-remove per akun dengan protected email dan safety gate.
