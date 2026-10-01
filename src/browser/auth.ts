import type { BrowserContext } from 'playwright';
import { AuthConfigSchema, type AuthConfig } from '../shared/types.js';
import type { Redactor } from '../shared/redactor.js';

/**
 * Applies JWT auth to a context WITHOUT persisting it anywhere. The token is registered with the redactor first.
 * Header auth is only attached to same-origin requests so the token cannot leak to third parties.
 */
export async function applyAuth(context: BrowserContext, targetUrl: string, authInput: Partial<AuthConfig> | undefined, redactor: Redactor): Promise<void> {
  if (!authInput?.jwt) return;
  const auth = AuthConfigSchema.parse(authInput);
  const jwt = auth.jwt.trim();
  redactor.register(jwt);
  const origin = new URL(targetUrl);

  switch (auth.location) {
    case 'cookie':
      await context.addCookies([{
        name: auth.key ?? 'token', value: jwt, domain: origin.hostname, path: '/',
        httpOnly: false, secure: origin.protocol === 'https:', sameSite: 'Lax',
      }]);
      break;
    case 'localStorage':
    case 'sessionStorage': {
      const key = auth.key ?? 'token';
      const store = auth.location;
      // Only runs on the target origin; passes values as arguments, never string-interpolated.
      await context.addInitScript(({ store, key, jwt, origin }) => {
        if (window.location.origin === origin) {
          try { (window as unknown as Record<string, Storage>)[store]!.setItem(key, jwt); } catch { /* storage unavailable */ }
        }
      }, { store, key, jwt, origin: origin.origin });
      break;
    }
    case 'header': {
      const headerName = auth.key ?? 'Authorization';
      const value = headerName.toLowerCase() === 'authorization' ? `${auth.scheme} ${jwt}`.trim() : jwt;
      redactor.register(value);
      await context.route('**/*', async (route) => {
        const req = route.request();
        let same = false;
        try { same = new URL(req.url()).origin === origin.origin; } catch { /* data: urls etc. */ }
        if (!same) return route.continue();
        return route.continue({ headers: { ...req.headers(), [headerName]: value } });
      });
      break;
    }
  }
}
