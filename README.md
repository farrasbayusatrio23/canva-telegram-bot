# Canva Access Manager v6

## Bug utama yang diperbaiki

Versi v5 memiliki bug pada regex email di `worker/check-canva.js`: karakter `\b` berubah menjadi karakter backspace tersembunyi. Akibatnya checker selalu mendapatkan **0 email**, walaupun Canva menampilkan anggota.

v6 mengganti regex dengan regex email yang valid dan menambah beberapa sumber pembacaan DOM:

- body `innerText`
- body `textContent`
- link `mailto:`
- `aria-label`
- `title`
- nilai input
- scrolling pada area virtualized/table/grid

## Tombol Cek daftar email tim

Di v6 tombol ini dapat:

1. Menampilkan snapshot email terakhir dari Supabase.
2. Menjalankan GitHub Actions checker khusus akun yang dipilih.
3. Polling hasil scan sampai checker selesai.
4. Menampilkan daftar email hasil scan di Mini App.

Agar tombol dapat menjalankan checker langsung, tambahkan Environment Variables berikut di Vercel:

```env
GITHUB_ACTIONS_TOKEN=github_pat_xxxxxxxxx
GITHUB_REPO=OWNER/NAMA_REPO
GITHUB_BRANCH=main
GITHUB_CHECKER_WORKFLOW=canva-checker.yml
```

`GITHUB_ACTIONS_TOKEN` sebaiknya Fine-grained Personal Access Token yang hanya memiliki akses ke repository project ini dan permission **Actions: Read and write**.

Jangan kirim token GitHub kepada orang lain dan jangan menaruhnya di frontend.

## GitHub Actions Secrets

Repository GitHub tetap membutuhkan:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
ADMIN_TELEGRAM_IDS
```

## Upgrade dari v5

Tidak ada tabel baru jika `canva_member_snapshots` sudah dibuat oleh v5. Tetapi aman untuk menjalankan ulang:

`sql/schema.sql`

Kemudian replace project GitHub dengan v6 dan redeploy Vercel.

## Test yang disarankan

1. Auto Remove **OFF** dulu.
2. Pastikan akun Canva memiliki Members URL yang benar.
3. Pastikan session file ada di bucket private Supabase.
4. Buka Admin -> Daftar email di tim.
5. Pilih akun Canva.
6. Tekan **Cek daftar email tim**.
7. Tunggu GitHub Actions selesai. Mini App akan polling hasil hingga sekitar 3 menit.
8. Pastikan jumlah terdeteksi sesuai Canva sebelum menyalakan Auto Remove.

## Jika hasil tetap 0

Lihat Admin -> Checker 24 jam. Kolom `last_scan_error` sekarang akan menunjukkan error, misalnya:

- `session_needs_reauth`
- `member_scan_empty`

Jika `member_scan_empty`, cek **Audit checker**. v6 menyimpan diagnostic URL, title, dan sample body halaman untuk membantu mengetahui apakah Members URL mengarah ke halaman yang salah atau session Canva sudah tidak memiliki akses ke halaman member.

## Keamanan Auto Remove

Auto Remove tetap dilindungi oleh:

- Protected Emails untuk Owner/Admin
- safety gate jika jumlah member turun drastis
- scan kosong tidak menghapus snapshot lama
- scan kosong tidak melakukan penghapusan

Aktifkan Auto Remove hanya setelah jumlah member yang terbaca sudah benar.
