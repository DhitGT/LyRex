# PRD — Lyric Extractor

**Versi 0.2 · Draft MVP · 19 November 2026**

## 1. Ringkasan produk

Lyric Extractor adalah web app yang mengubah lagu menjadi draft lirik dengan timestamp per baris. Pengguna memasukkan audio, mendengarkan hasil pemisahan vokal, lalu mengoreksi teks dan timing di editor. Hasilnya bisa dipakai sebagai subtitle, lirik sinkron, atau data untuk aplikasi lain.

Target awalnya kreator yang punya rekaman sendiri atau izin untuk mengolah audio, serta developer yang butuh lirik bertimestamp untuk pemutar musik atau video. Pekerjaan utama yang dipangkas adalah mendengar bagian lagu berulang kali sambil mengetik lirik dan mencatat timing secara manual.

## 2. Alur pengguna

1. Buat proyek dan unggah MP3, WAV, atau M4A. Jika ada video referensi, link YouTube bisa ditambahkan dari pengaturan tambahan atau editor.
2. Tekan **Ekstrak lirik**. Deteksi bahasa berjalan otomatis, dengan opsi memilih Indonesia atau Inggris.
3. Aplikasi memvalidasi audio, memisahkan vokal dari instrumen, menjalankan speech-to-text, lalu menyusun hasilnya menjadi baris lirik.
4. Buka editor. Putar **Audio asli** atau **Vokal saja**, klik baris untuk lompat ke bagian tersebut, dan koreksi teks atau timing sambil mendengarkan.
5. Jika versi YouTube memakai intro tambahan, atur selisih waktu melalui titik referensi. Cek sinkronisasi pada player YouTube.
6. Ekspor draft hasil koreksi dalam format LRC, SRT, atau JSON.

**Sumber audio dan preview.** Pemisahan vokal dan transkripsi berjalan sebagai job setelah unggahan selesai. Istilah streaming di MVP merujuk pada pemutaran YouTube melalui IFrame Player resmi. Stream itu berfungsi sebagai referensi putar. Pemrosesan menggunakan file audio yang pengguna miliki atau punya izin untuk olah. Impor langsung dari layanan lain bisa masuk setelah tersedia integrasi yang secara eksplisit mengizinkan pengambilan dan pemrosesan audio. Lihat [kebijakan API YouTube](https://developers.google.com/youtube/terms/developer-policies-guide) dan [referensi IFrame Player](https://developers.google.com/youtube/iframe_api_reference).

## 3. Spesifikasi MVP

| Fitur | Kebutuhan |
|---|---|
| Impor audio | Satu lagu per proyek. Batas beta usulan 10 menit dan 100 MB. Validasi durasi dan format berdasarkan hasil decode. Tampilkan alasan jika file gagal diproses. |
| Pemisahan vokal | Hasilkan stem vokal yang mempertahankan posisi waktu audio asli. Pengguna bisa berganti antara audio asli dan vokal pada posisi putar yang sama. Stem bisa berisi backing vocal, harmoni, dan sisa instrumen. |
| Transkripsi | Jalankan model multibahasa pada stem vokal. Susun segmen menjadi baris yang bisa diedit. Tandai bagian yang perlu diperiksa berdasarkan sinyal model. Simpan timing per kata jika tersedia. |
| Editor lirik | Waveform dan playhead, highlight baris aktif, serta daftar teks dengan kolom mulai dan selesai. Mendukung tambah, hapus, pisah, gabung baris, putar ulang satu baris, dan tombol untuk mengambil waktu playhead sebagai awal atau akhir baris. Simpan perubahan otomatis dan tampilkan status simpan. |
| Referensi YouTube | Preview opsional menggunakan embed. Highlight mengikuti waktu player. Pengguna mengalibrasi offset dengan mencocokkan satu titik yang sama di audio dan video. Jika embed gagal, proyek audio tetap bisa diedit. |
| Ekspor | LRC untuk waktu mulai per baris, SRT untuk rentang mulai–selesai, dan JSON untuk rentang dalam milidetik serta timing kata yang masih valid. Pengguna bisa memilih basis waktu audio atau versi video yang telah dikalibrasi. |

## 4. Desain dan pengalaman pengguna

### Arah visual

Ambil inspirasi dari [Kizupi di One Page Love](https://onepagelove.com/kizupi), terutama latar krem, sudut membulat, warna alami, dan ilustrasi pixel art. Identitas Lyric Extractor memakai ikon gelombang audio dan ilustrasi kaset pixel orisinal. Ilustrasi hadir di layar awal dan keadaan kosong. Di editor, warna aksen menandai aksi utama, fokus, dan baris yang sedang diputar.

| Elemen | Spesifikasi desain |
|---|---|
| Warna | Latar krem `#FAF7EE`, permukaan `#FFFDF8`, teks gelap `#272319`, aksen kuning madu `#F5D474` dengan teks gelap, highlight baris hijau lembut `#E5EEDB`. |
| Tipografi | Bricolage Grotesque untuk judul dan Atkinson Hyperlegible untuk teks, label, dan editor. Gunakan angka tabular untuk timestamp agar posisi digit stabil saat berubah. |
| Komponen | Kartu dengan radius 16–24 px, border tipis, bayangan ringan, dan ruang antarelemen yang lega. Tombol utama berlabel teks. Ikon tunggal punya nama aksesibel. |
| Animasi | Transisi ringan untuk perubahan status dan highlight. Hormati preferensi pengurangan animasi sistem. |

### Tata letak per layar

| Layar | Tampilan dan interaksi |
|---|---|
| **Mulai** | Logo kecil, judul **Ubah lagu jadi lirik bertimestamp**, dan satu kartu unggah di tengah. Kartu menerima klik atau drag-and-drop, menampilkan format yang didukung, lalu memperlihatkan nama file dan tombol **Ganti file** setelah dipilih. Tombol utama **Ekstrak lirik**. Deteksi bahasa otomatis menjadi default. Pilihan bahasa dan link YouTube opsional tersedia di bagian **Pengaturan tambahan**. Link YouTube juga bisa ditambahkan dari editor. |
| **Sedang diproses** | Kartu yang sama menampilkan nama file dan tahap aktif seperti **Memisahkan vokal** atau **Menyusun lirik**. Gunakan indikator tak tentu jika progres persentase belum bisa diukur. Jika gagal, tampilkan alasan singkat dan aksi pemulihan di tempat yang sama. |
| **Editor** | Header ringkas berisi nama proyek, status autosave, dan tombol **Ekspor**. Waveform dan kontrol play/pause tampil di atas daftar lirik. Pilihan **Asli / Vokal saja** berada di dekat kontrol putar. Setiap baris memperlihatkan interval waktu dan teks. Klik timestamp untuk lompat, klik teks untuk mengedit. Saat baris dipilih, panel detail memperlihatkan waktu mulai dan selesai, tombol **Pakai posisi putar** untuk tiap batas, aksi **Ulangi baris**, serta menu pisah, gabung, dan hapus. Aksi **Tambah baris** tersedia di daftar. |
| **Preview YouTube** | Buka lewat tombol **Video referensi**. Player dan kalibrasi offset tampil di panel samping pada desktop dan panel lipat pada seluler. Letakkan tombol kalibrasi dekat petunjuk pencocokan waktu audio dan video. |
| **Ekspor** | Dialog ringkas dengan pilihan **LRC** untuk lirik sinkron, **SRT** untuk subtitle, dan **JSON** untuk integrasi. Basis waktu audio menjadi default. Pilihan basis waktu video muncul setelah video dikalibrasi. |

### Kenyamanan dan aksesibilitas

- Pada desktop, waveform dan lirik memakai area utama, dengan panel detail di sebelah kanan saat diperlukan. Pada seluler, tata letak satu kolom dan pemutar ringkas tetap terjangkau di bagian bawah. Detail timing dibuka sesuai kebutuhan. Saat keyboard seluler terbuka, tata letak menyesuaikan agar baris yang diedit tetap terlihat.
- Baris aktif ditandai dengan latar hijau lembut dan penanda di tepi. Auto-scroll mengikuti lagu saat pengguna sedang menyimak. Saat pengguna menggulir atau mengedit, auto-scroll dijeda dan bisa diaktifkan lagi lewat tombol **Ikuti lagu**.
- Kontrol utama punya area sentuh minimal 44 × 44 px, indikator fokus keyboard yang jelas, dan urutan tab yang logis. Status seperti **Perlu dicek** dan **Gagal menyimpan** tampil sebagai teks. Shortcut play/pause dan seek hanya aktif di luar kolom edit.
- Status autosave tampil dekat nama proyek. Saat penyimpanan gagal, pertahankan perubahan di editor dan tampilkan aksi **Coba simpan lagi**. Pesan kesalahan timing muncul di dekat nilai yang perlu diperbaiki.

## 5. Aturan sinkronisasi

- Simpan waktu mulai dan selesai setiap baris sebagai bilangan bulat dalam milidetik dihitung dari awal file asli. Durasi baris adalah selisih keduanya. Urutkan baris dan validasi agar rentangnya positif, berada dalam durasi media, dan tidak bertumpuk. Highlight aktif dari awal baris hingga sebelum waktu selesai.
- Pertahankan intro, jeda instrumental, dan outro pada timeline. Jika audio dipotong untuk inferensi, petakan timing kembali ke posisi aslinya. Hapus duplikasi hasil di batas potongan, sambil mempertahankan chorus yang memang diulang pada waktu berbeda.
- Offset YouTube dihitung dengan rumus `waktu video − waktu audio`. Contohnya, jika baris mulai di 18,420 detik pada audio dan 20,920 detik pada video, offsetnya +2.500 ms. Terapkan offset hanya saat preview YouTube atau ekspor berbasis waktu video. Tampilkan konflik bila ada cue yang jatuh di luar durasi video dan minta pengguna memperbaikinya sebelum ekspor versi video. Satu offset berlaku untuk versi dengan perbedaan waktu tetap. Video dengan bagian yang dipotong atau aransemen berbeda memerlukan sinkronisasi tambahan di versi mendatang.
- Jika teks atau batas baris berubah, tandai timing kata pada baris terkait sebagai perlu sinkronisasi ulang. Ekspor baris tetap tersedia. JSON menghilangkan timing kata yang sudah tidak valid.

## 6. Penanganan hasil dan kegagalan

- Job menampilkan tahap antre, memisahkan vokal, transkripsi, menyusun lirik, lalu siap, gagal, atau dibatalkan. Setelah halaman dimuat ulang, status job dan revisi editor bisa dibuka kembali.
- Jika pemisahan gagal, pengguna bisa mengulang atau memilih transkripsi dari audio asli. Jika transkripsi gagal, ulangi dari stem yang sudah tersedia. Jika tidak ada lirik yang terdeteksi, tampilkan hasil kosong dan tetap sediakan penambahan baris manual.
- Teks otomatis berstatus draft. Pengguna bisa memeriksa bagian yang ditandai sambil membandingkan vokal dan mix asli. Uji khusus pada reverb, backing vocal, vokal panjang, remix, rap cepat, dan bagian instrumental yang berpotensi memicu lirik palsu.
- Proyek bersifat privat. Penghapusan proyek mencakup audio asli, stem, dan lirik. Hasil job yang selesai setelah proyek dihapus tidak boleh memulihkannya. File kerja sementara dibersihkan setelah job selesai atau gagal.

## 7. Rancangan teknis awal

**Nuxt + Nuxt UI** untuk unggah, pemutar, waveform, dan editor. **FastAPI + worker Python** untuk job audio, dengan penyimpanan privat untuk audio dan stem serta PostgreSQL untuk proyek, status job, dan revisi lirik. **FFmpeg** menangani decode dan normalisasi format sambil menjaga acuan waktu asli. Uji **Demucs** untuk pemisahan vokal dan **faster-whisper** untuk transkripsi multibahasa serta estimasi timestamp kata. Pilihan model diputuskan setelah membandingkan hasil dari audio asli dan stem vokal pada materi uji yang sama. Lihat [Demucs](https://github.com/facebookresearch/demucs) dan [faster-whisper](https://github.com/SYSTRAN/faster-whisper).

Urutan implementasi yang diusulkan adalah uji pipeline pemisahan dan transkripsi, bangun editor dan ekspor, lalu integrasikan player YouTube dan kalibrasi offset.

## 8. Kriteria penerimaan

- Pengguna bisa mengunggah lagu, menerima draft lirik dengan waktu mulai–selesai, memutar stem vokal, mengoreksi hasilnya, lalu mengekspor file yang mencerminkan revisi terakhir.
- Untuk fixture dengan intro instrumental, baris pertama tetap muncul pada posisi vokal di audio asli. Untuk fixture dengan chorus berulang, tiap pengulangan punya timestamp sendiri.
- Memindahkan playhead atau mengganti sumber antara audio asli dan vokal mempertahankan posisi waktu. Baris aktif mengikuti playhead dan menjadi kosong pada jeda tanpa cue.
- Offset +2.500 ms diterapkan tepat satu kali pada ekspor versi video. Ekspor berbasis audio tetap memakai waktu audio. SRT dan JSON menyimpan awal serta akhir, sedangkan LRC menyimpan awal setiap baris.
- File rusak, video yang tidak dapat di-embed, job gagal, dan hasil tanpa vokal memiliki kondisi UI yang jelas serta alur pemulihan sesuai bagian 6.

- Pada layar selebar 360 px, pengguna bisa unggah audio, putar ulang satu baris, edit teks dan timing, lalu ekspor tanpa gulir horizontal. Pemutar tetap bisa dijangkau saat meninjau daftar lirik.
- Dengan keyboard saja, pengguna bisa mengunggah, mengganti sumber audio, memilih baris, mengubah waktu, dan mengekspor. Selama edit atau gulir manual, auto-scroll berhenti dan perintah **Ikuti lagu** mengaktifkannya kembali.
- Jika autosave gagal, perubahan tetap terlihat dan aksi **Coba simpan lagi** bisa dijalankan dari editor.

## 9. Evaluasi beta dan pengembangan lanjutan

Gunakan 20 lagu uji berizin dalam bahasa Indonesia dan Inggris, dengan lirik dan awal–akhir baris yang ditandai manual. Ukur word error rate, median dan P90 selisih awal/akhir baris terhadap anotasi, waktu pemrosesan, serta waktu koreksi dibanding penyusunan lirik dari nol. Target beta awal yang perlu divalidasi adalah median galat waktu mulai baris maksimal 700 ms pada baris yang cocok, waktu koreksi median minimal 30% lebih singkat, dan P90 pemrosesan lagu hingga lima menit maksimal tiga menit pada konfigurasi GPU yang dicatat. Laporkan juga persentase baris referensi yang ditemukan agar baris yang hilang terlihat dalam evaluasi.

Setelah MVP, pertimbangkan penyelarasan ulang dengan lirik yang dimasukkan pengguna, highlight karaoke per kata, pemrosesan satu bagian lagu saja, dan pemisahan vokal utama dari backing vocal.
