const {
  calculateFairRange,
} = require("../../../../src/services/pricing/FairRangeService");

describe("FairRangeService", () => {
  describe("calculateFairRange", () => {
    it("returns ±5% of live price", () => {
      const r = calculateFairRange(100);
      expect(r.lower).toBe(95);
      expect(r.upper).toBe(105);
    });

    it("rounds to 2 decimals", () => {
      const r = calculateFairRange(33.33);
      expect(r.lower).toBeCloseTo(31.66, 2);
      expect(r.upper).toBe(Math.round(33.33 * 1.05 * 100) / 100);
    });
  });
});
