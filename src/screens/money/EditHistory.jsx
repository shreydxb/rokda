import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { historyEvents } from '../../lib/editHistory';

// One timeline of what changed on a record and on the records linked to it
// (lib/editHistory.js). `records` is [{ id, label }], the record itself first.
export default function EditHistory({ records, members }) {
  const ids = records.map((r) => r.id).join(',');
  const [edits, setEdits] = useState([]);
  const [loading, setLoading] = useState(records.length > 0);

  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    // One read per record: a purchase has few refunds, and each read is the
    // indexed lookup by transaction the history always used.
    Promise.all(
      ids.split(',').map((id) => supabase.from('transaction_edits').select('*').eq('transaction_id', id).order('edited_at', { ascending: false })),
    ).then((results) => {
      if (!cancelled) {
        setEdits(results.flatMap((r) => r.data ?? []));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ids]);

  const events = historyEvents(edits, records, members);
  return (
    <div>
      <span className="te-fieldlabel">History{records.length > 1 ? ', with linked records' : ''}</span>
      <div style={{ marginTop: 8 }}>
        {loading ? (
          <div className="ov-muted" style={{ fontSize: 12 }}>
            Loading…
          </div>
        ) : events.length === 0 ? (
          <div className="ov-muted" style={{ fontSize: 12 }}>
            No edits yet.
          </div>
        ) : (
          <div className="mn-list te-history">
            {events.map((ev) => (
              <div key={ev.key} className="mn-row" style={{ cursor: 'default', display: 'block' }}>
                <div style={{ fontSize: 12 }}>
                  {ev.at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {ev.who}
                </div>
                {ev.lines.map((l) => (
                  <div key={l.id} className="ov-muted te-history-line" style={{ fontSize: 12, marginTop: 3 }}>
                    {l.record && <span className="te-history-record">{l.record}: </span>}
                    {l.field} {l.from} → {l.to}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
