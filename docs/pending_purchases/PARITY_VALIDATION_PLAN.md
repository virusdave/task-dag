# Parity Validation Plan - Python vs Helios

**Task**: Validate parity with Python process  
**Issue**: #2  
**Created**: 2026-05-13

## Validation Approach

### Test Inputs
Use same pending purchase orders as input to both systems:
- Midtown order 131845 (Stop 31 LLC / 10FF Distribution)
- Bronx order 131642 (N&M Farms)
- Any new orders discovered during validation

### Comparison Metrics

#### 1. SKU Parsing Accuracy
**Test**: Parse same distributor product names
**Compare**:
- Parsed brand, category, subcategory
- Variant name formatting
- Strain/cultivar extraction
- Pack size and count

**Acceptance**: 100% match for manifest-covered SKUs, 95%+ for LLM-parsed

#### 2. Pricing Calculations
**Test**: Same cost + market data inputs
**Compare**:
- Proposed retail price
- GM% calculation
- Market pressure application
- Quarter-dollar rounding

**Acceptance**: Prices within $0.50, GM% within 0.5 points

#### 3. Catalog Matching
**Test**: Same parsed taxonomy
**Compare**:
- Matched product IDs
- Evidence tier classification
- Create vs link decisions

**Acceptance**: 100% match on matching logic

#### 4. Review Flags
**Test**: Same row data
**Compare**:
- Flags generated
- Flag descriptions
- Priority/severity

**Acceptance**: All critical flags present

#### 5. Database Persistence
**Test**: Save to DB and retrieve
**Compare**:
- Row count
- Field completeness
- JSONB structure
- Timestamp handling

**Acceptance**: All fields persist correctly

## Validation Execution

### Step 1: Generate with Python
```bash
cd /home/amp-local/src/automation/catalog/purchases/2026-05-11
python generate_combined_pending_packet.py
cp combined_pending_purchases_proposal.json /tmp/python_output.json
```

### Step 2: Generate with Helios
```bash
# Trigger Helios generation job
# Save output to /tmp/helios_output.json
```

### Step 3: Compare Outputs
```bash
# Compare JSON structures
diff -u <(jq -S . /tmp/python_output.json) <(jq -S . /tmp/helios_output.json)

# Compare key metrics
python compare_outputs.py /tmp/python_output.json /tmp/helios_output.json
```

### Step 4: Validate Differences
- Document acceptable differences (e.g., timestamp formats, field ordering)
- Investigate unacceptable differences
- Fix Helios implementation if discrepancies found

## Acceptable Differences

- **Timestamp formats**: Python vs TypeScript serialization
- **Field ordering**: JSON key order not semantically meaningful
- **Null vs undefined**: Representation differences
- **Float precision**: Rounding differences within tolerance
- **ID generation**: Database sequence values will differ

## Unacceptable Differences

- Different proposed prices (beyond $0.50 tolerance)
- Different GM% calculations (beyond 0.5 point tolerance)
- Missing required fields
- Different catalog matching decisions
- Missing critical review flags
- Different create/link decisions

## Validation Script

```python
#!/usr/bin/env python3
"""Compare Python and Helios pending purchase outputs"""

import json
import sys

def compare_packets(python_path, helios_path):
    with open(python_path) as f:
        python_data = json.load(f)
    with open(helios_path) as f:
        helios_data = json.load(f)
    
    # Compare row counts
    python_rows = python_data.get('rows', [])
    helios_rows = helios_data.get('rows', [])
    
    assert len(python_rows) == len(helios_rows), \
        f"Row count mismatch: Python {len(python_rows)} vs Helios {len(helios_rows)}"
    
    # Compare each row
    mismatches = []
    for i, (py_row, he_row) in enumerate(zip(python_rows, helios_rows)):
        # Compare critical fields
        if abs(py_row.get('proposedRetailPrice', 0) - he_row.get('proposedRetailPrice', 0)) > 0.50:
            mismatches.append(f"Row {i}: Price mismatch")
        
        if abs(py_row.get('gmPercent', 0) - he_row.get('gmPercent', 0)) > 0.5:
            mismatches.append(f"Row {i}: GM% mismatch")
        
        if py_row.get('parsedBrand') != he_row.get('parsedBrand'):
            mismatches.append(f"Row {i}: Brand mismatch")
    
    if mismatches:
        print("VALIDATION FAILED:")
        for m in mismatches:
            print(f"  - {m}")
        return False
    
    print(f"VALIDATION PASSED: {len(python_rows)} rows match")
    return True

if __name__ == '__main__':
    success = compare_packets(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
```

## Success Criteria

- [ ] Row counts match
- [ ] Pricing within tolerance (±$0.50)
- [ ] GM% within tolerance (±0.5 points)
- [ ] Brand/category/variant parsing matches
- [ ] Evidence tier classification matches
- [ ] Review flags cover same concerns
- [ ] No regressions in data quality

## Rollback Plan

If validation fails:
1. Document discrepancies in detail
2. Fix Helios implementation
3. Re-run validation
4. Do NOT proceed to cutover until parity achieved

## Documentation

Results documented in:
- `docs/pending_purchases/PARITY_VALIDATION_RESULTS.md` (to be created)
- Include: diff summary, metrics comparison, discrepancy analysis
