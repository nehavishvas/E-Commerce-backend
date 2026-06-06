
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { signToken, verifyToken } = require("./auth");
const { normalizeStringList } = require("./catalog");
const Product = require("../models/Product");
const User = require("../models/User");
const Cart = require("../models/Cart");

const DEFAULT_PAGE_SIZE = 6;
const ADMIN_ROLES = ["manager", "admin"];
const HEALTH_CACHE_TTL_MS = 15000;
const CATALOG_CACHE_TTL_MS = 30000;
const LIST_PRODUCT_PROJECTION = { reviews: 0 };
const RELATED_PRODUCT_PROJECTION = { reviews: 0 };
const CART_PRODUCT_PROJECTION = {
  id: 1,
  name: 1,
  brand: 1,
  image: 1,
  price: 1,
  countInStock: 1,
  category: 1,
  subcategory: 1,
  itemName: 1,
};
const SYSTEM_USERS = {
  "demo@shopzone.com": {
    name: "Demo User",
    password: "demo123",
    role: "customer",
    isAdmin: false,
  },
  "manager@shopzone.com": {
    name: "Catalog Manager",
    password: "manager123",
    role: "manager",
    isAdmin: true,
  },
  "admin@shopzone.com": {
    name: "Admin User",
    password: "admin123",
    role: "admin",
    isAdmin: true,
  },
};
const FRONTEND_URL = process.env.FRONTEND_URL || "http://127.0.0.1:3100";
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET }) : null;

const responseCache = new Map();

const getId = (value) => Number.parseInt(value, 10);

const sanitizeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role || (user.isAdmin ? "admin" : "customer"),
  isAdmin: Boolean(user.isAdmin),
  isActive: user.isActive !== false,
  createdAt: user.createdAt,
});

const createAuthResponse = (user) => ({
  token: signToken({ id: user.id, email: user.email }),
  user: sanitizeUser(user),
});

const getCachedValue = async (key, ttlMs, loader) => {
  const now = Date.now();
  const cached = responseCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await loader();
  responseCache.set(key, {
    value,
    expiresAt: now + ttlMs,
  });
  return value;
};

const invalidateCache = (...keys) => {
  keys.forEach((key) => responseCache.delete(key));
};

const getAuthToken = (req) => {
  const authHeader = req.headers.authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
};

const normalizeShippingAddress = (shippingAddress = {}) => ({
  fullName: String(shippingAddress.fullName || "").trim(),
  address: String(shippingAddress.address || "").trim(),
  city: String(shippingAddress.city || "").trim(),
  postalCode: String(shippingAddress.postalCode || "").trim(),
  country: String(shippingAddress.country || "").trim(),
});

const markOrderAsClosed = async (order, updates = {}) => {
  if (!order || order.paymentStatus === "paid") {
    return order;
  }

  Object.assign(order, updates);
  await order.save();
  return order;
};

const verifyRazorpaySignature = (razorpayOrderId, razorpayPaymentId, razorpaySignature) => {
  const generatedSignature = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  return generatedSignature === razorpaySignature;
};

const serializeOrder = (order) => {
  if (!order) {
    return null;
  }

  return {
    id: order.id,
    userId: order.userId,
    createdAt: order.createdAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    currency: order.currency || "INR",
    amountInPaise: order.amountInPaise || Math.round((order.summary?.total || 0) * 100),
    receipt: order.receipt || null,
    paidAt: order.paidAt || null,
    paymentFailedAt: order.paymentFailedAt || null,
    paymentCanceledAt: order.paymentCanceledAt || null,
    paymentFailureReason: order.paymentFailureReason || null,
    razorpayOrderId: order.razorpayOrderId || null,
    razorpayPaymentId: order.razorpayPaymentId || null,
    shippingAddress: order.shippingAddress,
    items: order.items || [],
    summary: order.summary,
  };
};

const buildTransactionTimeline = (order) => {
  const timeline = [
    {
      label: "Transaction requested",
      status: "completed",
      at: order.createdAt,
      detail: `Order #${order.id} was created for Razorpay checkout.`,
    },
  ];

  if (order.paymentCanceledAt) {
    timeline.push({
      label: "Payment canceled",
      status: "warning",
      at: order.paymentCanceledAt,
      detail: order.paymentFailureReason || "Checkout was closed before completion.",
    });
  }

  if (order.paymentFailedAt) {
    timeline.push({
      label: "Payment failed",
      status: "error",
      at: order.paymentFailedAt,
      detail: order.paymentFailureReason || "Payment failed before confirmation.",
    });
  }

  if (order.paidAt) {
    timeline.push({
      label: "Payment confirmed",
      status: "completed",
      at: order.paidAt,
      detail: `Payment was confirmed through ${order.paymentMethod}.`,
    });
  }

  return timeline;
};

const serializeTransaction = (order) => {
  const baseOrder = serializeOrder(order);

  return {
    order: baseOrder,
    transactionRequest: {
      orderId: baseOrder.id,
      requestedAt: baseOrder.createdAt,
      gateway: baseOrder.paymentMethod,
      gatewayOrderId: baseOrder.razorpayOrderId,
      receipt: baseOrder.receipt,
      currency: baseOrder.currency,
      amountInPaise: baseOrder.amountInPaise,
      total: baseOrder.summary.total,
      itemsCount: baseOrder.summary.itemsCount,
      shippingAddress: baseOrder.shippingAddress,
    },
    paymentDetail: {
      gateway: baseOrder.paymentMethod,
      paymentStatus: baseOrder.paymentStatus,
      orderStatus: baseOrder.status,
      gatewayOrderId: baseOrder.razorpayOrderId,
      gatewayPaymentId: baseOrder.razorpayPaymentId,
      currency: baseOrder.currency,
      amountInPaise: baseOrder.amountInPaise,
      paidAt: baseOrder.paidAt,
      failedAt: baseOrder.paymentFailedAt,
      canceledAt: baseOrder.paymentCanceledAt,
      failureReason: baseOrder.paymentFailureReason,
    },
    timeline: buildTransactionTimeline(baseOrder),
  };
};

const fetchVerifiedPayment = async (order, razorpayPaymentId, expectedAmountInPaise) => {
  let paymentDetails = await razorpay.payments.fetch(razorpayPaymentId);

  if (paymentDetails.order_id !== order.razorpayOrderId) {
    throw new Error("Payment does not belong to this order");
  }

  if (paymentDetails.amount !== expectedAmountInPaise || paymentDetails.currency !== "INR") {
    throw new Error("Payment amount verification failed");
  }

  if (paymentDetails.status === "authorized") {
    paymentDetails = await razorpay.payments.capture(
      razorpayPaymentId,
      expectedAmountInPaise,
      "INR"
    );
  }

  if (!["captured", "authorized"].includes(paymentDetails.status)) {
    throw new Error(
      paymentDetails.error_description ||
        paymentDetails.error_reason ||
        "Payment has not been completed in Razorpay"
    );
  }

  return paymentDetails;
};

const requireAuth = async (req, res, next) => {
  try {
    const token = getAuthToken(req);
    const payload = verifyToken(token);
    const user = await User.findOne({ id: payload.id }).lean();

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    if (user.isActive === false) {
      return res.status(403).json({ message: "Account is inactive" });
    }

    req.user = sanitizeUser(user);
    next();
  } catch (error) {
    return res.status(401).json({ message: "Authentication required" });
  }
};

const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user?.role || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "You do not have permission for this action" });
  }

  next();
};

const requireAdmin = requireRole(...ADMIN_ROLES);

const getNextId = async (Model) => {
  const lastRecord = await Model.findOne().sort({ id: -1 }).lean();
  return (lastRecord?.id || 0) + 1;
};

const ensureSystemUser = async (email) => {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const preset = SYSTEM_USERS[normalizedEmail];

  if (!preset) {
    return null;
  }

  let user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    user = await User.create({
      id: await getNextId(User),
      name: preset.name,
      email: normalizedEmail,
      passwordHash: hashPassword(preset.password),
      role: preset.role,
      isAdmin: preset.isAdmin,
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    await Cart.updateOne(
      { userId: user.id },
      { $setOnInsert: { userId: user.id, items: [] } },
      { upsert: true }
    );
    return user;
  }

  const shouldUpdate =
    user.role !== preset.role ||
    user.isAdmin !== preset.isAdmin ||
    user.isActive === false;

  if (shouldUpdate) {
    user.role = preset.role;
    user.isAdmin = preset.isAdmin;
    user.isActive = true;
    await user.save();
  }

  return user;
};

const getOrCreateUserCart = async (userId) => {
  let cart = await Cart.findOne({ userId });
  if (!cart) {
    cart = await Cart.create({ userId, items: [] });
  }
  return cart;
};

const buildProductMap = (products) =>
  new Map(products.map((product) => [product.id, product]));

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toOptionalString = (value) => String(value || "").trim();

const parseCatalogPayload = (payload = {}) => ({
  name: toOptionalString(payload.name),
  description: toOptionalString(payload.description),
  heroImage: toOptionalString(payload.heroImage),
  gallery: normalizeStringList(payload.gallery),
  highlights: normalizeStringList(payload.highlights),
  facts: normalizeStringList(payload.facts),
  shopperNotes: normalizeStringList(payload.shopperNotes),
  sortOrder: Number.isFinite(Number(payload.sortOrder))
    ? Number(payload.sortOrder)
    : 0,
  isActive: payload.isActive !== false,
});

const formatAdminDocument = (document) => ({
  id: document.id,
  name: document.name,
  slug: document.slug,
  description: document.description || "",
  heroImage: document.heroImage || "",
  gallery: document.gallery || [],
  highlights: document.highlights || [],
  facts: document.facts || [],
  shopperNotes: document.shopperNotes || [],
  sortOrder: document.sortOrder || 0,
  isActive: document.isActive !== false,
  categoryId: document.categoryId,
  categoryName: document.categoryName,
  categorySlug: document.categorySlug,
  subcategoryId: document.subcategoryId,
  subcategoryName: document.subcategoryName,
  subcategorySlug: document.subcategorySlug,
});

const formatAdminUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role || (user.isAdmin ? "admin" : "customer"),
  isAdmin: Boolean(user.isAdmin),
  isActive: user.isActive !== false,
  createdAt: user.createdAt,
});

const getGitHubRedirectUri = () =>
  process.env.GITHUB_REDIRECT_URI ||
  `http://127.0.0.1:${PORT}/api/auth/github/callback`;

const buildGitHubUrl = (redirect = "/") => {
  const state = Buffer.from(JSON.stringify({ redirect }), "utf8").toString(
    "base64url"
  );
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: getGitHubRedirectUri(),
    scope: "read:user user:email",
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
};

const formatCartItems = (productsMap, cart) =>
  cart.items
    .map((item) => {
      const product = productsMap.get(item.productId);
      if (!product) {
        return null;
      }

      return {
        product: product.id,
        name: product.name,
        brand: product.brand,
        image: product.image,
        price: product.price,
        countInStock: product.countInStock,
        category: product.category,
        subcategory: product.subcategory,
        itemName: product.itemName,
        quantity: item.quantity,
        subtotal: product.price * item.quantity,
      };
    })
    .filter(Boolean);

const getCartSummary = async (userId) => {
  const cart = await getOrCreateUserCart(userId);
  const productIds = cart.items.map((item) => item.productId);
  const products = await Product.find(
    { id: { $in: productIds } },
    CART_PRODUCT_PROJECTION
  ).lean();
  const items = formatCartItems(buildProductMap(products), cart);
  const itemsCount = items.reduce((total, item) => total + item.quantity, 0);
  const subtotal = items.reduce((total, item) => total + item.subtotal, 0);
  const shipping = items.length > 0 ? 99 : 0;

  return {
    cart,
    items,
    summary: {
      itemsCount,
      subtotal,
      shipping,
      total: subtotal + shipping,
    },
  };
};

const buildProductFacets = async (filter) => {
  const [facetResult] = await Product.aggregate([
    { $match: filter },
    {
      $facet: {
        brands: [
          { $group: { _id: "$brand", count: { $sum: 1 } } },
          { $project: { _id: 0, name: "$_id", count: 1 } },
          { $sort: { count: -1, name: 1 } },
        ],
        items: [
          {
            $group: {
              _id: { name: "$itemName", slug: "$itemSlug" },
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              name: "$_id.name",
              slug: "$_id.slug",
              count: 1,
            },
          },
          { $sort: { count: -1, name: 1 } },
        ],
        summary: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              minPrice: { $min: "$price" },
              maxPrice: { $max: "$price" },
              averagePrice: { $avg: "$price" },
              averageRating: { $avg: { $ifNull: ["$rating", 0] } },
              totalReviews: { $sum: { $ifNull: ["$numReviews", 0] } },
              inStock: {
                $sum: {
                  $cond: [{ $gt: ["$countInStock", 0] }, 1, 0],
                },
              },
              outOfStock: {
                $sum: {
                  $cond: [{ $lte: ["$countInStock", 0] }, 1, 0],
                },
              },
              rating45: {
                $sum: {
                  $cond: [{ $gte: [{ $ifNull: ["$rating", 0] }, 4.5] }, 1, 0],
                },
              },
              rating4: {
                $sum: {
                  $cond: [{ $gte: [{ $ifNull: ["$rating", 0] }, 4] }, 1, 0],
                },
              },
              rating35: {
                $sum: {
                  $cond: [{ $gte: [{ $ifNull: ["$rating", 0] }, 3.5] }, 1, 0],
                },
              },
              rating3: {
                $sum: {
                  $cond: [{ $gte: [{ $ifNull: ["$rating", 0] }, 3] }, 1, 0],
                },
              },
            },
          },
        ],
      },
    },
  ]);

  const summary = facetResult?.summary?.[0];
  const total = summary?.total || 0;

  return {
    brands: facetResult?.brands || [],
    items: facetResult?.items || [],
    priceRange: {
      min: summary?.minPrice || 0,
      max: summary?.maxPrice || 0,
    },
    ratings: [
      { threshold: 4.5, count: summary?.rating45 || 0 },
      { threshold: 4, count: summary?.rating4 || 0 },
      { threshold: 3.5, count: summary?.rating35 || 0 },
      { threshold: 3, count: summary?.rating3 || 0 },
    ],
    stock: {
      inStock: summary?.inStock || 0,
      outOfStock: summary?.outOfStock || 0,
    },
    summary: {
      averagePrice: total ? Math.round(summary.averagePrice || 0) : 0,
      averageRating: total
        ? Number((summary.averageRating || 0).toFixed(1))
        : 0,
      totalReviews: summary?.totalReviews || 0,
    },
  };
};


module.exports = {
  DEFAULT_PAGE_SIZE, ADMIN_ROLES, HEALTH_CACHE_TTL_MS, CATALOG_CACHE_TTL_MS, 
  LIST_PRODUCT_PROJECTION, RELATED_PRODUCT_PROJECTION, CART_PRODUCT_PROJECTION, 
  SYSTEM_USERS, FRONTEND_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, razorpay,
  getId, sanitizeUser, createAuthResponse, getCachedValue, invalidateCache, getAuthToken, normalizeShippingAddress,
  markOrderAsClosed, verifyRazorpaySignature, serializeOrder, buildTransactionTimeline, serializeTransaction,
  fetchVerifiedPayment, requireAuth, requireRole, requireAdmin, getNextId, ensureSystemUser, getOrCreateUserCart,
  buildProductMap, escapeRegex, toOptionalString, parseCatalogPayload, formatAdminDocument, formatAdminUser,
  getGitHubRedirectUri, buildGitHubUrl, formatCartItems, getCartSummary, buildProductFacets
};
