/**
 * AdminFamilyController — manage brick families.
 *
 *   POST  /admin/families     — create family
 *   PATCH /admin/families/:id — update family
 */
const prisma = require("../../lib/prisma");

/**
 * POST /admin/families
 * Body: { name, slug, description?, cover_image_url?, display_order? }
 */
async function create(req, res) {
  const { name, slug, description, cover_image_url, display_order } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(422).json({ success: false, message: "name is required." });
  }
  if (!slug || typeof slug !== "string" || !slug.trim()) {
    return res.status(422).json({ success: false, message: "slug is required." });
  }

  const existing = await prisma.brickFamily.findUnique({ where: { slug: slug.trim() } });
  if (existing) {
    return res.status(409).json({ success: false, message: "A family with this slug already exists." });
  }

  const family = await prisma.brickFamily.create({
    data: {
      name: name.trim(),
      slug: slug.trim(),
      description: description?.trim() || null,
      coverImageUrl: cover_image_url?.trim() || null,
      displayOrder: typeof display_order === "number" ? display_order : 0,
    },
  });

  res.status(201).json({ success: true, data: family });
}

/**
 * PATCH /admin/families/:id
 * Body: any subset of family fields
 */
async function update(req, res) {
  const { id } = req.params;
  const { name, slug, description, cover_image_url, display_order } = req.body;

  const existing = await prisma.brickFamily.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ success: false, message: "Family not found." });
  }

  // Slug uniqueness check (excluding self)
  if (slug !== undefined) {
    const conflict = await prisma.brickFamily.findFirst({
      where: { slug: slug.trim(), id: { not: id } },
    });
    if (conflict) {
      return res.status(409).json({ success: false, message: "A family with this slug already exists." });
    }
  }

  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (slug !== undefined) data.slug = slug.trim();
  if (description !== undefined) data.description = description?.trim() || null;
  if (cover_image_url !== undefined) data.coverImageUrl = cover_image_url?.trim() || null;
  if (display_order !== undefined) data.displayOrder = Number(display_order);

  const family = await prisma.brickFamily.update({ where: { id }, data });
  res.json({ success: true, data: family });
}

module.exports = { create, update };
