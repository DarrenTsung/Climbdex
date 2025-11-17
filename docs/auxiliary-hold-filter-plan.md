# Auxiliary Hold Filter Feature - Planning Document

## Overview
Add filtering capability to find climbs that use at least one hold from the Auxiliary pack (set_id: 27) on the Kilter 7x10 homewall.

## Problem Statement
Users with the Full Ride setup (both Mainline + Auxiliary) want to find climbs that take advantage of the auxiliary holds - typically harder, crimpier problems that use the denser hold configuration. Currently, there's no way to identify which climbs use auxiliary holds vs only using the mainline holds.

**Use Case**: "I have both hold sets. Show me climbs that actually use the auxiliary holds since those tend to be harder/more interesting."

## Database Analysis

### Key Tables
- **placements**: Maps placement_id → set_id (26=Mainline, 27=Auxiliary)
  - Layout 8 has 234 Mainline placements and 238 Auxiliary placements
- **climbs**: Contains `frames` field with encoded hold sequences like `p4119r45p4139r45...`
  - `p{placement_id}` identifies which hold is used

### Current Set Distribution (Layout 8)
- Set 26 (Mainline): 234 placements
- Set 27 (Auxiliary): 238 placements
- Set 28 (Mainline Kickboard): 13 placements
- Set 29 (Auxiliary Kickboard): 14 placements

## Key Design Decisions

### 1. Filter Scope
**Decision Options:**
- **Option A**: Simple "Uses Auxiliary Holds" checkbox (RECOMMENDED)
  - Pros: Simple UI, clear intent, easy to implement
  - Cons: No granularity, binary yes/no only

- **Option B**: Min auxiliary hold count selector ("At least X auxiliary holds")
  - Pros: Find climbs that heavily use auxiliary holds
  - Cons: Requires counting holds per climb, more complex UI

- **Option C**: Percentage-based ("At least X% auxiliary holds")
  - Pros: Accounts for different climb lengths
  - Cons: Complex calculation, unclear what percentage is meaningful

**RECOMMENDATION**: Start with Option A (simple checkbox). This answers the core question: "Does this climb use ANY auxiliary holds?" Users with Full Ride setup will filter to see climbs that take advantage of their denser configuration.

### 2. SQL Implementation Approach

**Challenge**: Need to check if any placement_id in a climb's frames string exists in placements table with set_id=27.

**Option A**: Subquery with pattern matching (RECOMMENDED)
```sql
-- Add to WHERE clause:
AND EXISTS (
  SELECT 1 FROM placements p
  WHERE p.set_id = 27
  AND p.layout_id = $layout_id
  AND climbs.frames LIKE '%p' || p.id || 'r%'
)
```
- Pros: Clean, leverages SQL indexes
- Cons: Potentially slower with many placements (but only ~238 for auxiliary)

**Option B**: Pre-build auxiliary placement ID list in Python
```python
# Get all auxiliary placement IDs for the layout
aux_ids = get_data(board, "auxiliary_placements", {"layout_id": layout_id})
# Build SQL: AND (climbs.frames LIKE '%p4132r%' OR climbs.frames LIKE '%p4133r%' OR ...)
```
- Pros: Single query, potentially faster
- Cons: Very long SQL statement (~238 OR clauses), harder to read

**Option C**: Add computed column to climbs table
```sql
-- Add boolean column has_auxiliary_holds
-- Updated during sync
```
- Pros: Fastest queries
- Cons: Requires DB schema changes, breaks BoardLib sync, maintenance burden

**RECOMMENDATION**: Option A (subquery) for clean implementation. If performance becomes an issue, optimize to Option B.

### 3. Filter Inversion (Mainline Only)

**Question**: Should we also support "Mainline Only" (exclude climbs with ANY auxiliary holds)?

**Recommendation**: NOT in v1. Since the use case is "I want climbs that use auxiliary", the inverse (Mainline Only) would only be useful for users who DON'T have auxiliary installed. Keep it simple for now.

**Future consideration**: If demand exists, add a 3-state radio:
- "Any" (default)
- "Uses Auxiliary"
- "Mainline Only" (for users without Aux)

### 4. UI/UX Design

**Proposed Filter UI** (in `filterSelection.html.j2`):
```html
<div class="form-check">
  <input type="checkbox" class="form-check-input" id="usesAuxiliary" name="usesAuxiliary" value="1">
  <label class="form-check-label" for="usesAuxiliary">
    Uses Auxiliary Holds
  </label>
  <small class="form-text text-muted">Find climbs that use at least one auxiliary hold</small>
</div>
```

**Location in UI**: Place near the grade/difficulty filters since this affects climb difficulty (auxiliary holds tend to be harder).

**Label considerations**:
- "Uses Auxiliary Holds" - clear and direct
- Alternative: "Includes Auxiliary" - shorter but less clear
- Alternative: "Has Aux Holds" - informal but clear

### 5. Query Parameter Design

**New query parameter**: `usesAuxiliary`
- Values: `1` (filter enabled), `0` or missing (filter disabled/default)
- Example URL: `/results?board=kilter&layout=8&size=14&usesAuxiliary=1&...`

### 6. Backward Compatibility

**Consideration**: Existing bookmarked URLs should continue to work.
- Default to `holdSetFilter=any` if parameter is missing
- No breaking changes to existing filters

## Implementation Plan

### Phase 1: Backend (db.py)
1. Add new SQL query to get auxiliary placement IDs for a layout
2. Modify `get_search_base_sql_and_binds()` to handle `holdSetFilter` parameter
3. Implement EXISTS/NOT EXISTS subquery logic

### Phase 2: Frontend (filterSelection.html.j2)
1. Add checkbox to filter UI near difficulty controls
2. Include `usesAuxiliary` in form submission
3. Ensure checkbox state persists from query params

### Phase 3: Testing
1. Test with known climbs that use auxiliary holds
2. Verify performance with full database
3. Test checkbox on/off states
4. Verify URL bookmarking works
5. Verify results are actually using auxiliary holds (spot check)

### Phase 4: Optimization (if needed)
1. Measure query performance
2. If slow, implement placement ID list caching
3. Consider adding database indexes if needed

## Technical Notes

### SQL Query Pattern (Subquery Approach)
```sql
-- For "Uses Auxiliary" filter (when checkbox is checked):
AND EXISTS (
  SELECT 1 FROM placements p
  WHERE p.set_id = 27
  AND p.layout_id = :layout_id
  AND climbs.frames LIKE '%p' || p.id || 'r%'
)
```

### Kickboard Consideration
- Sets 28 (Mainline Kickboard) and 29 (Auxiliary Kickboard) also exist
- For now, treat kickboard sets as separate from main sets
- May want to add "Include Kickboard" option later

## Open Questions

1. **Should kickboard holds be included in the filter?**
   - Current plan: No, treat as separate
   - Rationale: Different use case (volumes vs holds)

2. **Performance impact of EXISTS subquery?**
   - Need to test with full database
   - ~238 auxiliary placements per layout to check
   - May need optimization if slow

3. **Should this be Kilter-specific or generalized?**
   - Current plan: Start Kilter-specific (layout_id=8)
   - Can generalize later if other boards have similar multi-set configurations

4. **Should we show hold set distribution in results?**
   - E.g., "12 Mainline, 3 Auxiliary" per climb
   - Nice-to-have, not critical for v1

## Success Metrics

- Users can successfully filter for climbs that use auxiliary holds
- Filtered results actually contain auxiliary holds (verified by spot-checking frames)
- Query performance remains acceptable (<2s for full database scan)
- Feature is discoverable and intuitive to use (checkbox near relevant filters)
- No regression in existing filter functionality

## Future Enhancements

1. Show hold set statistics per climb (e.g., "8 Mainline, 2 Auxiliary")
2. Add "Max Auxiliary Holds" slider for finer control
3. Visual indicators on board SVG showing which set each hold belongs to
4. Filter by kickboard holds separately
5. Generalize to other multi-set board configurations
