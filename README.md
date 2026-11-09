# LaporJalan - Backend API Service

Layanan backend REST API performa tinggi untuk sistem LaporJalan. Menyajikan pembaca agregasi laporan resmi CRM Jakarta (JAKI), manajemen kontribusi laporan jalan warga, integrasi telemetri kamera CCTV lalu lintas, proxy pencarian alamat Google Places, serta kalkulasi otomatis skor prioritas penanganan jalan mengacu pada standar Bina Marga.

**URL Layanan Produksi**: [https://laporjalan-be-710000917298.asia-southeast2.run.app](https://laporjalan-be-710000917298.asia-southeast2.run.app)

---

## Fitur Utama

- **Laporan Publik CRM Jakarta (`GET /api/public-reports`)**: Pengambilan data laporan kerusakan jalan aktif secara real-time dari sistem CRM Jakarta (JAKI).
- **Pemeriksaan Kesehatan Layanan (`GET /health`)**: Endpoint probe kesiapan kontainer Cloud Run (`status`, `uptime`, `mode`, dan status koneksi database).
- **Manajemen Kerusakan Jalan (`/api/reports`)**:
  - `GET /api/reports`: Filter laporan berdasarkan jenis kerusakan, tingkat keparahan (*severity*), dan instansi yuridis.
  - `POST /api/reports`: Penerimaan laporan baru dengan unggahan bukti foto jalan.
  - `PATCH /api/reports/:id/status`: Pembaruan status penanganan dinas terkait.
- **Kalkulasi Skor Prioritas Bina Marga (UP Score)**: Pembobotan otomatis skala 1.0 - 10.0 berdasarkan kedalaman lubang (> 5 cm), tipe kerusakan (*pothole* / *trench*), dan tingkat keparahan.
- **Telemetri CCTV & Arus Lalu Lintas (`/api/cctv`, `/api/traffic`)**: Koordinat kamera pemantau, sudut arah hadap (*angle*), lebar kerucut (*fov*), dan kecepatan rata-rata ruas jalan.
- **Proxy Alamat Google Places (`/api/places`)**: Autocomplete pencarian jalan resmi Indonesia dengan fallback otomatis ke OpenStreetMap Nominatim.
- **Dual-Mode Persistence**: Mendukung integrasi penuh MongoDB Atlas dan Google Cloud Storage (GCS), dengan kemampuan otomatis *in-memory fallback* saat pengetesan lokal tanpa internet.

---

## Teknologi

- **Runtime**: Node.js v24 LTS & TypeScript
- **Web Framework**: Express 4
- **Database**: MongoDB Atlas via Mongoose & GridFS
- **Penyimpanan Berkas**: Google Cloud Storage & Multer
- **Infrastruktur Cloud**: Google Cloud Run (Region `asia-southeast2` Jakarta)
- **Manajemen Kredensial**: Google Cloud Secret Manager

---

## Panduan Instalasi & Pengembangan Lokal

### 1. Prasyarat
- Node.js versi LTS (`v20+` atau `v24+`)
- npm versi `10+`

### 2. Pemasangan Dependensi
```bash
cd laporjalan-be
npm install
```

### 3. Konfigurasi Lingkungan
Salin berkas template environment:
```bash
cp .env.example .env.local
```
Sesuaikan parameter pada `.env.local`:
```env
PORT=5000
NODE_ENV=development
PUBLIC_REPORTS_ONLY=false
COMMUNITY_REPORTS_ENABLED=false
APP_ORIGIN=http://localhost:3000
CORS_ORIGIN=*
MONGODB_URI=mongodb://localhost:27017/laporjalan
```

### 4. Menjalankan Server
```bash
npm run dev
```
Server berjalan di: `http://localhost:5000`  
Periksa kesehatan API di: `http://localhost:5000/health`

---

## Dokumentasi Variabel Lingkungan

| Variabel | Deskripsi | Tipe Penyimpanan |
| --- | --- | --- |
| `PORT` | Port HTTP (diatur otomatis oleh Cloud Run ke `8080`, lokal `5000`) | Sistem / Plain |
| `NODE_ENV` | Mode lingkungan (`development` / `production`) | Plain |
| `PUBLIC_REPORTS_ONLY` | Pembatasan rute khusus laporan publik CRM (`true` / `false`) | Plain |
| `COMMUNITY_REPORTS_ENABLED` | Mengaktifkan kontribusi laporan warga (`true` / `false`) | Plain |
| `APP_ORIGIN` | URL origin aplikasi frontend untuk otentikasi dan CORS | Plain |
| `CORS_ORIGIN` | Batasan origin CORS (`*` atau URL frontend) | Plain |
| `GCP_PROJECT_ID` | ID Proyek Google Cloud Platform | Plain |
| `GCS_BUCKET_NAME` | Nama bucket Google Cloud Storage untuk foto laporan | Plain |
| `MONGODB_URI` | Connection string MongoDB Atlas dengan kredensial | **GCP Secret Manager** |
| `GOOGLE_MAPS_API_KEY` | Kunci API Google Maps Places | **GCP Secret Manager** |
| `RESEND_API_KEY` | Kunci API layanan email Resend (opsional kontribusi) | **GCP Secret Manager** |

---

## Panduan Deployment ke Google Cloud Run

Backend dilengkapi dengan `Dockerfile` multi-stage production-ready.

### 1. Penyiapan Secrets di GCP Secret Manager
```bash
# Simpan connection string MongoDB Atlas
gcloud secrets create laporjalan-mongodb-uri --data-file=- <<< "mongodb+srv://user:pass@cluster.mongodb.net/laporjalan"

# Simpan API key Google Maps
gcloud secrets create laporjalan-maps-key --data-file=- <<< "AIzaSy..."
```

### 2. Berikan Izin Secret Accessor ke Service Account Cloud Run
```bash
PROJECT_NUM=$(gcloud projects describe [PROJECT_ID] --format="value(projectNumber)")
SA_EMAIL="${PROJECT_NUM}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding laporjalan-mongodb-uri \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding laporjalan-maps-key \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

### 3. Deploy Layanan Container
```bash
gcloud run deploy laporjalan-be \
  --source . \
  --region asia-southeast2 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars "NODE_ENV=production,PUBLIC_REPORTS_ONLY=true,COMMUNITY_REPORTS_ENABLED=false,APP_ORIGIN=https://lapor-jalan-two.vercel.app,CORS_ORIGIN=*,GCP_PROJECT_ID=[PROJECT_ID],GCS_BUCKET_NAME=[BUCKET_NAME]" \
  --set-secrets "MONGODB_URI=laporjalan-mongodb-uri:latest,GOOGLE_MAPS_API_KEY=laporjalan-maps-key:latest"
```

---

## Skrip NPM

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Menjalankan server pengembangan dengan tsx/hot-reload |
| `npm run build` | Menjalankan kompilasi TypeScript (`tsc`) ke direktori `/dist` |
| `npm start` | Menjalankan build produksi dari `/dist/index.js` |
| `npm test` | Menjalankan suite pengujian Jest |
