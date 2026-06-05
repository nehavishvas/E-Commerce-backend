const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: Number, required: true },
    name: { type: String, required: true },
    brand: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true },
    countInStock: { type: Number, required: true },
    category: { type: String, required: true },
    subcategory: { type: String, required: true },
    itemName: { type: String, required: true },
    quantity: { type: Number, required: true },
    subtotal: { type: Number, required: true },
  },
  {
    _id: false,
  }
);

const orderSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true, index: true },
    userId: { type: Number, required: true, index: true },
    createdAt: { type: String, required: true },
    status: { type: String, required: true, default: "placed" },
    paymentStatus: { type: String, required: true, default: "pending" },
    paymentMethod: { type: String, required: true, default: "razorpay" },
    currency: { type: String, required: true, default: "INR" },
    amountInPaise: { type: Number, required: true, default: 0 },
    receipt: { type: String, default: null },
    razorpayOrderId: { type: String, default: null, index: true },
    razorpayPaymentId: { type: String, default: null, index: true },
    razorpaySignature: { type: String, default: null },
    paidAt: { type: String, default: null },
    paymentFailedAt: { type: String, default: null },
    paymentCanceledAt: { type: String, default: null },
    paymentFailureReason: { type: String, default: null },
    shippingAddress: {
      fullName: { type: String, required: true },
      address: { type: String, required: true },
      city: { type: String, required: true },
      postalCode: { type: String, required: true },
      country: { type: String, required: true },
    },
    items: { type: [orderItemSchema], default: [] },
    summary: {
      itemsCount: { type: Number, required: true },
      subtotal: { type: Number, required: true },
      shipping: { type: Number, required: true },
      total: { type: Number, required: true },
    },
  },
  {
    versionKey: false,
  }
);

module.exports = mongoose.models.Order || mongoose.model("Order", orderSchema);
