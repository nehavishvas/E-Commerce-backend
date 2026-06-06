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

router.get("/products", async (req, res) => {
  const query = String(req.query.q || "").toLowerCase().trim();
  const category = String(req.query.category || "").toLowerCase().trim();
  const subcategory = String(req.query.subcategory || "").toLowerCase().trim();
  const item = String(req.query.item || "").toLowerCase().trim();
  const brand = String(req.query.brand || "").toLowerCase().trim();
  const sort = String(req.query.sort || "featured").toLowerCase();
  const inStockOnly = String(req.query.inStock || "").toLowerCase() === "true";
  const minPrice = Number.parseInt(req.query.minPrice, 10);
  const maxPrice = Number.parseInt(req.query.maxPrice, 10);
  const minRating = Number.parseFloat(req.query.minRating);
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const requestedLimit = String(req.query.limit || DEFAULT_PAGE_SIZE).toLowerCase();
  const limit =
    requestedLimit === "all"
      ? null
      : Math.max(
          Math.min(Number.parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 24),
          1
        );

  const filter = {};
  if (category) {
    filter.categorySlug = category;
  }
  if (subcategory) {
    filter.subcategorySlug = subcategory;
  }
  if (item) {
    filter.itemSlug = item;
  }
  if (brand) {
    filter.brand = new RegExp(`^${escapeRegex(brand)}$`, "i");
  }
  if (query) {
    filter.$or = [
      { name: new RegExp(escapeRegex(query), "i") },
      { brand: new RegExp(escapeRegex(query), "i") },
      { description: new RegExp(escapeRegex(query), "i") },
      { category: new RegExp(escapeRegex(query), "i") },
      { subcategory: new RegExp(escapeRegex(query), "i") },
      { itemName: new RegExp(escapeRegex(query), "i") },
    ];
  }
  if (inStockOnly) {
    filter.countInStock = { $gt: 0 };
  }
  if (!Number.isNaN(minRating)) {
    filter.rating = { $gte: minRating };
  }
  if (!Number.isNaN(minPrice) || !Number.isNaN(maxPrice)) {
    filter.price = {};
    if (!Number.isNaN(minPrice)) {
      filter.price.$gte = minPrice;
    }
    if (!Number.isNaN(maxPrice)) {
      filter.price.$lte = maxPrice;
    }
  }

  const sortMap = {
    featured: { rating: -1, countInStock: -1, id: 1 },
    newest: { createdAt: -1, id: -1 },
    "price-asc": { price: 1, id: 1 },
    "price-desc": { price: -1, id: 1 },
    rating: { rating: -1, id: 1 },
    name: { name: 1, id: 1 },
  };
  const sortOrder = sortMap[sort] || sortMap.featured;

  const skip = limit ? (page - 1) * limit : 0;
  const [total, products, facets] = await Promise.all([
    Product.countDocuments(filter),
    (async () => {
      let queryBuilder = Product.find(filter, LIST_PRODUCT_PROJECTION).sort(sortOrder);
      if (limit) {
        queryBuilder = queryBuilder.skip(skip).limit(limit);
      }
      return queryBuilder.lean();
    })(),
    buildProductFacets(filter),
  ]);

  res.json({
    products,
    total,
    page,
    pages: limit ? Math.max(Math.ceil(total / limit), 1) : 1,
    limit: limit || total,
    facets,
    filters: {
      q: query,
      category,
      subcategory,
      item,
      brand,
      sort,
      inStock: inStockOnly,
      minRating: Number.isNaN(minRating) ? null : minRating,
      minPrice: Number.isNaN(minPrice) ? null : minPrice,
      maxPrice: Number.isNaN(maxPrice) ? null : maxPrice,
    },
  });
});

router.get("/products/:id", async (req, res) => {
  const product = await Product.findOne({ id: getId(req.params.id) }).lean();

  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const relatedProducts = await Product.find({
    id: { $ne: product.id },
    $or: [
      { itemSlug: product.itemSlug },
      { subcategorySlug: product.subcategorySlug },
    ],
  }, RELATED_PRODUCT_PROJECTION)
    .sort({ rating: -1, id: 1 })
    .limit(4)
    .lean();

  res.json({ product, relatedProducts });
});

router.post("/products/:id/reviews", requireAuth, async (req, res) => {
  const productId = getId(req.params.id);
  const { rating, title, comment } = req.body || {};
  const numericRating = Number(rating);

  if (
    !productId ||
    !title ||
    !comment ||
    !numericRating ||
    numericRating < 1 ||
    numericRating > 5
  ) {
    return res
      .status(400)
      .json({ message: "Rating, title and comment are required" });
  }

  const product = await Product.findOne({ id: productId });
  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const existingReview = product.reviews.find(
    (review) => review.userId === req.user.id
  );

  if (existingReview) {
    return res
      .status(400)
      .json({ message: "You have already reviewed this product" });
  }

  product.reviews.unshift({
    userId: req.user.id,
    name: req.user.name,
    rating: numericRating,
    title: String(title).trim(),
    comment: String(comment).trim(),
    createdAt: new Date().toISOString(),
  });
  product.numReviews = product.reviews.length;
  product.rating = Number(
    (
      product.reviews.reduce((total, review) => total + review.rating, 0) /
      product.reviews.length
    ).toFixed(1)
  );

  await product.save();
  invalidateCache("catalog");

  const relatedProducts = await Product.find({
    id: { $ne: product.id },
    $or: [
      { itemSlug: product.itemSlug },
      { subcategorySlug: product.subcategorySlug },
    ],
  }, RELATED_PRODUCT_PROJECTION)
    .sort({ rating: -1, id: 1 })
    .limit(4)
    .lean();

  res.status(201).json({
    message: "Review added successfully",
    product: product.toObject(),
    relatedProducts,
  });
});

module.exports = router;
