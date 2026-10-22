ALTER TABLE employees ADD COLUMN weekly_hours REAL;
UPDATE employees SET weekly_hours = ROUND(contracted_hours * LENGTH(COALESCE(work_days, '12345')), 2) WHERE contracted_hours IS NOT NULL;
