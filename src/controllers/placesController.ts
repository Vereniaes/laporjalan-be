/*
file ini controller buat proxy pencarian alamat jalan indonesia (google maps places)
kalo ada GOOGLE_MAPS_API_KEY di .env pake google places api resmi
kalo belum diset, otomatis fallback ke openstreetmap nominatim indonesia biar gak error
Todo:
-> endpoint autocomplete pencarian jalan
-> endpoint get koordinat lat lng lokasi terpilih
*/

import { Request, Response } from 'express';
import { ENV } from '../config/env.js';

interface PlaceSuggestion {
  id: string;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
}

// GET /api/places/autocomplete?input=...
export async function searchPlaces(req: Request, res: Response) {
  try {
    const input = (req.query.input as string || '').trim();
    if (!input || input.length < 2) {
      return res.json({ success: true, predictions: [] });
    }

    // 1. jika ada google maps api key, gunakan google places api resmi
    if (ENV.GOOGLE_MAPS_API_KEY) {
      const gUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(
        input
      )}&components=country:id&language=id&key=${ENV.GOOGLE_MAPS_API_KEY}`;

      const gRes = await fetch(gUrl);
      const gData = await gRes.json();

      if (gData.status === 'OK' && Array.isArray(gData.predictions)) {
        const predictions: PlaceSuggestion[] = gData.predictions.map((p: any) => ({
          id: p.place_id,
          name: p.structured_formatting?.main_text || p.description,
          address: p.description
        }));
        return res.json({ success: true, source: 'google', predictions });
      }
    }

    // 2. fallback cerdas: gunakan osm nominatim indonesia
    const osmUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      input
    )}&countrycodes=id&limit=5&addressdetails=1`;

    const osmRes = await fetch(osmUrl, {
      headers: { 'User-Agent': 'LaporJalan-App/1.0 (hackathon-indonesia)' }
    });
    const osmData = await osmRes.json();

    if (Array.isArray(osmData)) {
      const predictions: PlaceSuggestion[] = osmData.map((item: any) => ({
        id: item.place_id ? String(item.place_id) : item.osm_id,
        name: item.name || item.display_name.split(',')[0],
        address: item.display_name,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon)
      }));
      return res.json({ success: true, source: 'fallback', predictions });
    }

    return res.json({ success: true, predictions: [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal mencari alamat' });
  }
}

// GET /api/places/details?place_id=...
export async function getPlaceDetails(req: Request, res: Response) {
  try {
    const placeId = req.query.place_id as string;
    if (!placeId) {
      return res.status(400).json({ success: false, message: 'place_id wajib disertakan' });
    }

    if (ENV.GOOGLE_MAPS_API_KEY) {
      const gUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
        placeId
      )}&fields=geometry,formatted_address,name&key=${ENV.GOOGLE_MAPS_API_KEY}`;

      const gRes = await fetch(gUrl);
      const gData = await gRes.json();

      if (gData.status === 'OK' && gData.result?.geometry?.location) {
        return res.json({
          success: true,
          data: {
            name: gData.result.name,
            address: gData.result.formatted_address,
            lat: gData.result.geometry.location.lat,
            lng: gData.result.geometry.location.lng
          }
        });
      }
    }

    return res.status(404).json({ success: false, message: 'Detail tempat tidak ditemukan' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Gagal mengambil detail tempat' });
  }
}
