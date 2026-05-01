/**
 * Cleanup: delete expired idempotency keys (expiresAt < now()).
 * Safe to run repeatedly — all deletes are idempotent.
 * Run: node src/scripts/cleanup-idempotency-keys.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");

async function main() {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  console.log(`cleanup-idempotency-keys: deleted ${result.count} expired key(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
