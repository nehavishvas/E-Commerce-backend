const express = require('express');
const mongoose = require('mongoose');
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

router.get("/payments/config", (req, res) => {
  res.json({
    razorpayEnabled: !!razorpay,
    keyId: RAZORPAY_KEY_ID || null,
    currency: "INR",
    provider: "razorpay",
  });
});

router.post("/payments/razorpay-order", requireAuth, async (req, res) => {
  if (!razorpay) {
    return res
      .status(503)
      .json({ message: "Razorpay is not configured on the server" });
  }

  const shippingAddress = normalizeShippingAddress(req.body.shippingAddress);
  const requiredFields = ["fullName", "address", "city", "postalCode", "country"];
  const missingField = requiredFields.find((field) => !shippingAddress[field]);

  if (missingField) {
    return res.status(400).json({ message: "Complete shipping address is required" });
  }

  const cartSummary = await getCartSummary(req.user.id);
  if (!cartSummary.items.length) {
    return res.status(400).json({ message: "Cart is empty" });
  }

  const amountInPaise = Math.round(cartSummary.summary.total * 100);
  const receipt = `shopzone_${Date.now()}_${req.user.id}`;

  await Order.updateMany(
    {
      userId: req.user.id,
      paymentMethod: "razorpay",
      status: "payment_pending",
      paymentStatus: "pending",
    },
    {
      $set: {
        status: "payment_abandoned",
        paymentStatus: "abandoned",
        paymentCanceledAt: new Date().toISOString(),
        paymentFailureReason: "Superseded by a new checkout attempt",
      },
    }
  );

  const pendingOrder = await Order.create({
    id: await getNextId(Order),
    userId: req.user.id,
    createdAt: new Date().toISOString(),
    status: "payment_pending",
    paymentStatus: "pending",
    paymentMethod: "razorpay",
    currency: "INR",
    amountInPaise,
    receipt,
    shippingAddress,
    items: cartSummary.items,
    summary: cartSummary.summary,
  });

  try {
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt,
      notes: {
        internalOrderId: String(pendingOrder.id),
        userId: String(req.user.id),
      },
    });

    pendingOrder.razorpayOrderId = razorpayOrder.id;
    await pendingOrder.save();

    res.status(201).json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      orderId: pendingOrder.id,
      customer: {
        name: shippingAddress.fullName,
        email: req.user.email,
      },
      shippingAddress,
      items: cartSummary.items,
      transactionRequest: {
        orderId: pendingOrder.id,
        requestedAt: pendingOrder.createdAt,
        gateway: "razorpay",
        gatewayOrderId: razorpayOrder.id,
        receipt,
        currency: razorpayOrder.currency,
        amountInPaise: razorpayOrder.amount,
      },
    });
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    await Order.deleteOne({ _id: pendingOrder._id });
    
    let errorMessage = "Unable to start payment";
    if (error.error && error.error.description) {
      errorMessage = error.error.description;
    } else if (error.message) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    
    res.status(400).json({ message: errorMessage });
  }
});

router.post("/payments/:orderId/cancel", requireAuth, async (req, res) => {
  const orderId = getId(req.params.orderId);
  const reason = String(req.body.reason || "").trim();
  const nextStatus = req.body.status === "failed" ? "failed" : "canceled";

  if (!orderId) {
    return res.status(400).json({ message: "Valid order id is required" });
  }

  const order = await Order.findOne({
    id: orderId,
    userId: req.user.id,
    paymentMethod: "razorpay",
  });

  if (!order) {
    return res.status(404).json({ message: "Payment order not found" });
  }

  if (order.paymentStatus === "paid") {
    return res.json(serializeOrder(order));
  }

  const timestamp = new Date().toISOString();
  const updates =
    nextStatus === "failed"
      ? {
          status: "payment_failed",
          paymentStatus: "failed",
          paymentFailedAt: timestamp,
          paymentFailureReason: reason || "Razorpay payment failed",
        }
      : {
          status: "payment_canceled",
          paymentStatus: "canceled",
          paymentCanceledAt: timestamp,
          paymentFailureReason: reason || "Razorpay checkout was closed",
        };

  const canceledOrder = await markOrderAsClosed(order, updates);
  res.json(serializeOrder(canceledOrder));
});

router.get("/payments/:orderId/status", requireAuth, async (req, res) => {
  const orderId = getId(req.params.orderId);

  if (!orderId) {
    return res.status(400).json({ message: "Valid order id is required" });
  }

  const order = await Order.findOne({
    id: orderId,
    userId: req.user.id,
    paymentMethod: "razorpay",
  }).lean();

  if (!order) {
    return res.status(404).json({ message: "Payment order not found" });
  }

  res.json({
    transaction: serializeTransaction(order),
    order: serializeOrder(order),
    canRetryPayment: ["pending", "failed", "canceled", "abandoned"].includes(
      order.paymentStatus
    ),
  });
});

router.post("/payments/verify", requireAuth, async (req, res) => {
  if (!razorpay) {
    return res
      .status(503)
      .json({ message: "Razorpay is not configured on the server" });
  }

  const {
    razorpay_order_id: razorpayOrderId,
    razorpay_payment_id: razorpayPaymentId,
    razorpay_signature: razorpaySignature,
  } = req.body || {};

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ message: "Incomplete Razorpay payment response" });
  }

  const order = await Order.findOne({
    razorpayOrderId: razorpayOrderId,
    userId: req.user.id,
  });

  if (!order) {
    return res.status(404).json({ message: "Payment order not found" });
  }

  if (!verifyRazorpaySignature(order.razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    return res.status(400).json({ message: "Payment signature verification failed" });
  }

  if (order.paymentStatus === "paid") {
    return res.json(serializeOrder(order));
  }

  try {
    const expectedAmountInPaise = Math.round(order.summary.total * 100);
    await fetchVerifiedPayment(order, razorpayPaymentId, expectedAmountInPaise);
  } catch (error) {
    return res.status(400).json({
      message: error.message || "Unable to verify payment with Razorpay",
    });
  }

  const sessionDb = await mongoose.startSession();

  try {
    let finalizedOrder;

    await sessionDb.withTransaction(async () => {
      for (const item of order.items) {
        const updatedProduct = await Product.findOneAndUpdate(
          { id: item.product, countInStock: { $gte: item.quantity } },
          { $inc: { countInStock: -item.quantity } },
          { new: true, session: sessionDb }
        );

        if (!updatedProduct) {
          throw new Error(`Insufficient stock for ${item.name}`);
        }
      }

      order.status = "placed";
      order.paymentStatus = "paid";
      order.razorpayPaymentId = razorpayPaymentId;
      order.razorpaySignature = razorpaySignature;
      order.paidAt = new Date().toISOString();
      order.paymentFailureReason = null;
      order.paymentFailedAt = null;
      order.paymentCanceledAt = null;
      await order.save({ session: sessionDb });

      await Cart.updateOne(
        { userId: req.user.id },
        { $set: { items: [] } },
        { session: sessionDb }
      );

      finalizedOrder = serializeOrder(order.toObject());
    });

    invalidateCache("catalog", "health");

    res.json(finalizedOrder);
  } catch (error) {
    res.status(400).json({ message: error.message || "Unable to confirm payment" });
  } finally {
    await sessionDb.endSession();
  }
});

module.exports = router;
