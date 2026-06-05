const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema(
  {
    productId: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  {
    _id: false,
  }
);

const cartSchema = new mongoose.Schema(
  {
    userId: { type: Number, required: true, unique: true, index: true },
    items: { type: [cartItemSchema], default: [] },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.models.Cart || mongoose.model("Cart", cartSchema);
