import { couldntLoad } from '../../lib/loadState';

// What a cockpit panel says in place of what rests on a source that never
// loaded (the review of the whole revamp): it said zeros, "none yet" and
// "All clear" instead, and only the banner at the top said anything failed.
// A source that loaded before and failed on a refresh keeps its records, so
// this is for neverLoaded's keys (lib/loadState.js).
export default function Unread({ sources, what }) {
  return (
    <div className="ov-muted ov-unread">
      {couldntLoad(sources)} {what}
    </div>
  );
}
