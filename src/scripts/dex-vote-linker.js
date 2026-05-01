/**
 * Worker: dex-vote-linker
 *   Scans UserBrickProgress records where stage >= 2 and voteEventId IS NULL,
 *   finds the corresponding processed VoteIntent, and links the VoteEvent id.
 *
 * Idempotent and replayable — already-linked rows are skipped.
 * Run: node src/scripts/dex-vote-linker.js
 */
require("dotenv").config();
const prisma = require("../lib/prisma");

const BATCH = 100;

async function main() {
  let totalLinked = 0;
  let totalSkipped = 0;

  // Process in batches until no more unlinked rows remain
  while (true) {
    const unlinked = await prisma.userBrickProgress.findMany({
      where: { stage: { gte: 2 }, voteEventId: null },
      take: BATCH,
      orderBy: [{ userId: "asc" }, { brickId: "asc" }],
    });

    if (unlinked.length === 0) break;

    for (const progress of unlinked) {
      // Find the most recent PROCESSED VoteIntent for this user+brick
      // with a non-null voteEventId (set by enrich-votes worker)
      const intent = await prisma.voteIntent.findFirst({
        where: {
          userId: progress.userId,
          brickId: progress.brickId,
          status: "PROCESSED",
          voteEventId: { not: null },
          ...(progress.voteType ? { voteType: progress.voteType } : {}),
        },
        orderBy: { createdAt: "desc" },
      });

      if (!intent || !intent.voteEventId) {
        // VoteIntent not yet processed by enrich-votes — skip for now
        totalSkipped++;
        continue;
      }

      await prisma.userBrickProgress.update({
        where: { userId_brickId: { userId: progress.userId, brickId: progress.brickId } },
        data: { voteEventId: intent.voteEventId },
      });
      totalLinked++;
    }

    // If every record in this batch was skipped (nothing can be linked yet), stop
    if (totalLinked === 0 && totalSkipped === unlinked.length) {
      console.log(
        `No progress can be made — ${totalSkipped} row(s) are waiting for enrich-votes.`
      );
      break;
    }
  }

  console.log(`dex-vote-linker: linked=${totalLinked}, skipped=${totalSkipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
