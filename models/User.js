const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      required: true,
      enum: ["customer", "manager", "admin"],
      default: "customer",
      index: true,
    },
    isAdmin: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdAt: { type: String, required: true },
  },
  {
    versionKey: false,
  }
);

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
