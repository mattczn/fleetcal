-- Link a payroll adjustment back to the inspection report that triggered it.
-- Used by the "+ Deduction" action on the Equipment page's "left dirty" panel
-- so a single cleanliness flag can only be deducted once (and can be shown
-- as already-deducted). ON DELETE SET NULL: deleting the inspection keeps the
-- payroll line but drops the back-reference.
ALTER TABLE payroll_adjustments
  ADD COLUMN IF NOT EXISTS inspection_report_id uuid
    REFERENCES inspection_reports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS payroll_adjustments_inspection
  ON payroll_adjustments (inspection_report_id)
  WHERE inspection_report_id IS NOT NULL;
