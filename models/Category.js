const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
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

module.exports =
  mongoose.models.Category || mongoose.model("Category", categorySchema);
