const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    userId: { type: Number, required: true },
    name: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, required: true },
    comment: { type: String, required: true },
    createdAt: { type: String, required: true },
  },
  {
    _id: false,
  }
);

const productSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    name: { type: String, required: true },
    brand: { type: String, required: true },
    image: { type: String, required: true },
    rating: { type: Number, required: true, default: 0 },
    numReviews: { type: Number, required: true, default: 0 },
    countInStock: { type: Number, required: true, default: 0 },
    price: { type: Number, required: true },
    description: { type: String, required: true },
    category: { type: String, required: true, index: true },
    categorySlug: { type: String, required: true, index: true },
    subcategory: { type: String, required: true, index: true },
    subcategorySlug: { type: String, required: true, index: true },
    itemName: { type: String, required: true, index: true },
    itemSlug: { type: String, required: true, index: true },
    itemDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    reviews: {
      type: [reviewSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.models.Product || mongoose.model("Product", productSchema);
