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

router.get("/transactions", requireAuth, async (req, res) => {
  const transactions = await Order.find({
    userId: req.user.id,
    paymentMethod: "razorpay",
  })
    .sort({ createdAt: -1 })
    .lean();

  res.json(transactions.map((order) => serializeTransaction(order)));
});

router.get("/transactions/:orderId", requireAuth, async (req, res) => {
  const orderId = getId(req.params.orderId);

  if (!orderId) {
    return res.status(400).json({ message: "Valid order id is required" });
  }

  const order = await Order.findOne({
    id: orderId,
    userId: req.user.id,
    paymentMethod: "razorpay",
  }).lean();

  if (!order) {
    return res.status(404).json({ message: "Transaction not found" });
  }

  res.json(serializeTransaction(order));
});

module.exports = router;
