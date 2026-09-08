-- Yahoo Finance's undocumented chart endpoint fills the gap Twelve Data's
-- free tier can't reach: NSE-listed India equities and DFM-listed UAE
-- equities (both verified working). US/global equities and commodities
-- stay on Twelve Data (documented, already verified, has real quota).
alter table holdings drop constraint holdings_price_provider_check;
alter table holdings add constraint holdings_price_provider_check
  check (price_provider in ('twelvedata', 'coingecko', 'mfapi', 'yahoo'));
