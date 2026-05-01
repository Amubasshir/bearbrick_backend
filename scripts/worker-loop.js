#!/usr/bin/env node
/**
 * Worker loop: runs enrich → aggregate repeatedly with a sleep in between.
 * Use with PM2 or Supervisor so it stays running and restarts on crash.
 *
 * Usage: node scripts/worker-loop.js
 * Env:   WORKER_LOOP_INTERVAL_MS (default 60000 = 1 minute)
 */
const path = require("path");
const { execSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(projectRoot, ".env") });

const intervalMs =
  parseInt(process.env.WORKER_LOOP_INTERVAL_MS, 10) || 60 * 1000;

function run(cmd) {
  execSync(cmd, {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      run("node src/scripts/enrich-votes.js");
      run("node src/scripts/aggregate-prices.js");
    } catch (err) {
      console.error("[worker-loop] run error:", err.message);
    }
    await sleep(intervalMs);
  }
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});
