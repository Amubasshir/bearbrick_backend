const {
  shouldEnterFreeze,
  shouldExitFreeze,
  exitFreeze,
} = require("../../../../src/services/pricing/FreezeService");

describe("FreezeService", () => {
  describe("shouldEnterFreeze", () => {
    it("requires p_fair >= 0.55 and weighted_total >= 20", () => {
      expect(shouldEnterFreeze({ pFair: 0.55, weightedTotal: 20 })).toBe(true);
      expect(shouldEnterFreeze({ pFair: 0.54, weightedTotal: 20 })).toBe(false);
      expect(shouldEnterFreeze({ pFair: 0.55, weightedTotal: 19 })).toBe(false);
    });
  });

  describe("shouldExitFreeze", () => {
    it("returns false when not in freeze", () => {
      expect(shouldExitFreeze({ freezeMode: false })).toBe(false);
    });
    it("returns true when needs_recheck", () => {
      expect(shouldExitFreeze({ freezeMode: true, needsRecheck: true })).toBe(
        true,
      );
    });
  });

  describe("exitFreeze", () => {
    it("returns freezeMode false and freezeUntil null", () => {
      const r = exitFreeze();
      expect(r.freezeMode).toBe(false);
      expect(r.freezeUntil).toBe(null);
    });
  });
});
