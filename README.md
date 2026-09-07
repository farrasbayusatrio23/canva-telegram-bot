# Canva Access Manager v6.5

Perbaikan utama: scanner tidak lagi menggabungkan semua email dari DOM + HTML + network. Pada v6.4 sebuah tim dengan 11 anggota bisa terdeteksi 28 email karena alamat email non-member ikut terbaca.

V6.5 menggunakan strict member-row sources dan hanya menganggap scan terpercaya bila jumlah email dari satu sumber cocok dengan jumlah anggota yang Canva tampilkan. Jika Canva menampilkan 11 anggota tetapi sumber terbaik berisi 22/28 email, scan diblokir dengan `member_count_mismatch` dan Auto Remove tidak dijalankan.

Untuk local checker tetap gunakan Chrome CDP dan `.env.local`. Biarkan Auto Remove OFF sampai log menunjukkan `trusted=true` dan `selected_count` sama dengan `member_count_hint`.
