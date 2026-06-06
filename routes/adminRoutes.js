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

router.get("/admin/catalog", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.get("/admin/users", requireAuth, requireRole("admin"), async (req, res) => {
  const users = await User.find()
    .sort({ createdAt: -1, id: -1 })
    .lean();

  res.json({
    users: users.map(formatAdminUser),
    availableRoles: ["customer", "manager", "admin"],
  });
});

router.put("/admin/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
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

router.post("/admin/categories", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.put("/admin/categories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.delete("/admin/categories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.post("/admin/subcategories", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.put("/admin/subcategories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.delete("/admin/subcategories/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.post("/admin/items", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.put("/admin/items/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

router.delete("/admin/items/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
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

module.exports = router;
