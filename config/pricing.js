require("dotenv").config();

module.exports = {
  fair_range_pct: parseFloat(process.env.PRICING_FAIR_RANGE_PCT) || 0.05,
  min_weighted_total_for_move:
    parseFloat(process.env.PRICING_MIN_WEIGHTED_TOTAL) || 5.0,
  move_batch_size_weighted:
    parseFloat(process.env.PRICING_MOVE_BATCH_SIZE) || 5.0,
  n_full_confidence: parseFloat(process.env.PRICING_N_FULL_CONFIDENCE) || 50.0,
  absolute_cap_dollars: parseFloat(process.env.PRICING_ABSOLUTE_CAP) || 80.0,
  catchup_max_pct: parseFloat(process.env.PRICING_CATCHUP_MAX_PCT) || 0.2,
  early_ramp_max_mult: parseFloat(process.env.PRICING_EARLY_RAMP_MAX) || 1.5,
  early_ramp_weighted_limit:
    parseFloat(process.env.PRICING_EARLY_RAMP_LIMIT) || 20.0,
  cycle_reset_move_pct: parseFloat(process.env.PRICING_CYCLE_RESET_PCT) || 0.07,
  cycle_reset_min_weighted:
    parseFloat(process.env.PRICING_CYCLE_RESET_MIN_WEIGHTED) || 20.0,
  cycle_reset_min_unique:
    parseInt(process.env.PRICING_CYCLE_RESET_MIN_UNIQUE, 10) || 15,
  freeze_fair_pct: parseFloat(process.env.PRICING_FREEZE_FAIR_PCT) || 0.55,
  freeze_min_weighted_total:
    parseFloat(process.env.PRICING_FREEZE_MIN_WEIGHTED) || 20.0,
  freeze_duration_days_min:
    parseInt(process.env.PRICING_FREEZE_DURATION_MIN, 10) || 14,
  freeze_duration_days_max:
    parseInt(process.env.PRICING_FREEZE_DURATION_MAX, 10) || 30,
  vote_credits_max: parseInt(process.env.PRICING_VOTE_CREDITS_MAX, 10) || 3,
  credit_regain_move_pct:
    parseFloat(process.env.PRICING_CREDIT_REGAIN_PCT) || 0.07,
  momentum_clamp_min: parseInt(process.env.PRICING_MOMENTUM_MIN, 10) || -2,
  momentum_clamp_max: parseInt(process.env.PRICING_MOMENTUM_MAX, 10) || 2,
  catchup_min_weighted_total:
    parseFloat(process.env.PRICING_CATCHUP_MIN_WEIGHTED) || 15.0,
  catchup_min_unique_voters:
    parseInt(process.env.PRICING_CATCHUP_MIN_UNIQUE, 10) || 12,
  catchup_min_dominant_pct:
    parseFloat(process.env.PRICING_CATCHUP_MIN_DOMINANT) || 0.6,
  catchup_w10_threshold: parseFloat(process.env.PRICING_CATCHUP_W10) || 0.65,
  catchup_w20_threshold: parseFloat(process.env.PRICING_CATCHUP_W20) || 0.6,
  catchup_cluster_time_seconds:
    parseInt(process.env.PRICING_CATCHUP_CLUSTER_TIME, 10) || 60,
  catchup_cluster_max_ips:
    parseInt(process.env.PRICING_CATCHUP_CLUSTER_IPS, 10) || 2,
  price_tiers: [
    { min: 0, max: 49.99, base_step: 3 },
    { min: 50, max: 99.99, base_step: 5 },
    { min: 100, max: 149.99, base_step: 7 },
    { min: 150, max: 299.99, base_step: 10 },
    { min: 300, max: 499.99, base_step: 15 },
    { min: 500, max: 999.99, base_step: 25 },
    { min: 1000, max: 1999.99, base_step: 40 },
    { min: 2000, max: Infinity, base_step: 75 },
  ],
  trust_tier_multipliers: {
    UNTRUSTED: 0.5,
    PROBATION: 0.75,
    NEUTRAL: 1.0,
    RELIABLE: 1.1,
    PROVEN: 1.2,
  },
  user_weight: {
    max_weight: 1.25,
    min_weight: 0.0,
    age_weight: { type: "linear", max_age_days: 365 },
  },
  cap_params: {
    default: { cap_min: 0.02, cap_max: 0.1 },
    tiers: {
      low: { cap_min: 0.03, cap_max: 0.1 },
      mid: { cap_min: 0.02, cap_max: 0.08 },
      high: { cap_min: 0.01, cap_max: 0.06 },
    },
  },
  recheck_stale_days:
    parseInt(process.env.PRICING_RECHECK_STALE_DAYS, 10) || 21,
  recheck_low_sample_days:
    parseInt(process.env.PRICING_RECHECK_LOW_SAMPLE_DAYS, 10) || 7,
  recheck_min_healthy_weighted:
    parseFloat(process.env.PRICING_RECHECK_MIN_HEALTHY_WEIGHTED) || 10.0,
  recheck_window_days:
    parseInt(process.env.PRICING_RECHECK_WINDOW_DAYS, 10) || 7,
  recheck_max_activations_per_7d:
    parseInt(process.env.PRICING_RECHECK_MAX_ACTIVATIONS_PER_7D, 10) || 1,
  recheck_cooldown_days:
    parseInt(process.env.PRICING_RECHECK_COOLDOWN_DAYS, 10) || 7,
  recheck_xp_multiplier:
    parseFloat(process.env.PRICING_RECHECK_XP_MULTIPLIER) || 2.0,
  trust_min_scored_votes:
    parseInt(process.env.PRICING_TRUST_MIN_SCORED_VOTES, 10) || 10,
  trust_cooldown_window_size:
    parseInt(process.env.PRICING_TRUST_COOLDOWN_WINDOW_SIZE, 10) || 5,
  trust_cooldown_misaligned_threshold:
    parseInt(process.env.PRICING_TRUST_COOLDOWN_MISALIGNED_THRESHOLD, 10) || 3,
  trust_cooldown_duration_hours:
    parseInt(process.env.PRICING_TRUST_COOLDOWN_DURATION_HOURS, 10) || 72,
  per_cycle_influence_cap_pct:
    parseFloat(process.env.PRICING_PER_CYCLE_INFLUENCE_CAP_PCT) || 0.15,
};
