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

router.get("/cart", requireAuth, async (req, res) => {
  const cartSummary = await getCartSummary(req.user.id);
  res.json({ items: cartSummary.items, summary: cartSummary.summary });
});

router.post("/cart/items", requireAuth, async (req, res) => {
  const productId = getId(req.body.productId);
  const quantity = getId(req.body.quantity);

  if (!productId || !quantity || quantity < 1) {
    return res
      .status(400)
      .json({ message: "Valid productId and quantity are required" });
  }

  const product = await Product.findOne({ id: productId }).lean();
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  if (quantity > product.countInStock) {
    return res.status(400).json({ message: "Requested quantity exceeds stock" });
  }

  const cart = await getOrCreateUserCart(req.user.id);
  const existingItem = cart.items.find((item) => item.productId === productId);

  if (existingItem) {
    existingItem.quantity = quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  await cart.save();
  const cartSummary = await getCartSummary(req.user.id);
  res.status(201).json({ items: cartSummary.items, summary: cartSummary.summary });
});

router.put("/cart/items/:id", requireAuth, async (req, res) => {
  const productId = getId(req.params.id);
  const quantity = getId(req.body.quantity);

  if (!productId || !quantity || quantity < 1) {
    return res.status(400).json({ message: "Valid quantity is required" });
  }

  const product = await Product.findOne({ id: productId }).lean();
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  if (quantity > product.countInStock) {
    return res.status(400).json({ message: "Requested quantity exceeds stock" });
  }

  const cart = await getOrCreateUserCart(req.user.id);
  const item = cart.items.find((entry) => entry.productId === productId);

  if (!item) {
    return res.status(404).json({ message: "Cart item not found" });
  }

  item.quantity = quantity;
  await cart.save();

  const cartSummary = await getCartSummary(req.user.id);
  res.json({ items: cartSummary.items, summary: cartSummary.summary });
});

router.delete("/cart/items/:id", requireAuth, async (req, res) => {
  const productId = getId(req.params.id);
  const cart = await getOrCreateUserCart(req.user.id);

  cart.items = cart.items.filter((item) => item.productId !== productId);
  await cart.save();

  const cartSummary = await getCartSummary(req.user.id);
  res.json({ items: cartSummary.items, summary: cartSummary.summary });
});

module.exports = router;
