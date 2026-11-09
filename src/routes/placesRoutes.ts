/* Todo:
-> register Google Places address search and detail resolution routes
*/

import { Router } from 'express';
import { searchPlaces, getPlaceDetails } from '../controllers/placesController.js';

// --- Places Routes ------------------------------------------------------------
const router = Router();

router.get('/autocomplete', searchPlaces);
router.get('/details', getPlaceDetails);

export default router;
// --- end of Places Routes -----------------------------------------------------
