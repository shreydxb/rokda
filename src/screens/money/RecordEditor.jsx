import { transferLinkOf } from '../../lib/transfers';
import TransactionEditor from './TransactionEditor';
import TransferEditor from './TransferEditor';

// Which editor a record opens in, for Activity and for Overview (the revamp,
// phase 3), so both open a record the same way. `editing` is 'new',
// 'new-transfer', { newType } for a new record of a type, { initial } for a
// new record filled in (a bill marked paid), or the record itself; a record
// on either side of a transfer opens the transfer.
export default function RecordEditor({ editing, setEditing, household, accounts, categories, members, transactions, links = [], categoryRules = [], fxHistory = [], onSaved }) {
  const close = () => setEditing(null);
  const saved = async (result = {}) => {
    setEditing(null);
    await onSaved?.(result);
  };
  const fresh = editing === 'new' || editing === 'new-transfer' || !!editing.newType || !!editing.initial;
  const link = fresh ? null : transferLinkOf(editing.id, links);
  if (editing === 'new-transfer' || link) {
    const transfer = link ? { link, out: transactions.find((t) => t.id === link.from_transaction_id), in: transactions.find((t) => t.id === link.to_transaction_id) } : null;
    return (
      <TransferEditor
        transfer={transfer?.out && transfer?.in ? transfer : null}
        householdId={household?.id}
        accounts={accounts}
        members={members}
        onClose={close}
        onSaved={saved}
        onSwitchType={(type) => setEditing({ newType: type })}
      />
    );
  }
  return (
    <TransactionEditor
      key={fresh ? `new-${editing.newType ?? 'expense'}` : editing.id}
      tx={fresh ? null : editing}
      initial={editing.initial ?? (editing.newType ? { type: editing.newType } : undefined)}
      household={household}
      householdId={household?.id}
      accounts={accounts}
      categories={categories}
      members={members}
      allTransactions={transactions}
      links={links}
      categoryRules={categoryRules}
      fxHistory={fxHistory}
      onOpenOther={(other) => setEditing(other)}
      onSwitchToTransfer={() => setEditing('new-transfer')}
      onClose={close}
      onSaved={saved}
    />
  );
}
