export interface AcquireTokenOptions {
  /**
   * Delegated scopes to request, e.g. ['api://loyaltyos-api/access_as_user'].
   * Do NOT include 'openid', 'profile', or 'offline_access' - MSAL adds these
   * reserved scopes to every request automatically. On iOS, explicitly
   * specifying them is rejected outright; pass an empty array for a basic
   * sign-in that only needs an ID token. On Android, MSAL's
   * TokenParameters.withScopes() throws on an empty list (no equivalent
   * "reserved scopes" carve-out), so the native Android plugin substitutes
   * 'openid' when this is empty - callers on both platforms can still just
   * pass [] for a basic sign-in.
   */
  scopes: string[];

  /**
   * Optional `domain_hint` sent to the Entra External ID authorize endpoint
   * as an extra query parameter, on iOS and web. When the tenant's user flow
   * has a social identity provider configured, this skips the Entra
   * account-picker page and routes the user straight to that provider's own
   * login screen. For social/federated IdPs this is Microsoft's "issuer
   * acceleration" mechanism and takes a bare provider name, NOT a domain -
   * use exactly 'Google' (capital G - case-sensitive, 'google' fails with
   * AADSTS90023), 'facebook', or 'apple'. ('<domain>.com' values are a
   * *different* mechanism reserved for custom SAML/WS-Fed IdPs matched by a
   * configured domain - passing e.g. 'apple.com' here can misroute to an
   * unrelated domain-based lookup instead of Sign in with Apple.) For a
   * custom OIDC provider, use the domain segment of its issuer URI instead
   * (e.g. 'www.linkedin.com'). Has no effect on `acquireTokenSilent()`.
   * Ignored on Android (see the plugin README's Known gaps).
   */
  domainHint?: string;

  /**
   * Optional `prompt` sent to the Entra External ID authorize endpoint,
   * currently **web only**. Indicates the type of user interaction
   * required - the value most relevant here is `'create'`, which sends the
   * user straight to the tenant's account-creation form instead of the
   * sign-in form (requires the user flow to be a "Sign up and sign in"
   * flow). Other values MSAL recognizes: `'login'` (force credential entry,
   * skip SSO), `'none'` (silent-only, rejects with an error if interaction
   * would be needed), `'consent'`, `'select_account'`.
   *
   * Caveat: unlike `domainHint`, `prompt: 'create'` has been reported as
   * unreliable on some tenants (Microsoft Q&A has multiple reports of it
   * working, then silently stopping) - treat it as best-effort, e.g. for an
   * explicit "Create account" button next to "Sign in", not as something to
   * design a flow around depending on. Has no effect on
   * `acquireTokenSilent()`. Ignored on iOS/Android for now - native support
   * would mirror how `domainHint` was added to `MSALInteractiveTokenParameters`
   * (iOS) if/when needed.
   */
  prompt?: string;
}

export interface AcquireTokenResult {
  accessToken: string;
  idToken: string;
  expiresOn: number; // epoch millis
  /** stable per-user identifier, maps to the token's oid claim */
  accountId: string;
  scopes: string[];
}

export interface AccountInfo {
  accountId: string;
  username: string | null;
  idTokenClaims: Record<string, unknown> | null;
}

export interface SignOutOptions {
  /** if true, also clears the Entra browser session, not just local cache */
  clearBrowserSession?: boolean;
}

export interface MsalAuthPlugin {
  /**
   * Interactive sign-in/sign-up. Launches the platform browser
   * (ASWebAuthenticationSession / Chrome Custom Tabs via the native MSAL SDK)
   * against the Entra External ID user flow configured in msal_config.json.
   */
  signIn(options: AcquireTokenOptions): Promise<AcquireTokenResult>;

  /**
   * Silent token acquisition using the cached account + refresh token.
   * Rejects with code 'UI_REQUIRED' if silent renewal fails and an
   * interactive signIn() is needed (e.g. revoked consent, expired session).
   */
  acquireTokenSilent(options: AcquireTokenOptions): Promise<AcquireTokenResult>;

  /** Returns the currently cached account, if any, without a network call. */
  getAccount(): Promise<AccountInfo | null>;

  /** Clears the local token cache, and optionally the browser session. */
  signOut(options?: SignOutOptions): Promise<void>;
}
