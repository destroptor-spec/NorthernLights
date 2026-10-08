import { auroraApiRequest } from '../api/auroraApi';
import type { Me } from '../../shared/api/v1';

export type CurrentUser = { id: string; username: string; role: string };

/**
 * The signed-in user from API v1 `/me`, in the shape login stores as
 * `currentUser`. The legacy /api/auth/me returned the raw token payload
 * (`userId`, no `id`, plus iat/exp), which left `currentUser.id` undefined
 * after the first session check. Rejects on failure; a 401 also expires the
 * session through App's fetch interceptor.
 */
export async function fetchCurrentUser(authHeaders: Record<string, string>): Promise<CurrentUser> {
  const { user } = await auroraApiRequest<Me>('/me', authHeaders);
  return { id: user.id, username: user.username, role: user.role };
}
