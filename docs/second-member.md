# A login for the second member

Rokda is one household's ledger. Sign-ups are closed, so a member's login is made by the household's owner, by hand, and attached to the member row that already exists. That row keeps everything already recorded against it: what they own, their Telegram link, their life-plan ages. This page is the owner's steps (SHR-314). It names nobody: use their real email and display name where it says so.

## Before you start

- You are the household's **owner**, signed in to Rokda with your password and authenticator code.
- They have a **member row** already: Settings → Household lists them as "Not linked yet — assign-only".
- The reset link has somewhere to land: Authentication → URL Configuration lists both app addresses (`docs/environments.md`, "Auth URLs").

## 1. Create the login (Supabase dashboard)

Authentication → Users → **Add user** → **Create new user**:

- **Email:** theirs.
- **Password:** a long random one that nobody keeps. They replace it in step 3.
- **Auto Confirm User:** on. Sign-ups are closed, so no confirmation email would arrive.

## 2. Attach it to their member row (SQL Editor)

Fill in the two quoted values and run:

```sql
update household_members
   set user_id = (select id from auth.users where email = 'their email')
 where display_name = 'their display name'
   and user_id is null
returning id, display_name, role, user_id;
```

Exactly one row should come back, with `role` = `member` and `user_id` filled in.

- **None:** the name doesn't match, or the row already has a login.
- **More than one:** two rows share the name. Add `and id = '...'` using the id of the one you mean.

The role stays `member`. To make them an owner as well, do it afterwards from Settings → Household, where it is offered once they have a login.

## 3. They set their password and authenticator (their phone or computer)

1. Open Rokda and choose **Forgot password?**. Enter their email, then open the link it sends.
2. Choose a new password.
3. Rokda asks for a second factor. Scan the QR code with an authenticator app, or type the key, then enter the 6-digit code it shows. From then on, signing in takes the password and a code.

If the email doesn't arrive, wait a few minutes and send it again. Supabase's built-in email service sends only a few messages an hour.

## 4. Check

- **They see the household:** the same accounts, records and plans you see. Their own records count under their name in the sidebar's person switch.
- **Settings → Household:** they show as "Member · Linked to a login".

What a member who is not an owner can and can't do is set by the database (`supabase/migrations/20260913100000_owner_role_authorization.sql`, and `docs/decisions.md`, "A second member signs in as a member"):

| A member can | Only an owner can |
|---|---|
| Read and change every money record, account, budget, plan and setting the household shares | Add members, change another member, or remove one |
| Rename themselves | Change anyone's role, their own included |
| Link their own Telegram | Link another member's Telegram (a member with no login is linked this way) |
| Rename the household and set its rupee rate | |

Their Telegram stays linked if it already was: the link is on the member row, not the login.

## Undo

```sql
update household_members set user_id = null where id = 'their member id';
```

Then delete the user under Authentication → Users. The member row and everything recorded against it stay.
