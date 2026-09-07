# Canva Access Manager v4

Perbaikan utama:
- Admin Mini App tetap tampil.
- Tombol admin **Cek daftar email tim** untuk melihat hasil scan email anggota per akun Canva.
- Tombol diberi animasi tekan dan loading.
- Checker menyimpan snapshot email anggota ke tabel `canva_member_snapshots`.
- Checker tetap berjalan setiap 24 jam (GitHub Actions / worker).
- Error redeem lebih jelas jika SQL belum terpasang.

## Penting saat upgrade dari v3
Jalankan ulang file `sql/schema.sql` di Supabase karena v4 menambah tabel:
- `canva_member_snapshots`

## Session file di admin
Isi dengan path file di bucket Supabase Storage, contoh:
- `sessions/akun-1.json`
- `sessions/akun-2.json`

Bukan isi JSON cookie mentah.

## Jika user mendapat "Terjadi kesalahan pada server"
Biasanya salah satu dari:
1. SQL schema belum dijalankan penuh.
2. Token dibuat sebelum akun/paket valid.
3. Function `redeem_canva_token` belum ada di database.
4. Vercel masih memakai env lama.

Lihat log Vercel pada function `/api/redeem` untuk detail.
