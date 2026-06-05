const mongoose = require("mongoose");

const subcategorySchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    categoryId: { type: Number, required: true, index: true },
    categoryName: { type: String, required: true },
    categorySlug: { type: String, required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, index: true },
    description: { type: String, default: "" },
    heroImage: { type: String, default: "" },
    gallery: { type: [String], default: [] },
    highlights: { type: [String], default: [] },
    facts: { type: [String], default: [] },
    shopperNotes: { type: [String], default: [] },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

subcategorySchema.index({ categoryId: 1, slug: 1 }, { unique: true });

module.exports =
  mongoose.models.Subcategory || mongoose.model("Subcategory", subcategorySchema);
