const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        req.user = null;
        return next();
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await prisma.user.findUnique({
            where: { id: BigInt(decoded.sub) },
        });
        req.user = user || null;
    } catch (err) {
        req.user = null;
    }
    next();
}

module.exports = optionalAuth;
