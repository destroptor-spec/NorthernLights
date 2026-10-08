/**
 * Accounts Aurora refuses to remove. The server owner (the account the setup
 * wizard created) and the last remaining admin can't be deleted — by
 * themselves or by another admin — or demoted to a listener, so the server is
 * never left without someone who can administer it.
 *
 * Shared by the server, which enforces it, and the web client, which hides
 * the actions it would refuse.
 */
export type AccountProtection = 'owner' | 'last-admin';

export function accountProtection(
  account: { role: string; isOwner: boolean },
  adminCount: number,
): AccountProtection | null {
  if (account.isOwner) return 'owner';
  if (account.role === 'admin' && adminCount <= 1) return 'last-admin';
  return null;
}

export const ACCOUNT_PROTECTION_MESSAGES: Record<AccountProtection, string> = {
  owner: 'The server owner\'s account can\'t be deleted or demoted.',
  'last-admin': 'This is the only admin account. Make another user an admin first.',
};
