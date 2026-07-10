'use strict';

// Shared view-shaper for a bounty_instances row (camelCase). Used by the admin
// manual-create response (3.6) and reused by the instance PATCH endpoint (3.8),
// so both emit an identical instance shape. Dates are left as Date values —
// res.json serializes them to ISO strings.
function shapeInstance(r) {
  return {
    id: r.id,
    brickId: r.brick_id,
    bountyDefinitionId: r.bounty_definition_id,
    targetField: r.target_field,
    status: r.status,
    createdBy: r.created_by,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = { shapeInstance };
