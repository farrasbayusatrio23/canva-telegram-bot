# Canva Access Manager v6.3

Perbaikan checker untuk Canva `/settings/people`:

- menunggu UI People selesai dimuat lebih lama
- membaca jumlah anggota dari teks seperti `11 anggota`, `People (11)`, atau `11 members`
- membaca email dari DOM, row/table/list item, HTML, network response
- fallback membuka row/member detail satu per satu untuk mencari email yang disembunyikan di panel detail
- jika Canva tetap menyembunyikan email tetapi jumlah anggota terlihat, status menjadi `member_emails_hidden` dan **Auto Remove tidak dijalankan**
- snapshot lama tidak dihapus saat scan kosong
- tidak mencetak daftar email mentah ke log GitHub

## Upgrade
Replace project GitHub dengan v6.3 lalu buat run baru dari Actions -> Canva Daily Checker -> Run workflow. Jangan re-run commit lama.

## Interpretasi log
- `member_count_hint=11` + `detected=11` => sukses penuh
- `member_count_hint=11` + `detected=0` => Canva menampilkan jumlah member tetapi menyembunyikan email dari halaman/DOM; worker akan mencoba membuka detail row lalu berhenti aman jika masih tidak menemukan email
- `member_count_hint=0` + `member_scan_empty` => halaman yang dibuka tidak menampilkan daftar member atau session/team context salah

Biarkan Auto Remove OFF sampai `detected` sama/masuk akal dengan jumlah anggota aktual.
