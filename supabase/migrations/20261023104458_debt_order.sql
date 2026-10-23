-- The payoff order the household picks on Debt payoff, kept so it holds for
-- both partners and Plan's projection follows it. It was forgotten on every
-- reload, and Plan always used avalanche (docs/decisions.md, "Debt payoff
-- dates the loan"; Planning audit, 1.4). Blank is avalanche, the default.
-- A custom order waits until a debt's rank can be set.

alter table planning_assumptions
  add column debt_order text,
  add constraint planning_assumptions_debt_order check (debt_order is null or debt_order in ('avalanche', 'snowball'));
