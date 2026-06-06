const express = require('express');
const router = express.Router();
const { buildCatalog, normalizeStringList, slugify } = require("../lib/catalog");

const { requireAuth } = require('../lib/helpers');
const {
  register,
  login,
  getMe
} = require('../controllers/authController');

router.post('/register', register);
router.post('/login', login);
router.get('/me', requireAuth, getMe);

module.exports = router;
