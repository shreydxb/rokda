-- Real gold/silver spot positions (XAU/USD, XAG/USD) don't fit any existing
-- asset class — add 'commodity' rather than mis-labeling them as equity.
alter table holdings drop constraint holdings_asset_class_check;
alter table holdings add constraint holdings_asset_class_check
  check (asset_class = ANY (ARRAY['us_equity', 'intl_equity', 'uae_equity', 'india_equity', 'india_mf', 'crypto', 'sukuk', 'cash', 'commodity']));
