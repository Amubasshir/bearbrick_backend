const {
  calculateIntensityAndStep,
} = require("../../../../src/services/pricing/IntensityService");

describe("IntensityService", () => {
  describe("calculateIntensityAndStep", () => {
    it("intensity = max(p_under,p_over) * C", () => {
      const r = calculateIntensityAndStep(0.6, 0.2, 1, 10);
      expect(r.intensity).toBe(0.6);
      expect(r.multiplier).toBe(1 + 2 * 0.6);
      expect(r.rawStep).toBe(10 * (1 + 2 * 0.6));
    });
    it("multiplier 1x to 3x", () => {
      const r = calculateIntensityAndStep(0, 0, 0, 5);
      expect(r.multiplier).toBe(1);
      expect(r.rawStep).toBe(5);
      const r2 = calculateIntensityAndStep(1, 0, 1, 5);
      expect(r2.multiplier).toBe(3);
      expect(r2.rawStep).toBe(15);
    });
  });
});
