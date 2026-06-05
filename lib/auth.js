const crypto = require("crypto");

const JWT_SECRET = process.env.JWT_SECRET || "shopzone-dev-secret";
const TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 7;

const encode = (value) => Buffer.from(value).toString("base64url");
const decode = (value) => Buffer.from(value, "base64url").toString("utf8");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) {
    return false;
  }

  const [salt, expectedHash] = storedHash.split(":");
  const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(passwordHash, "hex"),
    Buffer.from(expectedHash, "hex")
  );
}

function signToken(payload) {
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS;
  const body = encode(JSON.stringify({ ...payload, exp }));
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) {
    throw new Error("Missing token");
  }

  const [header, body, signature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  if (!signature || signature !== expectedSignature) {
    throw new Error("Invalid token");
  }

  const payload = JSON.parse(decode(body));

  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return payload;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
};
