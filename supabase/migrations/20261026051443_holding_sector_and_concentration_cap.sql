-- How much of the household's investments sits in one place, and the most it
-- wants there (docs/decisions.md, "A concentration line on Wealth"; Planning
-- audit, 4.17).
--
-- A holding's sector is tagged once, from a fixed list, rather than a sector
-- share typed in that goes stale as prices move. The list is the eleven
-- market sectors and one more for a fund spread across them, which counts in
-- no sector and is not a concentration on its own. Blank is not tagged yet.
--
-- The cap is the household's: no single sector or holding above this share
-- of investments. Blank is no cap.

alter table holdings
  add column sector text,
  add constraint holdings_sector_check check (
    sector is null or sector in (
      'broad', 'technology', 'communication', 'consumer_discretionary', 'consumer_staples', 'energy',
      'financials', 'health_care', 'industrials', 'materials', 'real_estate', 'utilities'
    )
  );

alter table households
  add column concentration_cap_pct numeric(5, 2),
  add constraint households_concentration_cap_check check (concentration_cap_pct is null or (concentration_cap_pct > 0 and concentration_cap_pct <= 100));

comment on column holdings.sector is 'The market sector the holding is in, or broad for a fund spread across sectors. Null until tagged.';
comment on column households.concentration_cap_pct is 'The most of the household''s investments to hold in one sector or one holding, as a percentage. Null is no cap.';
