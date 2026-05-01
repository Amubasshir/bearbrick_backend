/**
 * AdminValueDriverOptionController — manage valid value driver options.
 *
 *   POST   /admin/value-driver-options     — add option
 *   DELETE /admin/value-driver-options/:id — remove option
 */
const prisma = require("../../lib/prisma");

const VALID_AXES = ["A", "B", "C", "D"];

/**
 * POST /admin/value-driver-options
 * Body: { axis, option_key, label, display_order? }
 */
async function create(req, res) {
  const { axis, option_key, label, display_order } = req.body;

  if (!VALID_AXES.includes(axis)) {
    return res.status(422).json({
      success: false,
      message: `axis must be one of: ${VALID_AXES.join(", ")}.`,
    });
  }
  if (!option_key || typeof option_key !== "string" || !option_key.trim()) {
    return res.status(422).json({ success: false, message: "option_key is required." });
  }
  if (!label || typeof label !== "string" || !label.trim()) {
    return res.status(422).json({ success: false, message: "label is required." });
  }

  const existing = await prisma.brickValueDriverOption.findUnique({
    where: { axis_optionKey: { axis, optionKey: option_key.trim() } },
  });
  if (existing) {
    return res.status(409).json({ success: false, message: "Option already exists for this axis." });
  }

  const option = await prisma.brickValueDriverOption.create({
    data: {
      axis,
      optionKey: option_key.trim(),
      label: label.trim(),
      displayOrder: typeof display_order === "number" ? display_order : 0,
    },
  });

  res.status(201).json({ success: true, data: option });
}

/**
 * DELETE /admin/value-driver-options/:id
 */
async function remove(req, res) {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(422).json({ success: false, message: "Invalid id." });
  }

  const existing = await prisma.brickValueDriverOption.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ success: false, message: "Option not found." });
  }

  await prisma.brickValueDriverOption.delete({ where: { id } });
  res.json({ success: true, message: "Option deleted." });
}

module.exports = { create, remove };
