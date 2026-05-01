#!/usr/bin/env node
/**
 * Script to add enough votes to trigger price movement
 * Run: node scripts/move-price.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");
const { execSync } = require("child_process");
const path = require("path");
const pricing = require("../config/pricing");

const prisma = new PrismaClient();
const BRICK_ID = "11111111-1111-4111-8111-111111111101";

async function main() {
  try {
    // Get current state
    const state = await prisma.brickPriceState.findUnique({
      where: { brickId: BRICK_ID },
    });
    if (!state) {
      console.log("Brick not found. Run seed first.");
      return;
    }

    const currentWeightedTotal = Number(state.weightedTotal);
    const currentWeightedSinceLastMove = Number(state.weightedSinceLastMove);
    const currentPrice = Number(state.livePrice);

    console.log("\n" + "=".repeat(60));
    console.log("CURRENT STATE:");
    console.log(`  Price: ${currentPrice}`);
    console.log(`  weighted_total: ${currentWeightedTotal.toFixed(2)}`);
    console.log(
      `  weighted_since_last_move: ${currentWeightedSinceLastMove.toFixed(2)}`
    );
    console.log(`  freeze_mode: ${state.freezeMode}`);
    console.log("=".repeat(60));

    // Check if already eligible
    if (
      currentWeightedTotal >= 5 &&
      currentWeightedSinceLastMove >= 5 &&
      !state.freezeMode
    ) {
      console.log("\n✅ Already eligible for price movement!");
      console.log("Running aggregator to trigger move...");
      execSync("node src/scripts/aggregate-prices.js", {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        stdio: "inherit",
      });
      return;
    }

    // Calculate votes needed
    const votesNeeded = Math.ceil((5 - currentWeightedSinceLastMove) / 0.05);
    const votesToCreate = Math.min(Math.max(votesNeeded, 5), 50); // At least 5, max 50

    console.log(
      `\n📊 Need ${votesNeeded} more votes (creating ${votesToCreate})`
    );

    // Get users
    const users = await prisma.user.findMany({
      where: { email_verified_at: { not: null } },
      take: 3,
    });
    if (users.length < 2) {
      console.log("Not enough users. Run seed first.");
      return;
    }

    // Ensure credits
    const creditsToSet = 50; // Enough for many votes
    for (const user of users) {
      await prisma.userBrickVoteCredit.upsert({
        where: { userId_brickId: { userId: user.id, brickId: BRICK_ID } },
        create: {
          userId: user.id,
          brickId: BRICK_ID,
          creditsRemaining: creditsToSet,
        },
        update: { creditsRemaining: creditsToSet },
      });
    }

    // Create votes (more OVER votes to push price up)
    const ipHash = crypto
      .createHash("sha256")
      .update("127.0.0.1")
      .digest("hex");
    console.log(`\n📝 Creating ${votesToCreate} vote_intents...`);

    for (let i = 0; i < votesToCreate; i++) {
      const userIndex = i % users.length;
      // 60% OVER, 20% FAIR, 20% UNDER
      const mod = i % 5;
      const voteType = mod < 3 ? "OVER" : mod === 3 ? "FAIR" : "UNDER";

      await prisma.voteIntent.create({
        data: {
          userId: users[userIndex].id,
          brickId: BRICK_ID,
          voteType: voteType,
          status: "PENDING",
          ipHash,
          userAgent: "move-price-script",
        },
      });
    }

    console.log("✅ Vote intents created");

    // Run enrich
    console.log("\n🔄 Running enrich worker...");
    execSync("node src/scripts/enrich-votes.js", {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "inherit",
    });

    // Run aggregate
    console.log("\n🔄 Running aggregator...");
    execSync("node src/scripts/aggregate-prices.js", {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "inherit",
    });

    // Check final state
    const finalState = await prisma.brickPriceState.findUnique({
      where: { brickId: BRICK_ID },
    });
    const finalPrice = Number(finalState.livePrice);
    const finalWeightedTotal = Number(finalState.weightedTotal);
    const finalWeightedSinceLastMove = Number(finalState.weightedSinceLastMove);

    console.log("\n" + "=".repeat(60));
    console.log("FINAL STATE:");
    console.log(
      `  Price: ${finalPrice} ${
        finalPrice !== currentPrice ? "✅ CHANGED!" : "(unchanged)"
      }`
    );
    console.log(`  weighted_total: ${finalWeightedTotal.toFixed(2)}`);
    console.log(
      `  weighted_since_last_move: ${finalWeightedSinceLastMove.toFixed(2)}`
    );
    console.log(`  p_over: ${Number(finalState.pOver).toFixed(2)}`);
    console.log(`  p_under: ${Number(finalState.pUnder).toFixed(2)}`);
    console.log("=".repeat(60));

    if (finalPrice !== currentPrice) {
      console.log(`\n🎉 Price moved from ${currentPrice} to ${finalPrice}!`);
    } else {
      console.log(
        `\n⚠️  Price did not move. Need more votes or check conditions.`
      );
    }
  } catch (e) {
    console.error("Error:", e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
