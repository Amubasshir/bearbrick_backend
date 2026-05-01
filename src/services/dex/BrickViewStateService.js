/**
 * BrickViewStateService — builds the unified BrickViewState read model.
 * Every Dex endpoint returns this shape (GET and POST mutations alike).
 */
const prisma = require("../../lib/prisma");

/**
 * render_state logic:
 *   image_mode    = brick.status !== PUBLISHED  OR  userStage < 1
 *   price_visible = brick.status === PUBLISHED  AND userStage >= 2
 */
function buildRenderState(brickStatus, userStage) {
  const imageMode = brickStatus !== "PUBLISHED" || userStage < 1;
  const priceVisible = brickStatus === "PUBLISHED" && userStage >= 2;
  return { imageMode, priceVisible };
}

/**
 * Build BrickViewState for a single brick.
 *
 * @param {object} brick        - Prisma Brick record
 * @param {object|null} progress - UserBrickProgress record (null = unauthenticated / not started)
 * @param {object|null} driver  - BrickValueDriver record (null if not at stage 3)
 * @param {object|null} priceState - BrickPriceState record (null if not found)
 * @returns {object} BrickViewState
 */
function buildState(brick, progress, driver, priceState) {
  const userStage = progress ? progress.stage : 0;
  const { imageMode, priceVisible } = buildRenderState(brick.status, userStage);

  let price = null;
  if (priceVisible && priceState) {
    const live = Number(priceState.livePrice);
    price = {
      live,
      fair_lower: Number(priceState.livePrice) * 0.95,
      fair_upper: Number(priceState.livePrice) * 1.05,
    };
  }

  let stageMeta = null;
  if (progress !== null) {
    stageMeta = {
      voted: userStage >= 2,
      vote_type: progress.voteType || null,
      value_driver: driver
        ? { axis: driver.axis, option_key: driver.optionKey }
        : null,
    };
  }

  return {
    brick_id: brick.id,
    name: imageMode ? null : brick.name,
    series: imageMode ? null : brick.series,
    colorway: imageMode ? null : brick.colorway,
    description_short: imageMode ? null : brick.descriptionShort,
    status: brick.status,
    image_url: brick.imageUrl,
    image_mode: imageMode,
    price_visible: priceVisible,
    price,
    user_stage: userStage,
    stage_meta: stageMeta,
  };
}

/**
 * Load all data needed for BrickViewState and return it.
 * Accepts optional userId (BigInt) — pass null for unauthenticated.
 */
async function getViewState(brickId, userId) {
  const [brick, priceState] = await Promise.all([
    prisma.brick.findUnique({ where: { id: brickId } }),
    prisma.brickPriceState.findUnique({ where: { brickId } }),
  ]);

  if (!brick) return null;

  let progress = null;
  let driver = null;

  if (userId) {
    [progress, driver] = await Promise.all([
      prisma.userBrickProgress.findUnique({
        where: { userId_brickId: { userId, brickId } },
      }),
      prisma.brickValueDriver.findUnique({
        where: { userId_brickId: { userId, brickId } },
      }),
    ]);
  }

  return buildState(brick, progress, driver, priceState);
}

/**
 * Build BrickViewState from already-loaded records (use inside transactions).
 * priceState may be null.
 */
function buildStateFromRecords(brick, progress, driver, priceState) {
  return buildState(brick, progress, driver, priceState);
}

module.exports = { getViewState, buildStateFromRecords };
