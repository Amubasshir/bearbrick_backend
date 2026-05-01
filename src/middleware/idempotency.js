/**
 * Idempotency middleware for Dex POST mutations.
 * Reads the `Idempotency-Key` header and:
 *   - If key exists and is not expired → replay cached response
 *   - Otherwise → proceed, then cache the response after handler completes
 *
 * Usage: apply AFTER auth middleware so req.user is available.
 * The header is required when this middleware is applied.
 */
const prisma = require("../lib/prisma");

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function idempotency(options = {}) {
  const { required = true } = options;

  return async function idempotencyMiddleware(req, res, next) {
    const key = req.headers["idempotency-key"];

    if (!key) {
      if (required) {
        return res
          .status(400)
          .json({ success: false, message: "Idempotency-Key header is required." });
      }
      return next();
    }

    const userId = req.user ? req.user.id : null;
    const endpoint = `${req.method}:${req.path}`;

    // Look up existing key
    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });

    if (existing) {
      // Expired — treat as new
      if (new Date(existing.expiresAt) <= new Date()) {
        await prisma.idempotencyKey.delete({ where: { key } });
      } else {
        // Different user trying to reuse key
        if (userId && existing.userId !== userId) {
          return res
            .status(422)
            .json({ success: false, message: "Idempotency-Key belongs to a different user." });
        }
        // Replay cached response
        return res
          .status(existing.responseCode)
          .json(existing.responseBody);
      }
    }

    // Intercept res.json to cache after handler
    const originalJson = res.json.bind(res);
    res.json = async function (body) {
      // Only cache 2xx responses
      if (res.statusCode >= 200 && res.statusCode < 300 && userId) {
        try {
          await prisma.idempotencyKey.upsert({
            where: { key },
            update: {
              responseCode: res.statusCode,
              responseBody: body,
              expiresAt: new Date(Date.now() + TTL_MS),
            },
            create: {
              key,
              userId,
              endpoint,
              responseCode: res.statusCode,
              responseBody: body,
              expiresAt: new Date(Date.now() + TTL_MS),
            },
          });
        } catch (_) {
          // Non-fatal — don't block the response
        }
      }
      return originalJson(body);
    };

    req.idempotencyKey = key;
    next();
  };
}

module.exports = idempotency;
