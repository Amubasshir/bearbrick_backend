const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  const s = await p.brickPriceState.findUnique({
    where: { brickId: "11111111-1111-4111-8111-111111111101" },
  });
  const cursor = await p.workerCursor.findUnique({
    where: { workerName: "price_aggregator" },
  });
  const events = await p.voteEvent.findMany({
    where: {
      brickId: "11111111-1111-4111-8111-111111111101",
      cycleId: s.currentCycleId,
    },
    orderBy: { id: "asc" },
    take: 5,
    select: { id: true, voteType: true, userWeightAtVote: true },
  });

  console.log("=== DEBUG AGGREGATION ===");
  console.log("\nFirst 5 events in current cycle:");
  events.forEach((e) =>
    console.log(
      `  ID:${Number(e.id)} Type:${e.voteType} Weight:${Number(
        e.userWeightAtVote
      )}`
    )
  );
  console.log("\nCursor:", Number(cursor.lastProcessedId));
  console.log("First event ID:", Number(events[0].id));
  console.log(
    "Already processed:",
    Number(events[0].id) <= Number(cursor.lastProcessedId) ? "YES" : "NO"
  );

  const unprocessed = await p.voteEvent.count({
    where: {
      brickId: "11111111-1111-4111-8111-111111111101",
      cycleId: s.currentCycleId,
      id: { gt: cursor.lastProcessedId },
    },
  });
  console.log("Unprocessed events:", unprocessed);

  const sumWeights = await p.voteEvent.aggregate({
    where: {
      brickId: "11111111-1111-4111-8111-111111111101",
      cycleId: s.currentCycleId,
    },
    _sum: { userWeightAtVote: true },
  });

  console.log("\n=== STATE vs EVENTS ===");
  console.log("State weighted_total:", Number(s.weightedTotal));
  console.log(
    "Sum of weights in cycle:",
    Number(sumWeights._sum.userWeightAtVote || 0)
  );
  console.log(
    "Match:",
    Number(s.weightedTotal).toFixed(2) ===
      Number(sumWeights._sum.userWeightAtVote || 0).toFixed(2)
      ? "✅ YES"
      : "❌ NO"
  );

  console.log("\n=== CYCLE RESET HISTORY ===");
  const resets = await p.pricingCycleCloseEvent.findMany({
    where: { brickId: "11111111-1111-4111-8111-111111111101" },
    orderBy: { closedAt: "desc" },
    take: 3,
  });
  resets.forEach((r) => {
    console.log(
      `Closed: ${r.closedAt}, Cycle: ${r.cycleId.substring(
        0,
        16
      )}..., Price: ${Number(r.cycleStartPrice)} → ${Number(r.cycleEndPrice)}`
    );
  });

  await p.$disconnect();
}

main();
