require("./lib/loadEnv");

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { hashPassword, signToken, verifyPassword, verifyToken } = require("./lib/auth");
const { buildCatalog, normalizeStringList, slugify } = require("./lib/catalog");
const { connectToDatabase } = require("./lib/mongo");
const Product = require("./models/Product");
const User = require("./models/User");
const Cart = require("./models/Cart");
const Order = require("./models/Order");
const Category = require("./models/Category");
const Subcategory = require("./models/Subcategory");
const ItemGroup = require("./models/ItemGroup");

const app = express();
const PORT = process.env.PORT || 5000;
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
const razorpay =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
      })
    : null;

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3005",
      "http://localhost:3100",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3005",
      "http://127.0.0.1:3100",
    ],
    credentials: true,
  })
);
app.use(express.json());

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

app.get("/api/health", async (req, res) => {
  const payload = await getCachedValue("health", HEALTH_CACHE_TTL_MS, async () => {
    const [products, users, orders, categories, subcategories, items] = await Promise.all([
      Product.countDocuments(),
      User.countDocuments(),
      Order.countDocuments(),
      Category.countDocuments(),
      Subcategory.countDocuments(),
      ItemGroup.countDocuments(),
    ]);

    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      products,
      users,
      orders,
      categories,
      subcategories,
      items,
      githubAuthEnabled: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
      razorpayEnabled: Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET),
    };
  });

  res.json(payload);
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password || password.length < 6) {
    return res
      .status(400)
      .json({ message: "Name, email and password (min 6 chars) are required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = await User.findOne({ email: normalizedEmail }).lean();

  if (existingUser) {
    return res.status(400).json({ message: "Email already registered" });
  }

  const user = await User.create({
    id: await getNextId(User),
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    role: "customer",
    isAdmin: false,
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  await Cart.create({ userId: user.id, items: [] });
  res.status(201).json(createAuthResponse(user));
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  await ensureSystemUser(normalizedEmail);
  const user = await User.findOne({
    email: normalizedEmail,
  }).lean();

  if (!user || !verifyPassword(password || "", user.passwordHash)) {
    return res.status(401).json({ message: "Invalid email or password" });
  }
  if (user.isActive === false) {
    return res.status(403).json({ message: "Account is inactive" });
  }

  res.json(createAuthResponse(user));
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/auth/github/config", async (req, res) => {
  res.json({
    enabled: Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET),
    url:
      GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET
        ? buildGitHubUrl(String(req.query.redirect || "/"))
        : null,
  });
});

app.get("/api/payments/config", async (req, res) => {
  res.json({
    razorpayEnabled: Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET),
    keyId: RAZORPAY_KEY_ID || null,
    provider: "razorpay",
    currency: "INR",
  });
});

app.get("/api/auth/github", async (req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res
      .status(503)
      .json({ message: "GitHub OAuth is not configured on the server" });
  }

  res.redirect(buildGitHubUrl(String(req.query.redirect || "/")));
});

app.get("/api/auth/github/callback", async (req, res) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return res.redirect(
      `${FRONTEND_URL}/signin?oauthError=${encodeURIComponent(
        "GitHub OAuth is not configured on the server"
      )}`
    );
  }

  try {
    const { code, state } = req.query;
    const statePayload = state
      ? JSON.parse(Buffer.from(String(state), "base64url").toString("utf8"))
      : { redirect: "/" };

    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: getGitHubRedirectUri(),
        }),
      }
    );

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      throw new Error("GitHub authorization failed");
    }

    const githubHeaders = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "ShopZone-App",
    };

    const [profileResponse, emailsResponse] = await Promise.all([
      fetch("https://api.github.com/user", { headers: githubHeaders }),
      fetch("https://api.github.com/user/emails", { headers: githubHeaders }),
    ]);

    const profile = await profileResponse.json();
    const emails = await emailsResponse.json();
    const primaryEmail = Array.isArray(emails)
      ? emails.find((entry) => entry.primary)?.email || emails[0]?.email
      : null;

    if (!primaryEmail) {
      throw new Error("GitHub account does not expose an email address");
    }

    let user = await User.findOne({ email: primaryEmail.toLowerCase() });
    if (!user) {
      user = await User.create({
        id: await getNextId(User),
        name: profile.name || profile.login,
        email: primaryEmail.toLowerCase(),
        passwordHash: hashPassword(`github:${profile.id}:${primaryEmail}`),
        role: "customer",
        isAdmin: false,
        isActive: true,
        createdAt: new Date().toISOString(),
      });

      await Cart.create({ userId: user.id, items: [] });
    }

    const authPayload = createAuthResponse(user);
    const redirectTarget =
      statePayload && typeof statePayload.redirect === "string"
        ? statePayload.redirect
        : "/";

    const params = new URLSearchParams({
      oauthToken: authPayload.token,
      oauthUser: JSON.stringify(authPayload.user),
      redirect: redirectTarget,
    });

    return res.redirect(`${FRONTEND_URL}/signin?${params.toString()}`);
  } catch (error) {
    return res.redirect(
      `${FRONTEND_URL}/signin?oauthError=${encodeURIComponent(
        error.message || "GitHub sign in failed"
      )}`
    );
  }
});

app.get("/api/catalog", async (req, res) => {
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

app.get("/api/admin/catalog", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const [categories, subcategories, items] = await Promise.all([
    Category.find().sort({ sortOrder: 1, name: 1 }).lean(),
    Subcategory.find().sort({ categoryId: 1, sortOrder: 1, name: 1 }).lean(),
    ItemGroup.find().sort({ subcategoryId: 1, sortOrder: 1, name: 1 }).lean(),
  ]);

  res.json({
    categories: categories.map(formatAdminDocument),
    subcategories: subcategories.map(formatAdminDocument),
    items: items.map(formatAdminDocument),
  });
});

app.get("/api/admin/users", requireAuth, requireRole("admin"), async (req, res) => {
  const users = await User.find()
    .sort({ createdAt: -1, id: -1 })
    .lean();

  res.json({
    users: users.map(formatAdminUser),
    availableRoles: ["customer", "manager", "admin"],
  });
});

app.put("/api/admin/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const userId = getId(req.params.id);
  const user = await User.findOne({ id: userId });

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  const role = String(req.body.role || user.role || "customer").trim().toLowerCase();
  const isActive =
    typeof req.body.isActive === "boolean" ? req.body.isActive : user.isActive !== false;

  if (!["customer", "manager", "admin"].includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }

  const nextIsAdmin = role === "admin" || role === "manager";

  if (user.id === req.user.id && role === "customer") {
    return res.status(400).json({ message: "You cannot remove your own admin access" });
  }

  if (user.id === req.user.id && isActive === false) {
    return res.status(400).json({ message: "You cannot deactivate your own account" });
  }

  if ((user.role === "admin" || user.role === "manager") && (!nextIsAdmin || isActive === false)) {
    const activeAdminCount = await User.countDocuments({
      id: { $ne: user.id },
      role: { $in: ADMIN_ROLES },
      isActive: { $ne: false },
    });

    if (activeAdminCount === 0) {
      return res.status(400).json({
        message: "At least one active admin or manager must remain",
      });
    }
  }

  user.role = role;
  user.isAdmin = nextIsAdmin;
  user.isActive = isActive;
  await user.save();

  res.json({ user: formatAdminUser(user.toObject()) });
});

app.post("/api/admin/categories", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const payload = parseCatalogPayload(req.body);
  if (!payload.name) {
    return res.status(400).json({ message: "Category name is required" });
  }

  const slug = slugify(payload.name);
  const existing = await Category.findOne({ slug }).lean();
  if (existing) {
    return res.status(400).json({ message: "Category already exists" });
  }

  const category = await Category.create({
    id: await getNextId(Category),
    slug,
    ...payload,
  });

  invalidateCache("catalog", "health");

  res.status(201).json({ category: formatAdminDocument(category) });
});

app.put("/api/admin/categories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const category = await Category.findOne({ id: getId(req.params.id) });
  if (!category) {
    return res.status(404).json({ message: "Category not found" });
  }

  const payload = parseCatalogPayload(req.body);
  if (!payload.name) {
    return res.status(400).json({ message: "Category name is required" });
  }

  const nextSlug = slugify(payload.name);
  const slugConflict = await Category.findOne({
    id: { $ne: category.id },
    slug: nextSlug,
  }).lean();
  if (slugConflict) {
    return res.status(400).json({ message: "Category name already in use" });
  }

  const previousSlug = category.slug;
  category.set({ ...payload, slug: nextSlug });
  await category.save();

  await Promise.all([
    Subcategory.updateMany(
      { categoryId: category.id },
      {
        $set: {
          categoryName: category.name,
          categorySlug: category.slug,
        },
      }
    ),
    ItemGroup.updateMany(
      { categoryId: category.id },
      {
        $set: {
          categoryName: category.name,
          categorySlug: category.slug,
        },
      }
    ),
    Product.updateMany(
      { categorySlug: previousSlug },
      {
        $set: {
          category: category.name,
          categorySlug: category.slug,
        },
      }
    ),
  ]);

  invalidateCache("catalog", "health");

  res.json({ category: formatAdminDocument(category.toObject()) });
});

app.delete("/api/admin/categories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const categoryId = getId(req.params.id);
  const category = await Category.findOne({ id: categoryId }).lean();
  if (!category) {
    return res.status(404).json({ message: "Category not found" });
  }

  const [subcategoryCount, itemCount, productCount] = await Promise.all([
    Subcategory.countDocuments({ categoryId }),
    ItemGroup.countDocuments({ categoryId }),
    Product.countDocuments({ categorySlug: category.slug }),
  ]);

  if (subcategoryCount || itemCount || productCount) {
    return res.status(400).json({
      message:
        "Remove dependent subcategories, items, and products before deleting this category",
    });
  }

  await Category.deleteOne({ id: categoryId });
  invalidateCache("catalog", "health");
  res.json({ message: "Category deleted" });
});

app.post("/api/admin/subcategories", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const payload = parseCatalogPayload(req.body);
  const categoryId = getId(req.body.categoryId);
  const category = await Category.findOne({ id: categoryId, isActive: true }).lean();

  if (!category) {
    return res.status(400).json({ message: "Valid parent category is required" });
  }
  if (!payload.name) {
    return res.status(400).json({ message: "Subcategory name is required" });
  }

  const slug = slugify(payload.name);
  const existing = await Subcategory.findOne({ categoryId, slug }).lean();
  if (existing) {
    return res.status(400).json({ message: "Subcategory already exists in this category" });
  }

  const subcategory = await Subcategory.create({
    id: await getNextId(Subcategory),
    categoryId: category.id,
    categoryName: category.name,
    categorySlug: category.slug,
    slug,
    ...payload,
  });

  invalidateCache("catalog", "health");

  res.status(201).json({ subcategory: formatAdminDocument(subcategory) });
});

app.put("/api/admin/subcategories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const subcategory = await Subcategory.findOne({ id: getId(req.params.id) });
  if (!subcategory) {
    return res.status(404).json({ message: "Subcategory not found" });
  }

  const payload = parseCatalogPayload(req.body);
  const categoryId = getId(req.body.categoryId || subcategory.categoryId);
  const category = await Category.findOne({ id: categoryId, isActive: true }).lean();
  if (!category) {
    return res.status(400).json({ message: "Valid parent category is required" });
  }
  if (!payload.name) {
    return res.status(400).json({ message: "Subcategory name is required" });
  }

  const nextSlug = slugify(payload.name);
  const conflict = await Subcategory.findOne({
    id: { $ne: subcategory.id },
    categoryId,
    slug: nextSlug,
  }).lean();
  if (conflict) {
    return res.status(400).json({ message: "Subcategory name already in use" });
  }

  const previousSlug = subcategory.slug;
  const previousCategorySlug = subcategory.categorySlug;
  subcategory.set({
    ...payload,
    categoryId: category.id,
    categoryName: category.name,
    categorySlug: category.slug,
    slug: nextSlug,
  });
  await subcategory.save();

  await Promise.all([
    ItemGroup.updateMany(
      { subcategoryId: subcategory.id },
      {
        $set: {
          categoryId: category.id,
          categoryName: category.name,
          categorySlug: category.slug,
          subcategoryName: subcategory.name,
          subcategorySlug: subcategory.slug,
        },
      }
    ),
    Product.updateMany(
      {
        categorySlug: previousCategorySlug,
        subcategorySlug: previousSlug,
      },
      {
        $set: {
          category: category.name,
          categorySlug: category.slug,
          subcategory: subcategory.name,
          subcategorySlug: subcategory.slug,
        },
      }
    ),
  ]);

  invalidateCache("catalog", "health");

  res.json({ subcategory: formatAdminDocument(subcategory.toObject()) });
});

app.delete("/api/admin/subcategories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const subcategoryId = getId(req.params.id);
  const subcategory = await Subcategory.findOne({ id: subcategoryId }).lean();
  if (!subcategory) {
    return res.status(404).json({ message: "Subcategory not found" });
  }

  const [itemCount, productCount] = await Promise.all([
    ItemGroup.countDocuments({ subcategoryId }),
    Product.countDocuments({
      categorySlug: subcategory.categorySlug,
      subcategorySlug: subcategory.slug,
    }),
  ]);

  if (itemCount || productCount) {
    return res.status(400).json({
      message:
        "Remove dependent items and products before deleting this subcategory",
    });
  }

  await Subcategory.deleteOne({ id: subcategoryId });
  invalidateCache("catalog", "health");
  res.json({ message: "Subcategory deleted" });
});

app.post("/api/admin/items", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const payload = parseCatalogPayload(req.body);
  const categoryId = getId(req.body.categoryId);
  const subcategoryId = getId(req.body.subcategoryId);
  const [category, subcategory] = await Promise.all([
    Category.findOne({ id: categoryId, isActive: true }).lean(),
    Subcategory.findOne({ id: subcategoryId, isActive: true }).lean(),
  ]);

  if (!category || !subcategory || subcategory.categoryId !== category.id) {
    return res
      .status(400)
      .json({ message: "Valid parent category and subcategory are required" });
  }
  if (!payload.name) {
    return res.status(400).json({ message: "Item name is required" });
  }

  const slug = slugify(payload.name);
  const existing = await ItemGroup.findOne({ subcategoryId, slug }).lean();
  if (existing) {
    return res.status(400).json({ message: "Item already exists in this subcategory" });
  }

  const item = await ItemGroup.create({
    id: await getNextId(ItemGroup),
    categoryId: category.id,
    categoryName: category.name,
    categorySlug: category.slug,
    subcategoryId: subcategory.id,
    subcategoryName: subcategory.name,
    subcategorySlug: subcategory.slug,
    slug,
    ...payload,
  });

  invalidateCache("catalog", "health");

  res.status(201).json({ item: formatAdminDocument(item) });
});

app.put("/api/admin/items/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const item = await ItemGroup.findOne({ id: getId(req.params.id) });
  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  const payload = parseCatalogPayload(req.body);
  const categoryId = getId(req.body.categoryId || item.categoryId);
  const subcategoryId = getId(req.body.subcategoryId || item.subcategoryId);
  const [category, subcategory] = await Promise.all([
    Category.findOne({ id: categoryId, isActive: true }).lean(),
    Subcategory.findOne({ id: subcategoryId, isActive: true }).lean(),
  ]);

  if (!category || !subcategory || subcategory.categoryId !== category.id) {
    return res
      .status(400)
      .json({ message: "Valid parent category and subcategory are required" });
  }
  if (!payload.name) {
    return res.status(400).json({ message: "Item name is required" });
  }

  const nextSlug = slugify(payload.name);
  const conflict = await ItemGroup.findOne({
    id: { $ne: item.id },
    subcategoryId,
    slug: nextSlug,
  }).lean();
  if (conflict) {
    return res.status(400).json({ message: "Item name already in use" });
  }

  const previousSlug = item.slug;
  const previousCategorySlug = item.categorySlug;
  const previousSubcategorySlug = item.subcategorySlug;
  item.set({
    ...payload,
    categoryId: category.id,
    categoryName: category.name,
    categorySlug: category.slug,
    subcategoryId: subcategory.id,
    subcategoryName: subcategory.name,
    subcategorySlug: subcategory.slug,
    slug: nextSlug,
  });
  await item.save();

  await Product.updateMany(
    {
      categorySlug: previousCategorySlug,
      subcategorySlug: previousSubcategorySlug,
      itemSlug: previousSlug,
    },
    {
      $set: {
        category: category.name,
        categorySlug: category.slug,
        subcategory: subcategory.name,
        subcategorySlug: subcategory.slug,
        itemName: item.name,
        itemSlug: item.slug,
      },
    }
  );

  invalidateCache("catalog", "health");

  res.json({ item: formatAdminDocument(item.toObject()) });
});

app.delete("/api/admin/items/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const itemId = getId(req.params.id);
  const item = await ItemGroup.findOne({ id: itemId }).lean();
  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  const productCount = await Product.countDocuments({
    categorySlug: item.categorySlug,
    subcategorySlug: item.subcategorySlug,
    itemSlug: item.slug,
  });
  if (productCount) {
    return res.status(400).json({
      message: "Remove dependent products before deleting this item",
    });
  }

  await ItemGroup.deleteOne({ id: itemId });
  invalidateCache("catalog", "health");
  res.json({ message: "Item deleted" });
});

app.get("/api/products", async (req, res) => {
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

app.get("/api/products/:id", async (req, res) => {
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

app.post("/api/payments/razorpay-order", requireAuth, async (req, res) => {
  if (!razorpay) {
    return res
      .status(503)
      .json({ message: "Razorpay is not configured on the server" });
  }

  const shippingAddress = normalizeShippingAddress(req.body.shippingAddress);
  const requiredFields = ["fullName", "address", "city", "postalCode", "country"];
  const missingField = requiredFields.find((field) => !shippingAddress[field]);

  if (missingField) {
    return res.status(400).json({ message: "Complete shipping address is required" });
  }

  const cartSummary = await getCartSummary(req.user.id);
  if (!cartSummary.items.length) {
    return res.status(400).json({ message: "Cart is empty" });
  }

  const amountInPaise = Math.round(cartSummary.summary.total * 100);
  const receipt = `shopzone_${Date.now()}_${req.user.id}`;

  await Order.updateMany(
    {
      userId: req.user.id,
      paymentMethod: "razorpay",
      status: "payment_pending",
      paymentStatus: "pending",
    },
    {
      $set: {
        status: "payment_abandoned",
        paymentStatus: "abandoned",
        paymentCanceledAt: new Date().toISOString(),
        paymentFailureReason: "Superseded by a new checkout attempt",
      },
    }
  );

  const pendingOrder = await Order.create({
    id: await getNextId(Order),
    userId: req.user.id,
    createdAt: new Date().toISOString(),
    status: "payment_pending",
    paymentStatus: "pending",
    paymentMethod: "razorpay",
    currency: "INR",
    amountInPaise,
    receipt,
    shippingAddress,
    items: cartSummary.items,
    summary: cartSummary.summary,
  });

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt,
      notes: {
        internalOrderId: String(pendingOrder.id),
        userId: String(req.user.id),
      },
    });

    pendingOrder.razorpayOrderId = razorpayOrder.id;
    await pendingOrder.save();

    res.status(201).json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      orderId: pendingOrder.id,
      customer: {
        name: shippingAddress.fullName,
        email: req.user.email,
      },
      shippingAddress,
      items: cartSummary.items,
      transactionRequest: {
        orderId: pendingOrder.id,
        requestedAt: pendingOrder.createdAt,
        gateway: "razorpay",
        gatewayOrderId: razorpayOrder.id,
        receipt,
        currency: razorpayOrder.currency,
        amountInPaise: razorpayOrder.amount,
      },
    });
  } catch (error) {
    await Order.deleteOne({ _id: pendingOrder._id });
    res.status(400).json({ message: error.message || "Unable to start payment" });
  }
});

app.post("/api/payments/:orderId/cancel", requireAuth, async (req, res) => {
  const orderId = getId(req.params.orderId);
  const reason = String(req.body.reason || "").trim();
  const nextStatus = req.body.status === "failed" ? "failed" : "canceled";

  if (!orderId) {
    return res.status(400).json({ message: "Valid order id is required" });
  }

  const order = await Order.findOne({
    id: orderId,
    userId: req.user.id,
    paymentMethod: "razorpay",
  });

  if (!order) {
    return res.status(404).json({ message: "Payment order not found" });
  }

  if (order.paymentStatus === "paid") {
    return res.json(serializeOrder(order));
  }

  const timestamp = new Date().toISOString();
  const updates =
    nextStatus === "failed"
      ? {
          status: "payment_failed",
          paymentStatus: "failed",
          paymentFailedAt: timestamp,
          paymentFailureReason: reason || "Razorpay payment failed",
        }
      : {
          status: "payment_canceled",
          paymentStatus: "canceled",
          paymentCanceledAt: timestamp,
          paymentFailureReason: reason || "Razorpay checkout was closed",
        };

  const canceledOrder = await markOrderAsClosed(order, updates);
  res.json(serializeOrder(canceledOrder));
});

app.get("/api/payments/:orderId/status", requireAuth, async (req, res) => {
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
    return res.status(404).json({ message: "Payment order not found" });
  }

  res.json({
    transaction: serializeTransaction(order),
    order: serializeOrder(order),
    canRetryPayment: ["pending", "failed", "canceled", "abandoned"].includes(
      order.paymentStatus
    ),
  });
});

app.get("/api/transactions", requireAuth, async (req, res) => {
  const transactions = await Order.find({
    userId: req.user.id,
    paymentMethod: "razorpay",
  })
    .sort({ createdAt: -1 })
    .lean();

  res.json(transactions.map((order) => serializeTransaction(order)));
});

app.get("/api/transactions/:orderId", requireAuth, async (req, res) => {
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

app.post("/api/payments/verify", requireAuth, async (req, res) => {
  if (!razorpay) {
    return res
      .status(503)
      .json({ message: "Razorpay is not configured on the server" });
  }

  const {
    razorpay_order_id: razorpayOrderId,
    razorpay_payment_id: razorpayPaymentId,
    razorpay_signature: razorpaySignature,
  } = req.body || {};

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ message: "Incomplete Razorpay payment response" });
  }

  const order = await Order.findOne({
    razorpayOrderId: razorpayOrderId,
    userId: req.user.id,
  });

  if (!order) {
    return res.status(404).json({ message: "Payment order not found" });
  }

  if (!verifyRazorpaySignature(order.razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    return res.status(400).json({ message: "Payment signature verification failed" });
  }

  if (order.paymentStatus === "paid") {
    return res.json(serializeOrder(order));
  }

  try {
    const expectedAmountInPaise = Math.round(order.summary.total * 100);
    await fetchVerifiedPayment(order, razorpayPaymentId, expectedAmountInPaise);
  } catch (error) {
    return res.status(400).json({
      message: error.message || "Unable to verify payment with Razorpay",
    });
  }

  const sessionDb = await mongoose.startSession();

  try {
    let finalizedOrder;

    await sessionDb.withTransaction(async () => {
      for (const item of order.items) {
        const updatedProduct = await Product.findOneAndUpdate(
          { id: item.product, countInStock: { $gte: item.quantity } },
          { $inc: { countInStock: -item.quantity } },
          { new: true, session: sessionDb }
        );

        if (!updatedProduct) {
          throw new Error(`Insufficient stock for ${item.name}`);
        }
      }

      order.status = "placed";
      order.paymentStatus = "paid";
      order.razorpayPaymentId = razorpayPaymentId;
      order.razorpaySignature = razorpaySignature;
      order.paidAt = new Date().toISOString();
      order.paymentFailureReason = null;
      order.paymentFailedAt = null;
      order.paymentCanceledAt = null;
      await order.save({ session: sessionDb });

      await Cart.updateOne(
        { userId: req.user.id },
        { $set: { items: [] } },
        { session: sessionDb }
      );

      finalizedOrder = serializeOrder(order.toObject());
    });

    invalidateCache("catalog", "health");

    res.json(finalizedOrder);
  } catch (error) {
    res.status(400).json({ message: error.message || "Unable to confirm payment" });
  } finally {
    await sessionDb.endSession();
  }
});

app.post("/api/products/:id/reviews", requireAuth, async (req, res) => {
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

app.get("/api/cart", requireAuth, async (req, res) => {
  const cartSummary = await getCartSummary(req.user.id);
  res.json({ items: cartSummary.items, summary: cartSummary.summary });
});

app.post("/api/cart/items", requireAuth, async (req, res) => {
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

app.put("/api/cart/items/:id", requireAuth, async (req, res) => {
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

app.delete("/api/cart/items/:id", requireAuth, async (req, res) => {
  const productId = getId(req.params.id);
  const cart = await getOrCreateUserCart(req.user.id);

  cart.items = cart.items.filter((item) => item.productId !== productId);
  await cart.save();

  const cartSummary = await getCartSummary(req.user.id);
  res.json({ items: cartSummary.items, summary: cartSummary.summary });
});

app.get("/api/orders", requireAuth, async (req, res) => {
  const orders = await Order.find({
    userId: req.user.id,
    paymentStatus: "paid",
  })
    .sort({ createdAt: -1 })
    .lean();
  res.json(orders.map((order) => serializeOrder(order)));
});

const startServer = async () => {
  await connectToDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
