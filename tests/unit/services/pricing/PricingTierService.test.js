const {
  getBaseStep,
} = require("../../../../src/services/pricing/PricingTierService");

describe("PricingTierService", () => {
  describe("getBaseStep", () => {
    it("returns 3 for price 0-49.99", () => {
      expect(getBaseStep(0)).toBe(3);
      expect(getBaseStep(49.99)).toBe(3);
    });
    it("returns 5 for 50-99.99", () => {
      expect(getBaseStep(50)).toBe(5);
      expect(getBaseStep(99.99)).toBe(5);
    });
    it("returns 7 for 100-149.99", () => {
      expect(getBaseStep(100)).toBe(7);
      expect(getBaseStep(149.99)).toBe(7);
    });
    it("returns 10 for 150-299.99", () => {
      expect(getBaseStep(150)).toBe(10);
      expect(getBaseStep(299.99)).toBe(10);
    });
    it("returns 15 for 300-499.99", () => {
      expect(getBaseStep(300)).toBe(15);
    });
    it("returns 25 for 500-999.99", () => {
      expect(getBaseStep(500)).toBe(25);
    });
    it("returns 40 for 1000-1999.99", () => {
      expect(getBaseStep(1000)).toBe(40);
    });
    it("returns 75 for 2000+", () => {
      expect(getBaseStep(2000)).toBe(75);
      expect(getBaseStep(10000)).toBe(75);
    });
  });
});
