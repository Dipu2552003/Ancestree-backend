-- Native-script name was removed from the product: not asked in any form,
-- not stored. Drop the column entirely.
ALTER TABLE persons DROP COLUMN IF EXISTS name_native;
