/**
 * AdminBrickController — manage the Dex brick catalogue.
 * Requires adminAuth middleware.
 */
const prisma = require("../../lib/prisma");

const VALID_STATUSES = ["UNRELEASED", "PROTOTYPE", "PUBLISHED"];

/**
 * POST /admin/bricks
 * Body: { name, description_short, description_long?, series?, colorway?, image_url?,
 *         thumbnail_url?, edition_size?, retail_price?, featured?, tags?, family_id?, status? }
 */
async function create(req, res) {
  const {
    name,
    description_short,
    description_long,
    series,
    colorway,
    image_url,
    thumbnail_url,
    edition_size,
    retail_price,
    featured,
    tags,
    family_id,
    status,
  } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(422).json({ success: false, message: "name is required." });
  }
  if (!description_short || typeof description_short !== "string" || !description_short.trim()) {
    return res.status(422).json({ success: false, message: "description_short is required." });
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(422).json({
      success: false,
      message: `status must be one of: ${VALID_STATUSES.join(", ")}.`,
    });
  }
  if (family_id) {
    const family = await prisma.brickFamily.findUnique({ where: { id: family_id } });
    if (!family) {
      return res.status(422).json({ success: false, message: "family_id references a non-existent family." });
    }
  }

  const brick = await prisma.brick.create({
    data: {
      name: name.trim(),
      descriptionShort: description_short.trim(),
      descriptionLong: description_long?.trim() || null,
      series: series?.trim() || null,
      colorway: colorway?.trim() || null,
      imageUrl: image_url?.trim() || null,
      thumbnailUrl: thumbnail_url?.trim() || null,
      editionSize: edition_size != null ? parseInt(edition_size) : null,
      retailPrice: retail_price != null ? retail_price : null,
      featured: typeof featured === "boolean" ? featured : false,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      familyId: family_id || null,
      status: status || "UNRELEASED",
      releasedAt: status === "PUBLISHED" ? new Date() : null,
    },
  });

  res.status(201).json({ success: true, data: brick });
}

/**
 * PATCH /admin/bricks/:id
 * Body: any subset of Brick fields
 */
async function update(req, res) {
  const { id } = req.params;
  const {
    name,
    description_short,
    description_long,
    series,
    colorway,
    image_url,
    thumbnail_url,
    edition_size,
    retail_price,
    featured,
    tags,
    family_id,
    status,
  } = req.body;

  const existing = await prisma.brick.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ success: false, message: "Brick not found." });
  }

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(422).json({
      success: false,
      message: `status must be one of: ${VALID_STATUSES.join(", ")}.`,
    });
  }
  if (family_id !== undefined && family_id !== null) {
    const family = await prisma.brickFamily.findUnique({ where: { id: family_id } });
    if (!family) {
      return res.status(422).json({ success: false, message: "family_id references a non-existent family." });
    }
  }

  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (description_short !== undefined) data.descriptionShort = description_short.trim();
  if (description_long !== undefined) data.descriptionLong = description_long?.trim() || null;
  if (series !== undefined) data.series = series?.trim() || null;
  if (colorway !== undefined) data.colorway = colorway?.trim() || null;
  if (image_url !== undefined) data.imageUrl = image_url?.trim() || null;
  if (thumbnail_url !== undefined) data.thumbnailUrl = thumbnail_url?.trim() || null;
  if (edition_size !== undefined) data.editionSize = edition_size != null ? parseInt(edition_size) : null;
  if (retail_price !== undefined) data.retailPrice = retail_price;
  if (featured !== undefined) data.featured = Boolean(featured);
  if (tags !== undefined) data.tags = Array.isArray(tags) ? tags.map(String) : [];
  if (family_id !== undefined) data.familyId = family_id || null;
  if (status !== undefined) {
    data.status = status;
    // Set releasedAt when first publishing
    if (status === "PUBLISHED" && existing.status !== "PUBLISHED") {
      data.releasedAt = new Date();
    }
  }

  const brick = await prisma.brick.update({ where: { id }, data });
  res.json({ success: true, data: brick });
}

module.exports = { create, update };
