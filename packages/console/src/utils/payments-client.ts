// Authenticated calls to /api/payments/*.
//
// Those routes used to identify the caller by a `userId` query/body param, which
// meant any uid was a bearer credential. They now derive identity from the
// Authorization header (src/lib/api-auth.ts), so every call site must send a
// token. This wrapper exists so that plumbing lives in one place rather than
// being copy-pasted across ~17 call sites.
//
// Header shape matches the existing convention in src/hooks/use-linked-emails.ts:
// the raw token, no "Bearer " prefix (the server accepts either).
import axios from "axios";

/** The subset of the auth-react user object these calls need. */
export interface PaymentsUser {
  uid: string;
  getToken: () => Promise<string>;
}

async function authHeaders(user: PaymentsUser | null | undefined) {
  if (!user) throw new Error("Must be signed in");
  const token = await user.getToken();
  if (!token) throw new Error("Must be signed in");
  return { Authorization: token };
}

/** `path` is relative to /api/payments — e.g. "usage", `methods/${id}`. */
export async function paymentsGet<T = any>(
  user: PaymentsUser | null | undefined,
  path: string,
) {
  return axios.get<T>(`/api/payments/${path}`, { headers: await authHeaders(user) });
}

export async function paymentsPost<T = any>(
  user: PaymentsUser | null | undefined,
  path: string,
  body: Record<string, unknown> = {},
) {
  return axios.post<T>(`/api/payments/${path}`, body, { headers: await authHeaders(user) });
}

export async function paymentsDelete<T = any>(
  user: PaymentsUser | null | undefined,
  path: string,
  body: Record<string, unknown> = {},
) {
  return axios.delete<T>(`/api/payments/${path}`, {
    headers: await authHeaders(user),
    data: body,
  });
}
