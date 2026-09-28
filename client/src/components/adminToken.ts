// The admin token (EODVIEW_ADMIN_TOKEN) is remembered in this browser after a successful unlock,
// so Settings, API tokens and key changes work without pasting it every time.
const KEY = "eodview.adminToken";

export function loadAdminToken(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function saveAdminToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* storage unavailable: the token still works for this session */
  }
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
