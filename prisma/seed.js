require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const password = await bcrypt.hash("password123", 10);
  const users = [
    {
      name: "Admin User",
      email: "admin@example.com",
      password,
      email_verified_at: new Date(),
    },
    {
      name: "User 1",
      email: "user1@example.com",
      password,
      email_verified_at: new Date(),
    },
    {
      name: "User 2",
      email: "user2@example.com",
      password,
      email_verified_at: new Date(),
    },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: u,
    });
  }
  console.log("Seeded users.");

  // RFC 4122 UUIDs (version 4, variant 8) for API validation
  const bricks = [
    { brickId: "11111111-1111-4111-8111-111111111101", baseline_price: 150 },
    { brickId: "11111111-1111-4111-8111-111111111102", baseline_price: 500 },
    { brickId: "11111111-1111-4111-8111-111111111103", baseline_price: 300 },
    { brickId: "11111111-1111-4111-8111-111111111104", baseline_price: 250 },
    { brickId: "11111111-1111-4111-8111-111111111105", baseline_price: 800 },
  ];
  for (const b of bricks) {
    await prisma.brickPriceState.upsert({
      where: { brickId: b.brickId },
      update: {},
      create: {
        brickId: b.brickId,
        baselinePrice: b.baseline_price,
        livePrice: b.baseline_price,
        currentCycleId: uuidv4(),
        cycleStartPrice: b.baseline_price,
        cycleStartedAt: new Date(),
      },
    });
  }
  console.log("Seeded 5 bricks.");

  // Dex brick catalogue — same UUIDs as BrickPriceState entries
  const catalog = [
    {
      id: "11111111-1111-4111-8111-111111111101",
      name: "BE@RBRICK Series 1 Black",
      descriptionShort: "Classic 100% BE@RBRICK from Series 1 in matte black.",
      series: "Series 1",
      colorway: "Black",
      status: "PUBLISHED",
    },
    {
      id: "11111111-1111-4111-8111-111111111102",
      name: "BE@RBRICK Series 2 Gold",
      descriptionShort: "Rare 400% BE@RBRICK from Series 2 in metallic gold.",
      series: "Series 2",
      colorway: "Gold",
      status: "PUBLISHED",
    },
    {
      id: "11111111-1111-4111-8111-111111111103",
      name: "BE@RBRICK Series 1 White",
      descriptionShort: "Clean 100% BE@RBRICK from Series 1 in crisp white.",
      series: "Series 1",
      colorway: "White",
      status: "PUBLISHED",
    },
    {
      id: "11111111-1111-4111-8111-111111111104",
      name: "BE@RBRICK Series 3 Blue",
      descriptionShort: "Limited 400% BE@RBRICK from Series 3 in cobalt blue.",
      series: "Series 3",
      colorway: "Blue",
      status: "PUBLISHED",
    },
    {
      id: "11111111-1111-4111-8111-111111111105",
      name: "BE@RBRICK Collab Red",
      descriptionShort: "Collab edition 1000% BE@RBRICK in vibrant red.",
      series: "Collab",
      colorway: "Red",
      status: "PUBLISHED",
    },
  ];
  for (const c of catalog) {
    await prisma.brick.upsert({
      where: { id: c.id },
      update: {},
      create: {
        ...c,
        releasedAt: new Date(),
      },
    });
  }
  console.log("Seeded 5 Dex brick catalogue entries.");
}

async function seedValueDriverOptions() {
  const defaults = [
    { axis: "A", optionKey: "rarity",       label: "Rarity / Scarcity",          displayOrder: 1 },
    { axis: "A", optionKey: "collab",        label: "Collab / Artist Edition",    displayOrder: 2 },
    { axis: "A", optionKey: "series",        label: "Series Exclusivity",         displayOrder: 3 },
    { axis: "B", optionKey: "condition",     label: "Condition / Grading",        displayOrder: 1 },
    { axis: "B", optionKey: "packaging",     label: "Original Packaging",         displayOrder: 2 },
    { axis: "B", optionKey: "authenticity",  label: "Authenticity / Provenance",  displayOrder: 3 },
    { axis: "C", optionKey: "demand",        label: "Current Market Demand",      displayOrder: 1 },
    { axis: "C", optionKey: "trend",         label: "Hype / Trend Driven",        displayOrder: 2 },
    { axis: "C", optionKey: "media",         label: "Media / Cultural Moment",    displayOrder: 3 },
    { axis: "D", optionKey: "size",          label: "Size Variant (100/400/1000%)", displayOrder: 1 },
    { axis: "D", optionKey: "colorway",      label: "Colorway Appeal",            displayOrder: 2 },
    { axis: "D", optionKey: "design",        label: "Design / Aesthetic",         displayOrder: 3 },
  ];
  for (const opt of defaults) {
    await prisma.brickValueDriverOption.upsert({
      where: { axis_optionKey: { axis: opt.axis, optionKey: opt.optionKey } },
      update: {},
      create: opt,
    });
  }
  console.log("Seeded default BrickValueDriverOptions.");
}

main()
  .then(() => seedValueDriverOptions())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
