ALTER TABLE employees ADD COLUMN chart_level TEXT;
ALTER TABLE employees ADD COLUMN chart_group TEXT;
ALTER TABLE employees ADD COLUMN chart_covers TEXT;
ALTER TABLE employees ADD COLUMN chart_ceremonial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN chart_sa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN chart_roles TEXT;
