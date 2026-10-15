# PANDUAN DEPLOYMENT RESMI: SISTEM LAPORJALAN
## Deployment Terpadu: Backend (GCP Cloud Run & MongoDB) + Frontend (Vercel)

Dokumen ini memuat panduan langkah demi langkah untuk men-deploy sistem LaporJalan ke arsitektur produksi cloud:
- **Backend**: Google Cloud Run (Containerized Node.js + Express)
- **Database**: MongoDB Atlas
- **Storage**: Google Cloud Storage (GCS)
- **Frontend**: Vercel (Vite + React Single-Page Application)

---

## 1. Persiapan Awal & Kebutuhan Kredensial

Pastikan memiliki akun dan akses berikut:
1. **Google Cloud Platform (GCP)**:
   - Proyek GCP aktif (contoh: `laporjalan-hackathon`)
   - `gcloud` CLI terpasang di terminal atau gunakan Cloud Shell
   - Service yang perlu diaktifkan di GCP:
     - Cloud Run API: `run.googleapis.com`
     - Artifact Registry API: `artifactregistry.googleapis.com`
     - Cloud Build API: `cloudbuild.googleapis.com`
     - Cloud Storage: `storage.googleapis.com`
2. **MongoDB Atlas**:
   - Akun di [mongodb.com/atlas](https://www.mongodb.com/atlas)
   - Cluster M0 (Gratis)
   - Database User (username & password) dan izin akses IP (`0.0.0.0/0` untuk akses dari Cloud Run)
3. **Vercel**:
   - Akun di [vercel.com](https://vercel.com)
   - Vercel CLI (`npm i -g vercel`) atau import repo GitHub langsung via Vercel Dashboard

---

## 2. Langkah 1: Setup MongoDB Atlas

1. Masuk ke [MongoDB Atlas Console](https://cloud.mongodb.com/).
2. Buat Cluster baru (pilih opsi **Shared M0 - Free**, region Singapore `ap-southeast-1` atau Jakarta `asia-southeast2`).
3. Pada menu **Security -> Database Access**, buat pengguna baru:
   - Username: `laporjalan_admin`
   - Password: `[PASSWORD_ANDA]`
   - Role: `Read and write to any database`
4. Pada menu **Security -> Network Access**:
   - Tambahkan IP Address: `0.0.0.0/0` (Allow Access from Anywhere) agar Cloud Run dapat terhubung secara dinamis.
5. Klik **Database -> Connect -> Drivers (Node.js)** dan salin Connection String:
   ```env
   mongodb+srv://laporjalan_admin:<password>@cluster0.xxxxx.mongodb.net/laporjalan?retryWrites=true&w=majority
   ```

---

## 3. Langkah 2: Setup Google Cloud Storage (GCS) untuk Foto Kerusakan

1. Buka GCP Console -> **Cloud Storage -> Buckets**.
2. Klik **Create Bucket**:
   - Nama Bucket: `laporjalan-photos-[ID_UNIK]` (harus unik global)
   - Location: `asia-southeast2` (Jakarta)
   - Default storage class: `Standard`
   - Access Control: Hilangkan centang *Enforce public access prevention* jika ingin foto dapat diakses publik, atau atur IAM `allUsers` -> role `Storage Object Viewer`.
3. Catat nama bucket tersebut untuk konfigurasi environment variable backend.

---

## 4. Langkah 3: Deploy Backend ke Google Cloud Run

Backend sudah dilengkapi dengan `Dockerfile` multi-stage yang dioptimasi untuk Cloud Run.

### Opsi A: Deploy Menggunakan `gcloud` CLI (Direkomendasikan)
Masuk ke direktori backend di terminal (WSL):
```bash
cd /home/vereniaes/project/hackathon/laporjalan-be
```

1. Login dan set proyek GCP:
   ```bash
   gcloud auth login
   gcloud config set project [GCP_PROJECT_ID]
   ```

2. Aktifkan service yang dibutuhkan (hanya sekali):
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```

3. Deploy langsung dari source code (Google Cloud Build akan otomatis membaca `Dockerfile`):
   ```bash
   gcloud run deploy laporjalan-be \
     --source . \
     --region asia-southeast2 \
     --allow-unauthenticated \
     --port 8080 \
     --set-env-vars "NODE_ENV=production,PORT=8080,MONGODB_URI=mongodb+srv://laporjalan_admin:PASSWORD@cluster0.xxxxx.mongodb.net/laporjalan?retryWrites=true&w=majority,GCP_PROJECT_ID=[GCP_PROJECT_ID],GCS_BUCKET_NAME=[NAMA_BUCKET],CORS_ORIGIN=*"
   ```

4. Setelah proses selesai (~2-3 menit), gcloud akan menampilkan URL layanan, contoh:
   ```
   Service URL: https://laporjalan-be-xxxxxx-et.a.run.app
   ```

5. Uji kesehatan backend:
   ```bash
   curl https://laporjalan-be-xxxxxx-et.a.run.app/health
   # Respon: {"status":"ok","service":"laporjalan-be","database":"connected"}
   ```

---

## 5. Langkah 4: Deploy Frontend ke Vercel

### Opsi A: Deploy via Vercel Dashboard (GitHub Integration)
1. Commit dan push repository frontend `LaporJalan` ke GitHub Anda.
2. Buka [Vercel Dashboard](https://vercel.com/new).
3. Pilih repository `LaporJalan`.
4. Pada bagian **Configure Project**:
   - Framework Preset: `Vite`
   - Root Directory: `./`
   - Build Command: `npm run build`
   - Output Directory: `dist`
5. Pada bagian **Environment Variables**, tambahkan:
   - **Key**: `VITE_API_URL`
   - **Value**: `https://laporjalan-be-xxxxxx-et.a.run.app` (URL dari Cloud Run pada Langkah 3)
6. Klik **Deploy**.

### Opsi B: Deploy via Vercel CLI dari Terminal
Masuk ke direktori frontend di WSL:
```bash
cd /home/vereniaes/project/hackathon/LaporJalan
```

1. Jalankan perintah:
   ```bash
   vercel
   ```
2. Ikuti instruksi di terminal (konfirmasi nama proyek dan framework Vite).
3. Set environment variable:
   ```bash
   vercel env add VITE_API_URL production
   # Masukkan URL Cloud Run Anda: https://laporjalan-be-xxxxxx-et.a.run.app
   ```
4. Deploy ke produksi:
   ```bash
   vercel --prod
   ```

---

## 6. Langkah 5: Pengujian & Validasi Pasca Deployment

1. Buka domain Vercel yang diberikan (misalnya `https://lapor-jalan.vercel.app`).
2. Uji alur sistem:
   - **Peta 3D**: Pastikan layer gedung 3D, kerucut kamera CCTV, dan marker termuat.
   - **Lapor 1-Snap AI**: Buka kamera, unggah foto jalan, dan kirim laporan. Pastikan laporan tersimpan ke MongoDB Atlas dan foto terunggah ke Google Cloud Storage.
   - **Inspeksi 3D & Komparasi**: Buka *Mode Lapangan 3D* dan *Sebelum vs Sesudah Slider* untuk memverifikasi fungsionalitas rendering WebGL di perangkat seluler maupun komputer.

---

## 7. Troubleshooting & Solusi Kendala Umum

| Gejala Kendala | Penyebab Utama | Solusi |
| :--- | :--- | :--- |
| **CORS Error di Console Browser** | Backend menolak origin domain Vercel | Pastikan variabel `CORS_ORIGIN` di Cloud Run bernilai `*` atau cantumkan domain Vercel Anda secara spesifik. |
| **Cloud Run Container Failed to Start** | Port tidak sesuai standar Cloud Run | Cloud Run mewajibkan server mendengarkan port dari `process.env.PORT` (8080) pada host `0.0.0.0`. Kode LaporJalan sudah mengimplementasikan ini secara otomatis. |
| **Database disconnected / timeout** | IP Cloud Run belum diizinkan di Atlas | Pastikan di MongoDB Atlas Network Access telah ditambahkan IP `0.0.0.0/0`. |
| **Peta WebGL blank putih di iOS** | Akselerasi hardware browser mati | Peta LaporJalan menggunakan MapLibre GL dengan tile raster Carto fallback yang kompatibel dengan seluruh webview mobile tanpa membutuhkan WebGL2 lanjutan. |
