const { PrismaClient } = require("@prisma/client");
const { execSync } = require("child_process");
const path = require("path");
const p = new PrismaClient();

async function main() {
  const BRICK_ID = "11111111-1111-4111-8111-111111111101";

  const s = await p.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });
  const cursor = await p.workerCursor.findUnique({
    where: { workerName: "price_aggregator" },
  });

  console.log("=== BEFORE REPROCESS ===");
  console.log("State weighted_total:", Number(s.weightedTotal));
  console.log("Cursor:", Number(cursor.lastProcessedId));

  // Find first unprocessed event in current cycle
  const firstUnprocessed = await p.voteEvent.findFirst({
    where: {
      brickId: BRICK_ID,
      cycleId: s.currentCycleId,
      id: { gt: cursor.lastProcessedId },
    },
    orderBy: { id: "asc" },
  });

  if (!firstUnprocessed) {
    console.log("\nNo unprocessed events. All events already processed.");
    console.log("This means events were processed but weighted_total is 0.");
    console.log("Possible reasons:");
    console.log("  1. Cycle reset happened after events were processed");
    console.log("  2. Events were processed but state update failed");
    console.log("  3. Events were skipped due to cycle mismatch");

    // Check if we can find events that should have been processed
    const eventsInCycle = await p.voteEvent.findMany({
      where: {
        brickId: BRICK_ID,
        cycleId: s.currentCycleId,
      },
      orderBy: { id: "asc" },
      take: 10,
    });

    console.log("\nFirst 10 events in current cycle:");
    eventsInCycle.forEach((e) => {
      const processed = Number(e.id) <= Number(cursor.lastProcessedId);
      console.log(
        `  ${processed ? "✅" : "❌"} ID:${Number(
          e.id
        )} Cycle:${e.cycleId.substring(
          0,
          16
        )}... State cycle:${s.currentCycleId.substring(0, 16)}... Match:${
          e.cycleId === s.currentCycleId ? "YES" : "NO"
        }`
      );
    });
  } else {
    console.log("\nFound unprocessed events. Processing...");
    execSync("node src/scripts/aggregate-prices.js", {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "inherit",
    });

    const s2 = await p.brickPriceState.findUnique({
      where: { brickId: BRICK_ID },
    });
    console.log("\n=== AFTER REPROCESS ===");
    console.log("State weighted_total:", Number(s2.weightedTotal));
  }

  await p.$disconnect();
}

main();
