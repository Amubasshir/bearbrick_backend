const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

async function auth(req, res, next) {
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
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Unauthenticated." });
    }
}

module.exports = auth;
