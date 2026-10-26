-- What cash earns in the Life plan (docs/decisions.md, "Cash earns a cash
-- rate"; Planning audit, 4.19). The plan grew every dirham at the investment
-- return, cash included. The cash held today now stays cash at this rate, a
-- year before inflation; blank is the default the app names (3%). The same
-- in every scenario: a scenario is about markets.

alter table planning_assumptions
  add column cash_return_pct numeric(6, 3),
  add constraint planning_assumptions_cash_return_range check (cash_return_pct is null or cash_return_pct between -5 and 20);

comment on column planning_assumptions.cash_return_pct is 'What cash held today earns a year in the Life plan, before inflation, in percent. Null is the default (3).';
