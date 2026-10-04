ALTER TABLE employees ADD COLUMN groups TEXT;
ALTER TABLE employees ADD COLUMN teams TEXT;
ALTER TABLE employees ADD COLUMN lead_of TEXT;
UPDATE employees SET groups = CASE WHEN role = 'admin' THEN '["admin"]' WHEN role = 'lead' AND team = 'Sales' THEN '["lead","sales"]' WHEN role = 'lead' THEN '["lead"]' WHEN team = 'Sales' THEN '["sales"]' ELSE '[]' END, teams = CASE WHEN team IS NULL OR team = '' THEN '[]' ELSE json_array(team) END, lead_of = CASE WHEN role = 'lead' AND team IS NOT NULL AND team != '' THEN json_array(team) ELSE '[]' END WHERE groups IS NULL;
