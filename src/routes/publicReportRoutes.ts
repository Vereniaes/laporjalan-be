/* Serve public report metadata. Tidak mengubah laporan atau database.
Todo:
-> the imported reports in the database are the map's data (owner choice, 10 Nov); the live source is the fallback
-> return source failures without sample data
*/
import { Router } from 'express';
import { createPublicReportsReader } from '../services/publicReports.js';
import { importedDetail, importedSnapshot } from '../services/importedReports.js';
import { handlingFor, publicHandling } from '../community/handling.js';

const router = Router();
const readReports = createPublicReportsReader();

router.get('/', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json((await importedSnapshot().catch(() => null)) ?? await readReports());
  } catch {
    res.status(503).json({ message: 'Laporan belum dapat dimuat.' });
  }
});

// handling by the LaporJalan team for any report (the warga card asks here; imported details include it)
router.get('/:id/handling', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const handling = publicHandling(await handlingFor(String(req.params.id)).catch(() => null));
  if (!handling) { res.status(404).json({ message: 'Belum ada penanganan.' }); return; }
  res.json(handling);
});

// one report with its history, for the card's Laporan and Riwayat tabs
router.get('/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const detail = await importedDetail(String(req.params.id)).catch(() => null);
  if (!detail) { res.status(404).json({ message: 'Laporan tidak ditemukan.' }); return; }
  res.json(detail);
});

export default router;
