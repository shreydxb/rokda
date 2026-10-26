-- Indian holdings keep their broker's sectors (docs/decisions.md, "Indian
-- holdings keep their broker's sectors"). The sector list was the eleven
-- market sectors and broad; an Indian broker's holdings statement gives its
-- shares sectors of its own (Defence, FMCG, Auto ancillary...), and the
-- household tags its Indian holdings as the statement does. The statement's
-- Energy is the market sector of that name.

alter table holdings drop constraint holdings_sector_check;
alter table holdings add constraint holdings_sector_check check (
  sector is null or sector in (
    'broad', 'technology', 'communication', 'consumer_discretionary', 'consumer_staples', 'energy',
    'financials', 'health_care', 'industrials', 'materials', 'real_estate', 'utilities',
    'software_services', 'financial_services', 'defence', 'engineering_capital_goods', 'healthcare',
    'auto_ancillary', 'automobile', 'metals', 'chemicals', 'building_materials', 'fmcg', 'retail'
  )
);

comment on column holdings.sector is 'The sector the holding is in: a market sector, an Indian broker''s sector, or broad for a fund spread across sectors. Null until tagged.';
