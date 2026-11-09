/* Todo:
-> give or take the admin role of an existing account (owner choice, 10 Nov: role in the database, set by script)
   usage: npx tsx scripts/make-admin.ts email@contoh [--remove]
*/
import mongoose from 'mongoose';
import { ENV } from '../src/config/env.js';

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase(), remove = process.argv.includes('--remove');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pakai: npx tsx scripts/make-admin.ts email@contoh [--remove]');
  if (!ENV.MONGODB_URI) throw new Error('MONGODB_URI belum diisi');
  await mongoose.connect(ENV.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const accounts = mongoose.connection.db!.collection<{ _id: string; email: string; role?: string }>('citizen_accounts');
  const result = await accounts.updateOne({ email }, remove ? { $unset: { role: '' } } : { $set: { role: 'admin' } });
  console.log(result.matchedCount ? `${email}: ${remove ? 'bukan admin lagi' : 'sekarang admin'} (masuk ulang untuk memuat peran)` : `${email}: akun tidak ditemukan; daftar dulu di /daftar`);
  await mongoose.disconnect();
}
main().catch(error => { console.error(error.message ?? error); process.exit(1); });
