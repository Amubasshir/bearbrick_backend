/**
 * DexValueDriverOptionsController
 *
 *   GET /dex/value-driver-options — returns all valid options grouped by axis
 */
const prisma = require("../../lib/prisma");

async function list(req, res) {
  const options = await prisma.brickValueDriverOption.findMany({
    orderBy: [{ axis: "asc" }, { displayOrder: "asc" }],
  });

  // Group by axis
  const grouped = {};
  for (const opt of options) {
    if (!grouped[opt.axis]) grouped[opt.axis] = [];
    grouped[opt.axis].push({
      id: opt.id,
      option_key: opt.optionKey,
      label: opt.label,
      display_order: opt.displayOrder,
    });
  }

  res.json({ success: true, data: grouped });
}

module.exports = { list };
