ALTER TABLE stock_units ADD COLUMN supplier_lot TEXT;
ALTER TABLE stock_needs ADD COLUMN deleted_at TEXT;
ALTER TABLE stock_needs ADD COLUMN deleted_by TEXT;
ALTER TABLE stock_needs ADD COLUMN delete_reason TEXT;
ALTER TABLE stock_items ADD COLUMN edited_at TEXT;
