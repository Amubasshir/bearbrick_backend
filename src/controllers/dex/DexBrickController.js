/**
 * DexBrickController — catalogue listing, single brick detail, and FTS search.
 * All responses return BrickViewState shape (one or paginated array).
 */
const prisma = require("../../lib/prisma");
const { getViewState } = require("../../services/dex/BrickViewStateService");
const { buildStateFromRecords } = require("../../services/dex/BrickViewStateService");

/**
 * Build BrickViewState for multiple bricks efficiently (batch-loads price states).
 */
async function buildBatchViewStates(bricks, userId) {
  const brickIds = bricks.map((b) => b.id);

  // Batch load price states
  const priceStates = await prisma.brickPriceState.findMany({
    where: { brickId: { in: brickIds } },
  });
  const priceMap = new Map(priceStates.map((p) => [p.brickId, p]));

  let progressMap = new Map();
  let driverMap = new Map();

  if (userId) {
    const [progresses, drivers] = await Promise.all([
      prisma.userBrickProgress.findMany({
        where: { userId, brickId: { in: brickIds } },
      }),
      prisma.brickValueDriver.findMany({
        where: { userId, brickId: { in: brickIds } },
      }),
    ]);
    progressMap = new Map(progresses.map((p) => [p.brickId, p]));
    driverMap = new Map(drivers.map((d) => [d.brickId, d]));
  }

  return bricks.map((brick) =>
    buildStateFromRecords(
      brick,
      progressMap.get(brick.id) ?? null,
      driverMap.get(brick.id) ?? null,
      priceMap.get(brick.id) ?? null
    )
  );
}

/**
 * GET /dex/bricks?page=1&limit=20&status=PUBLISHED&series=...&featured=true
 * By default excludes PROTOTYPE bricks unless ?includePrototype=true.
 */
async function list(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const userId = req.user ? req.user.id : null;

  const where = {};

  // Status filter — default: exclude PROTOTYPE
  if (req.query.status) {
    where.status = req.query.status;
  } else if (req.query.includePrototype !== "true") {
    where.status = { not: "PROTOTYPE" };
  }

  // Series filter
  if (req.query.series) where.series = req.query.series;

  // Featured filter
  if (req.query.featured === "true") where.featured = true;

  const [bricks, total] = await Promise.all([
    prisma.brick.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip,
      take: limit,
    }),
    prisma.brick.count({ where }),
  ]);

  const data = await buildBatchViewStates(bricks, userId);

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

/**
 * GET /dex/bricks/:id
 */
async function detail(req, res) {
  const { id } = req.params;
  const userId = req.user ? req.user.id : null;

  const state = await getViewState(id, userId);
  if (!state) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  res.json({ success: true, data: state });
}

/**
 * GET /dex/search?q=string&page=1&limit=20&status=PUBLISHED&series=...&min_price=100&max_price=500
 */
async function search(req, res) {
  const q = (req.query.q || "").trim();
  if (!q) {
    return res.status(400).json({ success: false, message: "Query parameter 'q' is required." });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const userId = req.user ? req.user.id : null;

  // Build optional filter clauses for Prisma (applied after FTS id fetch)
  const priceMin = req.query.min_price ? parseFloat(req.query.min_price) : null;
  const priceMax = req.query.max_price ? parseFloat(req.query.max_price) : null;
  const statusFilter = req.query.status || null;
  const seriesFilter = req.query.series || null;

  // Use Postgres FTS via raw SQL; collect brick IDs then load via Prisma
  const rows = await prisma.$queryRaw`
    SELECT id
    FROM bricks
    WHERE search_tsv @@ plainto_tsquery('english', ${q})
    ORDER BY ts_rank(search_tsv, plainto_tsquery('english', ${q})) DESC
    LIMIT ${limit} OFFSET ${skip}
  `;

  const totalRows = await prisma.$queryRaw`
    SELECT COUNT(*) AS cnt
    FROM bricks
    WHERE search_tsv @@ plainto_tsquery('english', ${q})
  `;
  const total = Number(totalRows[0]?.cnt ?? 0);

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    return res.json({
      success: true,
      data: [],
      pagination: { page, limit, total: 0, pages: 0 },
    });
  }

  // Apply optional Prisma-level filters on top of FTS results
  const brickWhere = { id: { in: ids } };
  if (statusFilter) brickWhere.status = statusFilter;
  if (seriesFilter) brickWhere.series = seriesFilter;

  // Price range filter — join against BrickPriceState
  let priceFilterIds = null;
  if (priceMin !== null || priceMax !== null) {
    const priceStates = await prisma.brickPriceState.findMany({
      where: {
        brickId: { in: ids },
        ...(priceMin !== null ? { livePrice: { gte: priceMin } } : {}),
        ...(priceMax !== null ? { livePrice: { lte: priceMax } } : {}),
      },
      select: { brickId: true },
    });
    priceFilterIds = new Set(priceStates.map((p) => p.brickId));
  }

  const bricks = await prisma.brick.findMany({ where: brickWhere });
  // Preserve FTS relevance order; apply price filter if needed
  const brickMap = new Map(bricks.map((b) => [b.id, b]));
  const ordered = ids
    .map((id) => brickMap.get(id))
    .filter(Boolean)
    .filter((b) => priceFilterIds === null || priceFilterIds.has(b.id));

  const data = await buildBatchViewStates(ordered, userId);

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

module.exports = { list, detail, search };
