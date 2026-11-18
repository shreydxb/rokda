import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

const calls = vi.hoisted(() => ({ updates: [], inserts: [], deletes: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      update: (row) => ({
        eq: async (col, id) => {
          calls.updates.push({ row, id });
          return { error: null };
        },
      }),
      insert: async (row) => {
        calls.inserts.push(row);
        return { error: null };
      },
      delete: () => ({
        eq: async (col, id) => {
          calls.deletes.push(id);
          return { error: null };
        },
      }),
    }),
  },
}));

const { default: MemberEditor } = await import('./MemberEditor');

beforeEach(() => {
  calls.updates.length = 0;
  calls.inserts.length = 0;
  calls.deletes.length = 0;
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

// What the editor offers follows the database's owner/member boundary
// (SHR-314): an owner manages the roster; a member renames themselves and links
// their own Telegram, and sees everyone else read-only. The drawer is the
// kit's (the revamp, phase 7).
const owner = { id: 'm-owner', display_name: 'Owner', role: 'owner', user_id: 'u1', telegram_user_id: 1 };
const partner = { id: 'm-partner', display_name: 'Partner', role: 'member', user_id: 'u2', telegram_user_id: null };
const placeholder = { id: 'm-ph', display_name: 'Placeholder', role: 'member', user_id: null, telegram_user_id: null };

function editor(props) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  renderScreen(
    <MemoryRouter initialEntries={['/settings?tab=household']}>
      <MemberEditor householdId="hh" onClose={onClose} onSaved={onSaved} isLastOwner={false} {...props} />
      <Where />
    </MemoryRouter>,
  );
  return { onClose, onSaved };
}
const drawer = () => screen.getByRole('dialog');
const role = (name) => within(within(drawer()).getByRole('group', { name: 'Role' })).getByRole('button', { name });

describe('MemberEditor: who may change what', () => {
  it('lets an owner change and remove another member', () => {
    editor({ member: partner, isSelf: false, canManage: true });
    expect(screen.getByRole('dialog', { name: 'Partner' })).toBeTruthy();
    expect(within(drawer()).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(within(drawer()).getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(within(drawer()).getByRole('button', { name: 'Link' })).toBeTruthy();
    expect(role('Member').disabled).toBe(false);
  });

  it('shows a member someone else read-only, and says who can change them', () => {
    editor({ member: owner, isSelf: false, canManage: false });
    expect(within(drawer()).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(drawer()).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(drawer()).queryByRole('button', { name: /^Link/ })).toBeNull();
    expect(within(drawer()).getByLabelText('Name').readOnly).toBe(true);
    expect(within(drawer()).getByText('Only an owner can change another member.')).toBeTruthy();
    // The drawer's × and, with nothing to save, the foot's Close.
    expect(within(drawer()).getAllByRole('button', { name: 'Close' })).toHaveLength(2);
  });

  it('lets a member rename themselves and link their own Telegram, but not change their role', () => {
    editor({ member: partner, isSelf: true, canManage: false });
    expect(within(drawer()).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(within(drawer()).getByLabelText('Name').readOnly).toBe(false);
    expect(within(drawer()).getByRole('button', { name: 'Link' })).toBeTruthy();
    expect(role('Owner').disabled).toBe(true);
    expect(within(drawer()).getByText('Only an owner can change roles.')).toBeTruthy();
    expect(within(drawer()).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('says in a line why the only owner stays one', () => {
    editor({ member: owner, isSelf: true, canManage: true, isLastOwner: true });
    expect(role('Member').disabled).toBe(true);
    expect(within(drawer()).getByText('The only owner. Add another first.')).toBeTruthy();
  });

  it('says in a line why someone with no login cannot be an owner', () => {
    editor({ member: placeholder, isSelf: false, canManage: true });
    expect(role('Owner').disabled).toBe(true);
    expect(within(drawer()).getByText('An owner needs a login.')).toBeTruthy();
  });
});

describe('MemberEditor: login and Telegram', () => {
  it('shows each as a chip', () => {
    editor({ member: owner, isSelf: true, canManage: true });
    const kv = within(drawer()).getByRole('list', { name: 'Accounts' });
    expect(kv.textContent).toBe('LoginLinkedTelegramLinkedLink again');
  });

  it("opens the Telegram tab's link drawer for the member", () => {
    const { onClose } = editor({ member: partner, isSelf: false, canManage: true });
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Link' }));
    expect(screen.getByTestId('where').textContent).toBe('/settings?tab=telegram&link=m-partner');
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before leaving unsaved changes for the link', () => {
    const { onClose } = editor({ member: partner, isSelf: false, canManage: true });
    fireEvent.change(within(drawer()).getByLabelText('Name'), { target: { value: 'Partner B' } });
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Link' }));
    expect(within(drawer()).getByText('Discard changes?')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Discard' }));
    expect(screen.getByTestId('where').textContent).toBe('/settings?tab=telegram&link=m-partner');
  });
});

describe('MemberEditor: saving', () => {
  it('adds a member with no login', async () => {
    const { onSaved } = editor({ member: null, canManage: true });
    expect(screen.getByRole('dialog', { name: 'Add a member' })).toBeTruthy();
    fireEvent.change(within(drawer()).getByLabelText('Name'), { target: { value: 'Sam' } });
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Add member' })));
    expect(calls.inserts).toEqual([{ display_name: 'Sam', role: 'member', household_id: 'hh', user_id: null }]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('will not save without a name', async () => {
    editor({ member: null, canManage: true });
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Add member' })));
    expect(within(drawer()).getByRole('alert').textContent).toBe('Name it.');
    expect(calls.inserts).toHaveLength(0);
  });

  it('removes on the second press, and Escape steps back from the first', async () => {
    const { onSaved, onClose } = editor({ member: partner, isSelf: false, canManage: true });
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Remove' }));
    fireEvent.keyDown(drawer(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(within(drawer()).getByRole('button', { name: 'Remove' })).toBeTruthy();
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Remove' }));
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Confirm remove?' })));
    expect(calls.deletes).toEqual(['m-partner']);
    expect(onSaved).toHaveBeenCalled();
  });
});
