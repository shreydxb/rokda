-- QA-04 (SHR-245): Refresh falsely certified stale prices.
--
-- `last_refreshed` conflated two different facts: when the holding was last
-- priced, and when its record was last touched. The Investments "Refresh"
-- button wrote it without retrieving a single price, and renaming a holding
-- advanced it too — so the staleness warning could be dismissed without
-- anything being repriced.
--
-- Rename it to what it actually has to mean. Record-edited-at is `updated_at`,
-- which is a separate column and separately maintained.

alter table holdings rename column last_refreshed to priced_at;

comment on column holdings.priced_at is
  'When the stored value/price was last confirmed as of. Advances only when a valuation is entered and confirmed — never by reloading the screen or editing a name.';
comment on column holdings.updated_at is
  'When the record was last edited. Unrelated to how fresh the valuation is.';
