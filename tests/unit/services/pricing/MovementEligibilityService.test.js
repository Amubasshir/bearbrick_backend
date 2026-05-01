const {
  isEligibleForMovement,
} = require("../../../../src/services/pricing/MovementEligibilityService");

describe("MovementEligibilityService", () => {
  describe("isEligibleForMovement", () => {
    it("returns false when weighted_total < 5", () => {
      expect(
        isEligibleForMovement({
          weightedTotal: 3,
          weightedSinceLastMove: 5,
          freezeMode: false,
        }),
      ).toBe(false);
    });
    it("returns false when weighted_since_last_move < 5", () => {
      expect(
        isEligibleForMovement({
          weightedTotal: 10,
          weightedSinceLastMove: 2,
          freezeMode: false,
        }),
      ).toBe(false);
    });
    it("returns false when freeze_mode is true", () => {
      expect(
        isEligibleForMovement({
          weightedTotal: 10,
          weightedSinceLastMove: 10,
          freezeMode: true,
        }),
      ).toBe(false);
    });
    it("returns true when all conditions met", () => {
      expect(
        isEligibleForMovement({
          weightedTotal: 10,
          weightedSinceLastMove: 10,
          freezeMode: false,
        }),
      ).toBe(true);
    });
  });
});
