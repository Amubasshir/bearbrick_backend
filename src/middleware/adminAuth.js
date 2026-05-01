/**
 * adminAuth middleware — grants access if:
 *   1. X-Admin-Secret header matches process.env.ADMIN_SECRET, OR
 *   2. Valid JWT + user.isAdmin === true
 */
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

async function adminAuth(req, res, next) {
  // Option 1: static secret header (for scripts, CI, manual admin ops)
  const secret = req.headers["x-admin-secret"];
  if (secret && process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET) {
    req.user = null; // no user context in secret-mode
    return next();
  }

  // Option 2: JWT + isAdmin flag
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthenticated." });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: BigInt(decoded.sub) },
    });
    if (!user) {
      return res.status(401).json({ message: "Unauthenticated." });
    }
    if (!user.isAdmin) {
      return res.status(403).json({ message: "Forbidden." });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthenticated." });
  }
}

module.exports = adminAuth;
