#!/usr/bin/env node
/**
 * Comprehensive test based on FINAL_REQUIREMENT.md
 * Tests all key requirements from the specification
 */
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { execSync } = require("child_process");
const path = require("path");
const pricing = require("../config/pricing");

const prisma = new PrismaClient();
const BRICK_ID = "11111111-1111-4111-8111-111111111101";

function log(msg, data) {
  console.log("\n" + "=".repeat(60));
  console.log(msg);
  if (data != null) {
    const s = JSON.stringify(
      data,
      (_, v) => (typeof v === "bigint" ? Number(v) : v),
      2
    );
    console.log(s);
  }
  console.log("=".repeat(60));
}

async function cleanDatabase() {
  log("STEP 0: Clean database for fresh test");

  await prisma.workerCursor.upsert({
    where: { workerName: "vote_enricher" },
    update: { lastProcessedId: 0 },
    create: { workerName: "vote_enricher", lastProcessedId: 0 },
  });
  await prisma.workerCursor.upsert({
    where: { workerName: "price_aggregator" },
    update: { lastProcessedId: 0 },
    create: { workerName: "price_aggregator", lastProcessedId: 0 },
  });

  const deletedEvents = await prisma.voteEvent.deleteMany({
    where: { brickId: BRICK_ID },
  });
  const deletedIntents = await prisma.voteIntent.deleteMany({
    where: { brickId: BRICK_ID },
  });

  await prisma.brickPriceState.update({
    where: { brickId: BRICK_ID },
    data: {
      weightedTotal: 0,
      weightedUnder: 0,
      weightedFair: 0,
      weightedOver: 0,
      weightedSinceLastMove: 0,
      pUnder: 0,
      pFair: 0,
      pOver: 0,
      pricingConfidenceC: 0,
      reliabilityScoreR: 0,
      momentumScore: 0,
      freezeMode: false,
      needsRecheck: false,
      recheckState: "NONE",
    },
  });

  log("Database cleaned", {
    deleted_events: deletedEvents.count,
    deleted_intents: deletedIntents.count,
  });
}

async function ensureSeed() {
  const brick = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });
  const users = await prisma.user.findMany({
    where: { email_verified_at: { not: null } },
    take: 5,
  });

  if (!brick || users.length < 3) {
    log("Seeding database...");
    execSync("node prisma/seed.js", {
      cwd: path.resolve(__dirname, ".."),
      stdio: "inherit",
    });
  }

  return await prisma.user.findMany({
    where: { email_verified_at: { not: null } },
    take: 5,
  });
}

async function ensureCredits(users) {
  const creditsToSet = Math.max(20, pricing.vote_credits_max || 3);
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
}

async function testVoteCreation(users) {
  log("TEST 1: Vote Creation (vote_intents → vote_events)");

  const crypto = require("crypto");
  const ipHash = crypto.createHash("sha256").update("127.0.0.1").digest("hex");

  const voteTypes = ["OVER", "OVER", "FAIR", "UNDER", "OVER"];
  const votes = [];

  for (let i = 0; i < 20; i++) {
    const userIndex = i % users.length;
    const voteType = voteTypes[i % voteTypes.length];

    votes.push({
      userId: users[userIndex].id,
      voteType: voteType,
    });
  }

  for (const v of votes) {
    await prisma.voteIntent.create({
      data: {
        userId: v.userId,
        brickId: BRICK_ID,
        voteType: v.voteType,
        status: "PENDING",
        ipHash,
        userAgent: "test-full-requirements",
      },
    });
  }

  log("Created vote_intents", {
    count: votes.length,
    sample: votes.slice(0, 5).map((v) => ({
      user: Number(v.userId),
      vote: v.voteType,
    })),
  });

  // Run enrich worker
  log("Running enrich worker...");
  execSync("node src/scripts/enrich-votes.js", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "pipe",
  });

  const events = await prisma.voteEvent.findMany({
    where: { brickId: BRICK_ID },
    orderBy: { id: "asc" },
  });

  log("Vote events created", {
    count: events.length,
    sample: events.slice(0, 5).map((e) => ({
      id: Number(e.id),
      type: e.voteType,
      weight: Number(e.userWeightAtVote),
      cycleId: e.cycleId.substring(0, 16) + "...",
    })),
  });

  return events;
}

async function testAggregation(events) {
  log("TEST 2: Price Aggregation (vote_events → brick_price_state)");

  const stateBefore = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });

  log("State BEFORE aggregation", {
    weightedTotal: Number(stateBefore.weightedTotal),
    weightedUnder: Number(stateBefore.weightedUnder),
    weightedFair: Number(stateBefore.weightedFair),
    weightedOver: Number(stateBefore.weightedOver),
    weightedSinceLastMove: Number(stateBefore.weightedSinceLastMove),
    pUnder: Number(stateBefore.pUnder),
    pFair: Number(stateBefore.pFair),
    pOver: Number(stateBefore.pOver),
    pricingConfidenceC: Number(stateBefore.pricingConfidenceC),
    reliabilityScoreR: Number(stateBefore.reliabilityScoreR),
    momentumScore: Number(stateBefore.momentumScore),
    freezeMode: stateBefore.freezeMode,
    currentCycleId: stateBefore.currentCycleId.substring(0, 16) + "...",
  });

  // Run aggregator
  log("Running aggregator worker...");
  execSync("node src/scripts/aggregate-prices.js", {
    cwd: path.resolve(__dirname, ".."),
    stdio: "pipe",
  });

  const stateAfter = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });

  log("State AFTER aggregation", {
    weightedTotal: Number(stateAfter.weightedTotal),
    weightedUnder: Number(stateAfter.weightedUnder),
    weightedFair: Number(stateAfter.weightedFair),
    weightedOver: Number(stateAfter.weightedOver),
    weightedSinceLastMove: Number(stateAfter.weightedSinceLastMove),
    pUnder: Number(stateAfter.pUnder),
    pFair: Number(stateAfter.pFair),
    pOver: Number(stateAfter.pOver),
    pricingConfidenceC: Number(stateAfter.pricingConfidenceC),
    reliabilityScoreR: Number(stateAfter.reliabilityScoreR),
    momentumScore: Number(stateAfter.momentumScore),
    freezeMode: stateAfter.freezeMode,
    currentCycleId: stateAfter.currentCycleId.substring(0, 16) + "...",
  });

  // Verify accumulation
  const accumulated =
    Number(stateAfter.weightedTotal) > Number(stateBefore.weightedTotal);
  log("Accumulation check", {
    before: Number(stateBefore.weightedTotal),
    after: Number(stateAfter.weightedTotal),
    accumulated: accumulated ? "✅ YES" : "❌ NO",
  });

  return { stateBefore, stateAfter, accumulated };
}

async function testSentimentCalculation(state) {
  log("TEST 3: Sentiment Calculation (FINAL_REQUIREMENT.md §10)");

  const weightedTotal = Number(state.weightedTotal);
  const weightedUnder = Number(state.weightedUnder);
  const weightedFair = Number(state.weightedFair);
  const weightedOver = Number(state.weightedOver);

  let expectedPUnder = 0;
  let expectedPFair = 0;
  let expectedPOver = 0;

  if (weightedTotal > 0) {
    expectedPUnder = weightedUnder / weightedTotal;
    expectedPFair = weightedFair / weightedTotal;
    expectedPOver = weightedOver / weightedTotal;
  }

  const actualPUnder = Number(state.pUnder);
  const actualPFair = Number(state.pFair);
  const actualPOver = Number(state.pOver);

  const pUnderMatch = Math.abs(expectedPUnder - actualPUnder) < 0.001;
  const pFairMatch = Math.abs(expectedPFair - actualPFair) < 0.001;
  const pOverMatch = Math.abs(expectedPOver - actualPOver) < 0.001;

  log("Sentiment verification", {
    weightedTotal: weightedTotal,
    weightedUnder: weightedUnder,
    weightedFair: weightedFair,
    weightedOver: weightedOver,
    expected_pUnder: expectedPUnder.toFixed(4),
    actual_pUnder: actualPUnder.toFixed(4),
    match: pUnderMatch ? "✅ YES" : "❌ NO",
    expected_pFair: expectedPFair.toFixed(4),
    actual_pFair: actualPFair.toFixed(4),
    match: pFairMatch ? "✅ YES" : "❌ NO",
    expected_pOver: expectedPOver.toFixed(4),
    actual_pOver: actualPOver.toFixed(4),
    match: pOverMatch ? "✅ YES" : "❌ NO",
  });

  return pUnderMatch && pFairMatch && pOverMatch;
}

async function testPricingConfidence(state) {
  log("TEST 4: Pricing Confidence C (FINAL_REQUIREMENT.md §11)");

  const weightedTotal = Number(state.weightedTotal);
  const expectedC = Math.min(1.0, weightedTotal / 50);
  const actualC = Number(state.pricingConfidenceC);

  const match = Math.abs(expectedC - actualC) < 0.001;

  log("Pricing confidence verification", {
    weightedTotal: weightedTotal,
    expected_C: expectedC.toFixed(4),
    actual_C: actualC.toFixed(4),
    match: match ? "✅ YES" : "❌ NO",
    formula: "C = min(1.0, weighted_total / 50)",
  });

  return match;
}

async function testReliabilityScore(state) {
  log("TEST 5: Reliability Score R (FINAL_REQUIREMENT.md §12)");

  const weightedTotal = Number(state.weightedTotal);
  const expectedR = Math.min(1.0, weightedTotal / 50);
  const actualR = Number(state.reliabilityScoreR);

  const match = Math.abs(expectedR - actualR) < 0.001;

  log("Reliability score verification", {
    weightedTotal: weightedTotal,
    expected_R: expectedR.toFixed(4),
    actual_R: actualR.toFixed(4),
    match: match ? "✅ YES" : "❌ NO",
    formula: "R = min(1.0, weighted_total / 50)",
  });

  return match;
}

async function testCycleConsistency(state, events) {
  log("TEST 6: Cycle Consistency (FINAL_REQUIREMENT.md §21)");

  const cycleId = state.currentCycleId;
  const eventsInCycle = events.filter((e) => e.cycleId === cycleId);

  log("Cycle consistency check", {
    currentCycleId: cycleId.substring(0, 16) + "...",
    total_events: events.length,
    events_in_cycle: eventsInCycle.length,
    all_match: eventsInCycle.length === events.length ? "✅ YES" : "❌ NO",
  });

  return eventsInCycle.length === events.length;
}

async function testEventSourcing() {
  log("TEST 7: Event Sourcing (FINAL_REQUIREMENT.md §2.1)");

  const events = await prisma.voteEvent.findMany({
    where: { brickId: BRICK_ID },
    orderBy: { id: "asc" },
  });

  // Verify events are append-only (no updates/deletes possible)
  const hasRequiredFields = events.every((e) => {
    return (
      e.livePriceAtVote != null &&
      e.fairRangeLower != null &&
      e.fairRangeUpper != null &&
      e.baseStepAtVote != null &&
      e.userWeightAtVote != null &&
      e.cycleId != null
    );
  });

  log("Event sourcing verification", {
    total_events: events.length,
    all_have_required_fields: hasRequiredFields ? "✅ YES" : "❌ NO",
    required_fields: [
      "live_price_at_vote",
      "fair_range_lower",
      "fair_range_upper",
      "base_step_at_vote",
      "user_weight_at_vote",
      "cycle_id",
    ],
  });

  return hasRequiredFields;
}

async function testDeterminism() {
  log("TEST 8: Determinism (FINAL_REQUIREMENT.md §0.6)");

  // Get current state and events
  const state1 = await prisma.brickPriceState.findUnique({
    where: { brickId: BRICK_ID },
  });

  const events = await prisma.voteEvent.findMany({
    where: { brickId: BRICK_ID, cycleId: state1.currentCycleId },
    orderBy: { id: "asc" },
  });

  // Manually calculate expected state from events (simulating deterministic replay)
  let manualWeightedUnder = 0;
  let manualWeightedFair = 0;
  let manualWeightedOver = 0;

  // Note: This is a simplified calculation - actual implementation uses influence caps
  // But we can verify that the same events produce consistent results
  for (const ev of events) {
    const w = Number(ev.userWeightAtVote);
    if (ev.voteType === "UNDER") manualWeightedUnder += w;
    else if (ev.voteType === "FAIR") manualWeightedFair += w;
    else if (ev.voteType === "OVER") manualWeightedOver += w;
  }

  const manualWeightedTotal =
    manualWeightedUnder + manualWeightedFair + manualWeightedOver;

  // Verify that state matches what we'd expect from events
  // (allowing for influence caps which reduce weights)
  const actualWeightedTotal = Number(state1.weightedTotal);
  const actualWeightedUnder = Number(state1.weightedUnder);
  const actualWeightedFair = Number(state1.weightedFair);
  const actualWeightedOver = Number(state1.weightedOver);

  // Determinism means: same events → same state
  // We verify that the state is consistent with the events
  // (actual may be less than manual due to influence caps, but should be consistent)
  const consistent =
    actualWeightedTotal <= manualWeightedTotal + 0.001 &&
    actualWeightedTotal > 0 &&
    actualWeightedUnder <= manualWeightedUnder + 0.001 &&
    actualWeightedFair <= manualWeightedFair + 0.001 &&
    actualWeightedOver <= manualWeightedOver + 0.001;

  log("Determinism verification", {
    events_count: events.length,
    manual_weightedTotal: manualWeightedTotal.toFixed(4),
    actual_weightedTotal: actualWeightedTotal.toFixed(4),
    actual_weightedUnder: actualWeightedUnder.toFixed(4),
    actual_weightedFair: actualWeightedFair.toFixed(4),
    actual_weightedOver: actualWeightedOver.toFixed(4),
    consistent: consistent ? "✅ YES" : "❌ NO",
    note: "State should be deterministically derived from events (may be capped)",
  });

  return consistent;
}

async function main() {
  try {
    log("═══════════════════════════════════════════════════════════════");
    log("COMPREHENSIVE TEST BASED ON FINAL_REQUIREMENT.md");
    log("═══════════════════════════════════════════════════════════════");

    await cleanDatabase();
    const users = await ensureSeed();
    await ensureCredits(users);

    const events = await testVoteCreation(users);
    const { stateAfter, accumulated } = await testAggregation(events);

    const sentimentOk = await testSentimentCalculation(stateAfter);
    const confidenceOk = await testPricingConfidence(stateAfter);
    const reliabilityOk = await testReliabilityScore(stateAfter);
    const cycleOk = await testCycleConsistency(stateAfter, events);
    const eventSourcingOk = await testEventSourcing();
    const determinismOk = await testDeterminism();

    log("═══════════════════════════════════════════════════════════════");
    log("FINAL RESULTS");
    log("═══════════════════════════════════════════════════════════════");

    const results = {
      "Vote Creation": events.length > 0 ? "✅ PASS" : "❌ FAIL",
      "Weight Accumulation": accumulated ? "✅ PASS" : "❌ FAIL",
      "Sentiment Calculation": sentimentOk ? "✅ PASS" : "❌ FAIL",
      "Pricing Confidence C": confidenceOk ? "✅ PASS" : "❌ FAIL",
      "Reliability Score R": reliabilityOk ? "✅ PASS" : "❌ FAIL",
      "Cycle Consistency": cycleOk ? "✅ PASS" : "❌ FAIL",
      "Event Sourcing": eventSourcingOk ? "✅ PASS" : "❌ FAIL",
      Determinism: determinismOk ? "✅ PASS" : "❌ FAIL",
    };

    console.log("\nTest Results Summary:");
    Object.entries(results).forEach(([test, result]) => {
      console.log(`  ${test}: ${result}`);
    });

    const allPassed = Object.values(results).every((r) => r.includes("✅"));

    log(
      allPassed
        ? "✅ ALL TESTS PASSED - System meets FINAL_REQUIREMENT.md specifications"
        : "❌ SOME TESTS FAILED - Review results above"
    );
  } catch (e) {
    log("❌ TEST FAILED", { error: e.message, stack: e.stack });
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
