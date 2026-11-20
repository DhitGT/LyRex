# LyRex

## Deploy ke Vercel

Impor repo sebagai proyek Nuxt. Konfigurasi di `vercel.json` menjalankan `npm run generate` dan menyajikan `.output/public` sebagai situs statis. Pemisahan vokal berjalan di Web Worker, dan IndexedDB menyimpan audio, progres transkripsi, serta draft. Deploy ini tidak memerlukan Vercel Blob, Vercel Sandbox, atau token penyimpanan.

Mode **Vokal saja** mengunduh bobot Demucs sekitar 166 MB saat pertama kali dipakai dan menyimpannya di cache browser jika ruang tersedia. Biarkan tab tetap terbuka selama pemrosesan. Chrome atau Edge desktop disarankan untuk pemisahan vokal. Mode **Audio asli** bisa dipakai untuk membuka proyek dan menyunting draft tanpa unduhan Demucs.

Proyek lokal tersedia pada origin dan profil browser yang menyimpannya. Proyek dari versi server sebelumnya tidak muncul otomatis. Ekspor lirik dan audio dari versi lama untuk menyimpan salinannya sebelum beralih.

Pencarian acuan menghubungi LRCLIB secara langsung. Jika dipilih, transkripsi Web Speech dapat menggunakan layanan pengenalan suara browser.

## Jalankan lokal

Gunakan Node.js 24 atau lebih baru.

```sh
npm ci
npm run dev
```

Untuk menguji build produksi, jalankan `npm run generate` dan sajikan direktori `.output/public` melalui server HTTP lokal.
