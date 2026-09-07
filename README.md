# Canva Access Manager v6.2

Perbaikan checker:
- Node 22 untuk GitHub Actions.
- Session detection dibuat lebih ketat agar halaman Canva yang valid tidak salah dianggap logout.
- Scanner membaca email dari DOM, HTML, dan response JSON/GraphQL Canva.
- Log GitHub Actions sekarang menampilkan URL akhir, title, jumlah email dari tiap sumber, dan alasan jika scan kosong.
- Snapshot email tetap disimpan ke Supabase dan ditampilkan di Mini App Admin.

## Setelah upload ke GitHub
Jalankan workflow baru dari Actions > Canva Daily Checker > Run workflow.

Pada log `Run Canva checker`, cari baris:
- `[scan] detected=...`
- `[scan] member_scan_empty...`
- `[scan] session_needs_reauth`

Jaga Auto Remove tetap OFF sampai jumlah email yang terdeteksi sesuai dengan member Canva.
