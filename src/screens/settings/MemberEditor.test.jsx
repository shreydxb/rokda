import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderScreen } from '../../test/renderScreen';

vi.mock('../../lib/supabaseClient', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

const { default: MemberEditor } = await import('./MemberEditor');

// What the editor offers follows the database's owner/member boundary
// (SHR-314): an owner manages the roster; a member renames themselves and links
// their own Telegram, and sees everyone else read-only.
const owner = { id: 'm-owner', display_name: 'Owner', role: 'owner', user_id: 'u1', telegram_user_id: null };
const partner = { id: 'm-partner', display_name: 'Partner', role: 'member', user_id: 'u2', telegram_user_id: null };

function editor(props) {
  return renderScreen(<MemberEditor householdId="hh" onClose={() => {}} onSaved={() => {}} isLastOwner={false} {...props} />);
}

describe('MemberEditor', () => {
  it('lets an owner change and remove another member', () => {
    editor({ member: partner, isSelf: false, canManage: true });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Member' }).disabled).toBe(false);
  });

  it('shows a member someone else read-only, and says who can change them', () => {
    editor({ member: owner, isSelf: false, canManage: false });
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate code' })).toBeNull();
    expect(screen.getByPlaceholderText('Their name').readOnly).toBe(true);
    expect(screen.getByText('Only an owner can change or remove another member.')).toBeTruthy();
    expect(screen.getByText('Not linked. Only an owner can link another member.')).toBeTruthy();
    expect(screen.getByText('Close', { selector: 'button' })).toBeTruthy();
  });

  it('lets a member rename themselves and link their own Telegram, but not change their role', () => {
    editor({ member: partner, isSelf: true, canManage: false });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Their name').readOnly).toBe(false);
    expect(screen.getByRole('button', { name: 'Generate code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Owner' }).disabled).toBe(true);
    expect(screen.getByText('Only an owner can change roles.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
