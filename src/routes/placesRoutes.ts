/*
file ini router express buat endpoint /api/places
Todo:
-> route GET /autocomplete
-> route GET /details
*/

import { Router } from 'express';
import { searchPlaces, getPlaceDetails } from '../controllers/placesController.js';

const router = Router();

router.get('/autocomplete', searchPlaces);
router.get('/details', getPlaceDetails);

export default router;
