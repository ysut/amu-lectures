// Optional sign-in with Microsoft Entra ID (university Microsoft 365 account).
//
// NOTE: GitHub Pages can only serve static files, so this is a client-side
// gate: it keeps casual visitors out, but the question data itself is still
// downloadable by anyone who knows its URL. See README.md for stronger options.

const RETURN_KEY = 'auth:returnHash';
let msalPromise;

function loadMsal() {
  if (window.msal) return Promise.resolve(window.msal);
  msalPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/msal-browser.min.js';
    script.onload = () => resolve(window.msal);
    script.onerror = () => reject(new Error('認証ライブラリを読み込めませんでした。'));
    document.head.append(script);
  });
  return msalPromise;
}

export async function initAuth(cfg) {
  if (!cfg.clientId || !cfg.tenantId) {
    throw new Error('site.config.json の auth.clientId / auth.tenantId が設定されていません。');
  }
  const msal = await loadMsal();
  const baseUrl = location.origin + location.pathname;
  const pca = new msal.PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: baseUrl,
      postLogoutRedirectUri: baseUrl,
    },
    // Keep students signed in across tabs and browser restarts.
    cache: { cacheLocation: 'localStorage' },
  });
  await pca.initialize();

  let result = null;
  let error = null;
  try {
    result = await pca.handleRedirectPromise();
  } catch (e) {
    error = e;
  }
  if (result || error || /[#&](code|error|state)=/.test(location.hash)) {
    // Coming back from the sign-in page: drop the auth response from the URL
    // and return to the page the user was on.
    let hash = '';
    try {
      hash = sessionStorage.getItem(RETURN_KEY) || '';
      sessionStorage.removeItem(RETURN_KEY);
    } catch {
      // Storage may be unavailable; fall back to the top page.
    }
    history.replaceState(null, '', location.pathname + location.search + hash);
  }

  const account = result?.account ?? pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
  if (account) pca.setActiveAccount(account);

  const domains = (cfg.allowedDomains || []).map((d) => String(d).toLowerCase().replace(/^@/, ''));
  const username = (account?.username || '').toLowerCase();
  const allowed =
    Boolean(account) &&
    (domains.length === 0 || domains.some((d) => username.endsWith(`@${d}`) || username.endsWith(`.${d}`)));

  return {
    account,
    allowed,
    error,
    login() {
      try {
        sessionStorage.setItem(RETURN_KEY, location.hash);
      } catch {
        // Not critical: the user just lands on the top page after sign-in.
      }
      return pca.loginRedirect({ scopes: ['openid', 'profile'], prompt: 'select_account' });
    },
    logout() {
      return pca.logoutRedirect({ account });
    },
  };
}
