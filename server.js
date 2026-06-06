require("./lib/loadEnv");

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { connectToDatabase } = require("./lib/mongo");
const Product = require("./models/Product");
const User = require("./models/User");
const Order = require("./models/Order");
const Category = require("./models/Category");
const Subcategory = require("./models/Subcategory");
const ItemGroup = require("./models/ItemGroup");

const {
  HEALTH_CACHE_TTL_MS,
  getCachedValue,
} = require("./lib/helpers");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors()
);
app.use(express.json());

const startServer = async () => {
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
        items
      };
    });

    res.json(payload);
  });

  app.use("/api/auth", require("./routes/authRoutes"));
  app.use('/api', require('./routes/catalogRoutes'));
  app.use('/api', require('./routes/adminRoutes'));
  app.use('/api', require('./routes/productRoutes'));
  app.use('/api', require('./routes/paymentRoutes'));
  app.use('/api', require('./routes/transactionRoutes'));
  app.use('/api', require('./routes/cartRoutes'));
  app.use('/api', require('./routes/orderRoutes'));

  await connectToDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
