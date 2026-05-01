const {
  calculateAnchorPrice,
  getMoveSign,
} = require("../../../../src/services/pricing/AnchorService");

describe("AnchorService", () => {
  describe("calculateAnchorPrice", () => {
    it("OVER returns upper range", () => {
      expect(calculateAnchorPrice("OVER", 95, 105)).toBe(105);
    });
    it("UNDER returns lower range", () => {
      expect(calculateAnchorPrice("UNDER", 95, 105)).toBe(95);
    });
    it("other returns midpoint", () => {
      expect(calculateAnchorPrice("NONE", 95, 105)).toBe(100);
    });
  });

  describe("getMoveSign", () => {
    it("OVER returns 1", () => expect(getMoveSign("OVER")).toBe(1));
    it("UNDER returns -1", () => expect(getMoveSign("UNDER")).toBe(-1));
    it("other returns 0", () => expect(getMoveSign("NONE")).toBe(0));
  });
});
