require("./loadEnv");

const mongoose = require("mongoose");
const { enrichProducts, buildMeta, slugify } = require("./catalog");
const { hashPassword } = require("./auth");
const seedProducts = require("../data/seedProducts");
const Product = require("../models/Product");
const User = require("../models/User");
const Category = require("../models/Category");
const Subcategory = require("../models/Subcategory");
const ItemGroup = require("../models/ItemGroup");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://surajsah0539:Surajsah97@cluster0.wstxowj.mongodb.net/ecomm?retryWrites=true&w=majority&appName=Cluster0";

let connectPromise;

function uniqueStrings(values = []) {
  return [...new Map(values.filter(Boolean).map((value) => [value, value])).values()];
}

function titleCase(value) {
  return String(value || "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function buildCategoryDocument(categoryProducts, index) {
  const sample = categoryProducts[0];
  const meta = buildMeta(categoryProducts);

  return {
    id: index + 1,
    name: sample.category,
    slug: sample.categorySlug,
    description: `Shop ${sample.category} with live inventory, price ranges, and curated item groups across top brands.`,
    heroImage: meta.featuredProduct?.image || meta.showcaseImages[0] || "",
    gallery: meta.showcaseImages,
    highlights: uniqueStrings([
      ...meta.topItems,
      ...meta.brands.slice(0, 2),
    ]).slice(0, 4),
    facts: [
      `${meta.productCount} products`,
      `${meta.inStockCount} in stock`,
      `${meta.averageRating} average rating`,
    ],
    shopperNotes: [
      meta.priceBand,
      meta.minPrice ? `Entry point from ₹${meta.minPrice.toLocaleString("en-IN")}` : "Fresh arrivals",
      meta.brands[0] ? `Top brand: ${meta.brands[0]}` : "Multi-brand catalog",
    ],
    sortOrder: index,
    isActive: true,
  };
}

function buildSubcategoryDocument(subcategoryProducts, category, index, id) {
  const sample = subcategoryProducts[0];
  const meta = buildMeta(subcategoryProducts);
  const itemCount = uniqueStrings(subcategoryProducts.map((product) => product.itemSlug)).length;

  return {
    id,
    categoryId: category.id,
    categoryName: category.name,
    categorySlug: category.slug,
    name: sample.subcategory,
    slug: sample.subcategorySlug,
    description: `Browse ${sample.subcategory} inside ${category.name} with live stock, featured brands, and updated price bands.`,
    heroImage: meta.featuredProduct?.image || meta.showcaseImages[0] || "",
    gallery: meta.showcaseImages,
    highlights: uniqueStrings([
      ...meta.topItems,
      ...meta.brands.slice(0, 2),
    ]).slice(0, 4),
    facts: [
      `${itemCount} item groups`,
      `${meta.productCount} products`,
      `${meta.averageRating} average rating`,
    ],
    shopperNotes: [
      meta.priceBand,
      meta.maxPrice ? `Premium range to ₹${meta.maxPrice.toLocaleString("en-IN")}` : "Always updating",
      meta.brands[0] ? `Featured by ${meta.brands[0]}` : "Trusted selections",
    ],
    sortOrder: index,
    isActive: true,
  };
}

function buildItemDocument(itemProducts, category, subcategory, index, id) {
  const sample = itemProducts[0];
  const meta = buildMeta(itemProducts);

  return {
    id,
    categoryId: category.id,
    categoryName: category.name,
    categorySlug: category.slug,
    subcategoryId: subcategory.id,
    subcategoryName: subcategory.name,
    subcategorySlug: subcategory.slug,
    name: sample.itemName,
    slug: sample.itemSlug,
    description: `Explore ${sample.itemName.toLowerCase()} with current pricing, stock, and product-level detail from the database.`,
    heroImage: meta.featuredProduct?.image || meta.showcaseImages[0] || "",
    gallery: meta.showcaseImages,
    highlights: uniqueStrings([
      ...Object.keys(sample.itemDetails || {}).slice(0, 2).map((key) => titleCase(slugify(key))),
      ...meta.brands.slice(0, 2),
    ]).slice(0, 4),
    sortOrder: index,
    isActive: true,
  };
}

async function seedCatalogEntities(products) {
  const categoriesBySlug = new Map();
  const subcategoriesByKey = new Map();
  const itemsByKey = new Map();

  products.forEach((product) => {
    if (!categoriesBySlug.has(product.categorySlug)) {
      categoriesBySlug.set(product.categorySlug, []);
    }
    categoriesBySlug.get(product.categorySlug).push(product);

    const subcategoryKey = `${product.categorySlug}:${product.subcategorySlug}`;
    if (!subcategoriesByKey.has(subcategoryKey)) {
      subcategoriesByKey.set(subcategoryKey, []);
    }
    subcategoriesByKey.get(subcategoryKey).push(product);

    const itemKey = `${product.categorySlug}:${product.subcategorySlug}:${product.itemSlug}`;
    if (!itemsByKey.has(itemKey)) {
      itemsByKey.set(itemKey, []);
    }
    itemsByKey.get(itemKey).push(product);
  });

  const categoryDocs = Array.from(categoriesBySlug.values()).map((entries, index) =>
    buildCategoryDocument(entries, index)
  );
  const categoryBySlug = new Map(
    categoryDocs.map((category) => [category.slug, category])
  );

  for (const category of categoryDocs) {
    await Category.updateOne({ id: category.id }, { $set: category }, { upsert: true });
  }
  await Category.deleteMany({ id: { $nin: categoryDocs.map((entry) => entry.id) } });

  const subcategoryDocs = [];
  const subcategoriesByCategorySlug = new Map();
  let subcategoryId = 1;
  for (const [key, entries] of subcategoriesByKey.entries()) {
    const [categorySlug] = key.split(":");
    if (!subcategoriesByCategorySlug.has(categorySlug)) {
      subcategoriesByCategorySlug.set(categorySlug, []);
    }

    subcategoriesByCategorySlug.get(categorySlug).push(entries);
  }

  for (const category of categoryDocs) {
    const subcategoryEntries = subcategoriesByCategorySlug.get(category.slug) || [];

    subcategoryEntries.forEach((entries, index) => {
      subcategoryDocs.push(
        buildSubcategoryDocument(entries, category, index, subcategoryId)
      );
      subcategoryId += 1;
    });
  }

  for (const subcategory of subcategoryDocs) {
    await Subcategory.updateOne(
      { id: subcategory.id },
      { $set: subcategory },
      { upsert: true }
    );
  }
  await Subcategory.deleteMany({
    id: { $nin: subcategoryDocs.map((entry) => entry.id) },
  });

  const subcategoryLookup = new Map(
    subcategoryDocs.map((subcategory) => [
      `${subcategory.categorySlug}:${subcategory.slug}`,
      subcategory,
    ])
  );

  const itemDocs = [];
  const itemCountsBySubcategoryId = new Map();
  let itemId = 1;
  for (const [key, entries] of itemsByKey.entries()) {
    const [categorySlug, subcategorySlug] = key.split(":");
    const category = categoryBySlug.get(categorySlug);
    const subcategory = subcategoryLookup.get(`${categorySlug}:${subcategorySlug}`);

    if (!category || !subcategory) {
      continue;
    }

    const siblings = itemCountsBySubcategoryId.get(subcategory.id) || 0;

    itemDocs.push(
      buildItemDocument(entries, category, subcategory, siblings, itemId)
    );
    itemCountsBySubcategoryId.set(subcategory.id, siblings + 1);
    itemId += 1;
  }

  for (const item of itemDocs) {
    await ItemGroup.updateOne({ id: item.id }, { $set: item }, { upsert: true });
  }
  await ItemGroup.deleteMany({ id: { $nin: itemDocs.map((entry) => entry.id) } });
}

async function seedUsers() {
  const defaultUsers = [
    {
      id: 1,
      name: "Demo User",
      email: "demo@shopzone.com",
      password: "demo123",
      role: "customer",
      isAdmin: false,
    },
    {
      id: 2,
      name: "Admin User",
      email: "admin@shopzone.com",
      password: "admin123",
      role: "admin",
      isAdmin: true,
    },
    {
      id: 3,
      name: "Catalog Manager",
      email: "manager@shopzone.com",
      password: "manager123",
      role: "manager",
      isAdmin: true,
    },
  ];

  const lastUser = await User.findOne().sort({ id: -1 }).lean();
  let nextUserId = (lastUser?.id || 0) + 1;

  for (const account of defaultUsers) {
    const existingUser = await User.findOne({ email: account.email });
    if (!existingUser) {
      const existingIdOwner = await User.findOne({ id: account.id }).lean();
      const userId = existingIdOwner ? nextUserId++ : account.id;

      await User.create({
        id: userId,
        name: account.name,
        email: account.email,
        passwordHash: hashPassword(account.password),
        role: account.role,
        isAdmin: account.isAdmin,
        isActive: true,
        createdAt: new Date().toISOString(),
      });
      continue;
    }

    if (
      existingUser.name !== account.name ||
      existingUser.isAdmin !== account.isAdmin ||
      existingUser.role !== account.role ||
      existingUser.isActive !== true
    ) {
      await User.updateOne(
        { email: account.email },
        {
          $set: {
            name: account.name,
            isAdmin: account.isAdmin,
            role: account.role,
            isActive: true,
          },
        }
      );
    }
  }
}

async function seedDatabase() {
  const normalizedProducts = enrichProducts(seedProducts);
  const seedIds = normalizedProducts.map((product) => product.id);

  for (const product of normalizedProducts) {
    await Product.updateOne({ id: product.id }, { $set: product }, { upsert: true });
  }
  await Product.deleteMany({ id: { $nin: seedIds } });

  await seedCatalogEntities(normalizedProducts);
  await seedUsers();
}

async function connectToDatabase() {
  if (!connectPromise) {
    connectPromise = mongoose
      .connect(MONGODB_URI)
      .then(async () => {
        await seedDatabase();
      })
      .catch((error) => {
        connectPromise = null;
        throw error;
      });
  }

  await connectPromise;
  return mongoose.connection;
}

module.exports = {
  connectToDatabase,
  MONGODB_URI,
};
