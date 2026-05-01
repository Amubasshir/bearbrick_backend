const {
  handleMomentum,
  decayMomentum,
} = require("../../../../src/services/pricing/MomentumService");

describe("MomentumService", () => {
  describe("handleMomentum", () => {
    it("consumes opposite momentum first (no move)", () => {
      const r = handleMomentum(-1, "UP");
      expect(r.did_move).toBe(false);
      expect(r.momentum_score).toBe(0);
    });
    it("consumes opposite momentum first for DOWN", () => {
      const r = handleMomentum(2, "DOWN");
      expect(r.did_move).toBe(false);
      expect(r.momentum_score).toBe(1);
    });
    it("allows move and updates momentum in same direction", () => {
      const r = handleMomentum(0, "UP");
      expect(r.did_move).toBe(true);
      expect(r.momentum_score).toBe(1);
    });
    it("clamps momentum to [-2, 2]", () => {
      const r = handleMomentum(2, "UP");
      expect(r.momentum_score).toBeLessThanOrEqual(2);
    });
  });

  describe("decayMomentum", () => {
    it("reduces by 1 toward zero", () => {
      expect(decayMomentum(2)).toBe(1);
      expect(decayMomentum(-2)).toBe(-1);
      expect(decayMomentum(0)).toBe(0);
    });
  });
});
