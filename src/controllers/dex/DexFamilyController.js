/**
 * DexFamilyController
 *
 *   GET /dex/families              — list all brick families
 *   GET /dex/families/:slug/bricks — bricks in a family (paginated, BrickViewState)
 */
const prisma = require("../../lib/prisma");
const { buildStateFromRecords } = require("../../services/dex/BrickViewStateService");

/**
 * GET /dex/families
 */
async function list(req, res) {
  const families = await prisma.brickFamily.findMany({
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  res.json({ success: true, data: families });
}

/**
 * GET /dex/families/:slug/bricks?page=1&limit=20
 */
async function bricks(req, res) {
  const { slug } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const userId = req.user ? req.user.id : null;

  const family = await prisma.brickFamily.findUnique({ where: { slug } });
  if (!family) {
    return res.status(404).json({ success: false, message: "Family not found." });
  }

  const [brickList, total] = await Promise.all([
    prisma.brick.findMany({
      where: { familyId: family.id, status: { not: "UNRELEASED" } },
      orderBy: { createdAt: "asc" },
      skip,
      take: limit,
    }),
    prisma.brick.count({
      where: { familyId: family.id, status: { not: "UNRELEASED" } },
    }),
  ]);

  const brickIds = brickList.map((b) => b.id);

  let progressMap = new Map();
  let driverMap = new Map();

  if (userId && brickIds.length > 0) {
    const [progresses, drivers] = await Promise.all([
      prisma.userBrickProgress.findMany({ where: { userId, brickId: { in: brickIds } } }),
      prisma.brickValueDriver.findMany({ where: { userId, brickId: { in: brickIds } } }),
    ]);
    progressMap = new Map(progresses.map((p) => [p.brickId, p]));
    driverMap = new Map(drivers.map((d) => [d.brickId, d]));
  }

  const priceStates =
    brickIds.length > 0
      ? await prisma.brickPriceState.findMany({ where: { brickId: { in: brickIds } } })
      : [];
  const priceMap = new Map(priceStates.map((p) => [p.brickId, p]));

  const data = brickList.map((brick) =>
    buildStateFromRecords(
      brick,
      progressMap.get(brick.id) ?? null,
      driverMap.get(brick.id) ?? null,
      priceMap.get(brick.id) ?? null
    )
  );

  res.json({
    success: true,
    data,
    family: { id: family.id, name: family.name, slug: family.slug },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

module.exports = { list, bricks };
