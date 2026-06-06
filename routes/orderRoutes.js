const express = require('express');
const router = express.Router();
const { buildCatalog, normalizeStringList, slugify } = require("../lib/catalog");

const User = require('../models/User');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Subcategory = require('../models/Subcategory');
const ItemGroup = require('../models/ItemGroup');
const Cart = require('../models/Cart');
const Order = require('../models/Order');

const { 
  DEFAULT_PAGE_SIZE, ADMIN_ROLES, HEALTH_CACHE_TTL_MS, CATALOG_CACHE_TTL_MS, 
  LIST_PRODUCT_PROJECTION, RELATED_PRODUCT_PROJECTION, CART_PRODUCT_PROJECTION, 
  SYSTEM_USERS, FRONTEND_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, razorpay,
  getId, sanitizeUser, createAuthResponse, getCachedValue, invalidateCache, getAuthToken, normalizeShippingAddress,
  markOrderAsClosed, verifyRazorpaySignature, serializeOrder, buildTransactionTimeline, serializeTransaction,
  fetchVerifiedPayment, requireAuth, requireRole, requireAdmin, getNextId, ensureSystemUser, getOrCreateUserCart,
  buildProductMap, escapeRegex, toOptionalString, parseCatalogPayload, formatAdminDocument, formatAdminUser,
  formatCartItems, getCartSummary, buildProductFacets 
} = require("../lib/helpers");

router.get("/orders", requireAuth, async (req, res) => {
  const orders = await Order.find({
    userId: req.user.id,
    paymentStatus: "paid",
  })
    .sort({ createdAt: -1 })
    .lean();
  res.json(orders.map((order) => serializeOrder(order)));
});

module.exports = router;
