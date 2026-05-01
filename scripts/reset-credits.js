#!/usr/bin/env node
/**
 * Reset all user_brick_vote_credits (for testing only).
 * Usage: node scripts/reset-credits.js
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const pricing = require("../config/pricing");
  const credits = await prisma.userBrickVoteCredit.findMany();
  for (const c of credits) {
    await prisma.userBrickVoteCredit.update({
      where: { userId_brickId: { userId: c.userId, brickId: c.brickId } },
      data: {
        creditsRemaining: pricing.vote_credits_max,
        lastVotePrice: null,
        lastVoteCycleId: null,
        lastVoteAt: null,
        lastCreditRegainPrice: null,
        lastCreditRegainAt: null,
      },
    });
  }
  console.log(
    "Reset",
    credits.length,
    "user_brick_vote_credits to",
    pricing.vote_credits_max,
    "credits each.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
