/* Serve public CRM metadata. Tidak mengubah laporan atau database.
Todo:
-> return source failures without sample data
*/
import { Router } from 'express';
import { createPublicReportsReader } from '../services/publicReports.js';

const router = Router();
const readReports = createPublicReportsReader();

router.get('/', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await readReports());
  } catch {
    res.status(503).json({ message: 'Laporan dari CRM Jakarta belum dapat dimuat.' });
  }
});

export default router;
