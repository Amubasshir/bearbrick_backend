const {
  calculateSentiment,
  getDominantDirection,
  getDominantPct,
} = require("../../../../src/services/pricing/SentimentService");

describe("SentimentService", () => {
  describe("calculateSentiment", () => {
    it("returns zeros when weighted total is 0", () => {
      const r = calculateSentiment(0, 0, 0);
      expect(r.p_under).toBe(0);
      expect(r.p_fair).toBe(0);
      expect(r.p_over).toBe(0);
    });

    it("returns correct ratios for under/fair/over", () => {
      const r = calculateSentiment(10, 20, 20);
      expect(r.p_under).toBe(0.2);
      expect(r.p_fair).toBe(0.4);
      expect(r.p_over).toBe(0.4);
    });

    it("sums to 1", () => {
      const r = calculateSentiment(1, 2, 3);
      expect(r.p_under + r.p_fair + r.p_over).toBeCloseTo(1);
    });
  });

  describe("getDominantDirection", () => {
    it("returns OVER when p_over > p_under", () => {
      expect(getDominantDirection(0.2, 0.5)).toBe("OVER");
    });
    it("returns UNDER when p_under > p_over", () => {
      expect(getDominantDirection(0.5, 0.2)).toBe("UNDER");
    });
    it("returns null on tie", () => {
      expect(getDominantDirection(0.4, 0.4)).toBe(null);
    });
  });

  describe("getDominantPct", () => {
    it("returns max of p_under and p_over", () => {
      expect(getDominantPct(0.3, 0.6)).toBe(0.6);
      expect(getDominantPct(0.7, 0.2)).toBe(0.7);
    });
  });
});
