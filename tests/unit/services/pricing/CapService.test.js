const { applyCaps } = require("../../../../src/services/pricing/CapService");

describe("CapService", () => {
  describe("applyCaps", () => {
    it("returns at least base_step", () => {
      const step = applyCaps(1, 5, 100, 50, 1, false);
      expect(step).toBeGreaterThanOrEqual(5);
    });
    it("returns rounded number", () => {
      const step = applyCaps(10.7, 5, 100, 50, 1, false);
      expect(Number.isInteger(step)).toBe(true);
    });
  });
});
