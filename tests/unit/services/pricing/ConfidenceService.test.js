const {
  calculatePricingConfidence,
} = require("../../../../src/services/pricing/ConfidenceService");

describe("ConfidenceService", () => {
  describe("calculatePricingConfidence", () => {
    it("returns 0 for weighted_total 0", () => {
      expect(calculatePricingConfidence(0)).toBe(0);
    });
    it("returns min(1, weighted_total/50)", () => {
      expect(calculatePricingConfidence(25)).toBe(0.5);
      expect(calculatePricingConfidence(50)).toBe(1);
      expect(calculatePricingConfidence(100)).toBe(1);
    });
  });
});
