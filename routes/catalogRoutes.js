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

router.get("/catalog", async (req, res) => {
  const payload = await getCachedValue("catalog", CATALOG_CACHE_TTL_MS, async () => {
    const [products, categories, subcategories, items] = await Promise.all([
      Product.find({}, LIST_PRODUCT_PROJECTION)
        .sort({ category: 1, subcategory: 1, itemName: 1 })
        .lean(),
      Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
      Subcategory.find({ isActive: true })
        .sort({ categoryId: 1, sortOrder: 1, name: 1 })
        .lean(),
      ItemGroup.find({ isActive: true })
        .sort({ subcategoryId: 1, sortOrder: 1, name: 1 })
        .lean(),
    ]);
    const tree = buildCatalog({ products, categories, subcategories, items });
    const stats = {
      categories: tree.length,
      subcategories: tree.reduce(
        (total, category) => total + category.subcategories.length,
        0
      ),
      items: tree.reduce(
        (total, category) =>
          total +
          category.subcategories.reduce(
            (subtotal, subcategory) => subtotal + subcategory.items.length,
            0
          ),
        0
      ),
      products: products.length,
    };

    return { tree, stats };
  });

  res.json(payload);
});

module.exports = router;
