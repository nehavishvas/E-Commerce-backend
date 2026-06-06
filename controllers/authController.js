const {
  createAuthResponse,
  ensureSystemUser,
  getNextId,
  FRONTEND_URL
} = require("../lib/helpers");
const User = require("../models/User");
const Cart = require("../models/Cart");
const { hashPassword, verifyPassword } = require("../lib/auth");

const register = async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password || password.length < 6) {
    return res
      .status(400)
      .json({ message: "Name, email and password (min 6 chars) are required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = await User.findOne({ email: normalizedEmail }).lean();

  if (existingUser) {
    return res.status(400).json({ message: "Email already registered" });
  }

  const user = await User.create({
    id: await getNextId(User),
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    role: "customer",
    isAdmin: false,
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  await Cart.create({ userId: user.id, items: [] });
  res.status(201).json(createAuthResponse(user));
};

const login = async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  await ensureSystemUser(normalizedEmail);
  const user = await User.findOne({
    email: normalizedEmail,
  }).lean();

  if (!user || !verifyPassword(password || "", user.passwordHash)) {
    return res.status(401).json({ message: "Invalid email or password" });
  }
  if (user.isActive === false) {
    return res.status(403).json({ message: "Account is inactive" });
  }

  res.json(createAuthResponse(user));
};

const getMe = async (req, res) => {
  res.json({ user: req.user });
};

module.exports = {
  register,
  login,
  getMe
};
