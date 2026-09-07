# Canva Access Manager v6.6

V6.6 fokus pada perapihan Mini App dan bot Telegram tanpa mengubah mekanisme Local Checker v6.5 yang sudah berhasil membaca 11 anggota secara trusted.

## Yang baru

- Admin Mini App sekarang memakai submenu/halaman terpisah:
  - Dashboard
  - Daftar Email Tim
  - Akun Canva
  - Paket
  - Token
  - Akses User
  - Audit
- Tampilan responsive dan lebih rapi untuk Telegram mobile maupun desktop.
- Akun Canva dapat diedit dari kartu akun dengan tombol **Edit akun**.
- Paket juga dapat diedit dari halaman Paket.
- Halaman Email Tim memiliki tombol **Muat Snapshot** dan **Scan Sekarang**.
- Dashboard memiliki shortcut cepat ke menu penting dan status checker tiap akun.
- Halaman Akses User memiliki pencarian.
- Bot Telegram dirapikan dengan format HTML, emoji, tombol Status, Panduan, Mini App, Panel Admin, dan tombol link undangan setelah redeem berhasil.
- Deep-link Mini App memakai hash seperti `#admin/accounts` sehingga tiap submenu bisa dibuka langsung.

## Upgrade dari v6.5

Tidak ada perubahan SQL wajib untuk upgrade UI ini.

Replace file project dengan v6.6, terutama:

- `public/index.html`
- `api/telegram.js`
- `package.json`

Lalu commit ke `main` dan redeploy Vercel.

Local Checker tetap dijalankan seperti v6.5:

```bat
node --env-file=.env.local worker\check-canva.js
```

Biarkan Chrome CDP checker tetap terbuka. Konfigurasi `.env.local`, Supabase, dan Local Checker tidak perlu diubah hanya karena upgrade ke v6.6.
