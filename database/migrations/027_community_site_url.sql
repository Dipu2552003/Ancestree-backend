-- Optional custom website URL for a community (e.g. its own Vercel deployment).
-- When set, invite links are built from this host instead of whatever origin the
-- admin happens to be browsing. NULL = fall back to the current app origin.
ALTER TABLE communities
  ADD COLUMN site_url TEXT;
