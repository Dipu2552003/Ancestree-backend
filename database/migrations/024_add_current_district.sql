-- Current location now follows State → District → City. Native place already
-- had native_district; this adds the matching column for the current address.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS current_district TEXT;
