const fs = require("fs/promises");
const path = require("path");
const { hashPassword } = require("./auth");
const { enrichProducts } = require("./catalog");
const seedProducts = require("../data/seedProducts");

const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "db.json");

function buildDefaultDb(products) {
  return {
    products: enrichProducts(products),
    users: [
      {
        id: 1,
        name: "Demo User",
        email: "demo@shopzone.com",
        passwordHash: hashPassword("demo123"),
        createdAt: new Date().toISOString(),
      },
    ],
    carts: [],
    orders: [],
  };
}

function migrateDb(existing) {
  const products = enrichProducts(existing.products || []);
  const users =
    Array.isArray(existing.users) && existing.users.length > 0
      ? existing.users
      : buildDefaultDb(products).users;

  const carts = Array.isArray(existing.carts)
    ? existing.carts
    : Array.isArray(existing.cartItems)
    ? [
        {
          userId: users[0].id,
          items: existing.cartItems,
        },
      ]
    : [];

  return {
    products,
    users,
    carts,
    orders: Array.isArray(existing.orders) ? existing.orders : [],
  };
}

async function ensureDb() {
  let shouldSeed = false;

  try {
    await fs.access(dbPath);
  } catch (error) {
    shouldSeed = true;
  }

  if (!shouldSeed) {
    const raw = await fs.readFile(dbPath, "utf8");
    const existing = JSON.parse(raw);
    shouldSeed =
      !Array.isArray(existing.products) || existing.products.length === 0;
  }

  if (shouldSeed) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      dbPath,
      JSON.stringify(buildDefaultDb(seedProducts), null, 2)
    );
    return;
  }

  const raw = await fs.readFile(dbPath, "utf8");
  const existing = JSON.parse(raw);
  const migrated = migrateDb(existing);
  migrated.products = enrichProducts(seedProducts);

  await fs.writeFile(dbPath, JSON.stringify(migrated, null, 2));
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(dbPath, "utf8");
  return JSON.parse(raw);
}

async function writeDb(data) {
  await fs.writeFile(dbPath, JSON.stringify(data, null, 2));
}

module.exports = {
  readDb,
  writeDb,
};
