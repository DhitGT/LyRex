# Mesin ekstraksi LyRex

Jalankan dari direktori proyek dengan Node.js 24 atau lebih baru.

```powershell
npm.cmd install
npm.cmd run dev
```

Buka LyRex di Chrome desktop terbaru, unggah MP3, WAV, atau M4A, lalu klik **Ekstrak lirik**. Worker TypeScript membaca audio dengan FFmpeg dari paket `ffmpeg-static`. Setelah audio siap, pilih bahasa dan klik **Mulai transkripsi di browser**. [LyRex lokal](http://localhost:3031)

Mode bawaan **Audio asli** langsung menyiapkan file untuk Web Speech. Pilih **Vokal saja** untuk memisahkan vokal dengan Demucs sebelum transkripsi. Pada pemrosesan pertama mode Vokal saja, LyRex menyiapkan sekitar 166 MB model ke `.data/extractions/models/onnx`. [Demucs ONNX](https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx)

Web Speech API menerima track dari file dan berjalan mengikuti durasi audio. Biarkan tab tetap terbuka hingga draft tersimpan. Browser dapat mengirim audio ke layanan pengenalan suara. Hasil memuat perkiraan waktu per baris. [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)

Job diproses satu per satu dalam satu proses Nitro. Simpan `.data/extractions` secara persisten agar proyek, log, dan job yang belum selesai bisa dibuka kembali. Untuk build produksi, jalankan `node .output/server/index.mjs` dari direktori proyek dengan folder `engine` dan dependensi npm tersedia.

`LYREX_DATA_DIR` menentukan lokasi proyek. `LYREX_MODEL_DIR` bisa menentukan cache model terpisah. `LYREX_FFMPEG` bisa menunjuk ke executable FFmpeg.

