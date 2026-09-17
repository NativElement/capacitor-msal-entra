import { WebPlugin } from '@capacitor/core';
import {
  BrowserCacheLocation,
  InteractionRequiredAuthError,
  createStandardPublicClientApplication,
  type AccountInfo as MsalAccountInfo,
  type AuthenticationResult,
  type IPublicClientApplication,
} from '@azure/msal-browser';
import type {
  MsalAuthPlugin,
  AcquireTokenOptions,
  AcquireTokenResult,
  AccountInfo,
  SignOutOptions,
} from './definitions';

/**
 * Shape of the web-platform config file this implementation fetches at
 * runtime. Mirrors the field names of the native `msal_config.json`
 * templates (`ios/Plugin/msal_config.json`,
 * `android/src/main/res/raw/msal_config.json`) so all three platforms share
 * the same setup mental model - see the plugin README's "Web / PWA setup"
 * section for the full explanation of each field.
 *
 * Must be served as a static asset at `assets/msal_config.json` (relative to
 * the app's `<base href>`). In an Ionic/Angular app that means dropping the
 * file at `src/assets/msal_config.json` - the default Angular CLI asset
 * config already copies `src/assets/**` to `www/assets/**`.
 */
interface WebMsalConfigFile {
  client_id: string;
  /** e.g. 'https://<tenant-subdomain>.ciamlogin.com/<tenant-id>' */
  authority_url: string;
  /**
   * Only needed for some Entra External ID (CIAM) setups where the token
   * issuer host differs from the authority host - see msal-browser's
   * `knownAuthorities` config option. Defaults to `[]`.
   */
  known_authorities?: string[];
  /** Must exactly match a redirect URI registered on this app's Web/SPA platform. Defaults to `window.location.origin`. */
  redirect_uri?: string;
  /** Defaults to `redirect_uri`. */
  post_logout_redirect_uri?: string;
}

const CONFIG_PATH = 'assets/msal_config.json';

/**
 * Web/PWA implementation backed by `@azure/msal-browser`, kept behind the
 * same `MsalAuthPlugin` contract the native iOS/Android implementations use
 * so callers (see `home.page.ts`, `auth.interceptor.ts`) don't need
 * platform-specific branches.
 *
 * Interactive sign-in/sign-out use msal-browser's *redirect* APIs
 * (`loginRedirect`/`logoutRedirect`), not popups. Microsoft's own MSAL.js
 * guidance is that popups are "unreliable in Safari and mobile browsers due
 * to popup blocker and gesture constraints," while redirect is "the most
 * reliable interaction type across browsers, including Safari and mobile
 * browsers" - the deciding factor for a PWA target.
 *
 * The tradeoff: `loginRedirect()`/`logoutRedirect()` navigate the browser
 * away before their promises would otherwise resolve, so `signIn()` and
 * `signOut({ clearBrowserSession: true })` below deliberately never resolve
 * on web - unlike native, where the OS browser overlay returns control to
 * the same JS context. The signed-in result is instead recovered on the
 * *next* page load, once `handleRedirectPromise()` has processed it during
 * initialization (see `createInstance()`). Callers must not block UI on
 * `signIn()`'s promise settling on web; they should instead call
 * `getAccount()` on app startup to pick up a just-completed redirect.
 */
export class MsalAuthWeb extends WebPlugin implements MsalAuthPlugin {
  private initPromise: Promise<IPublicClientApplication> | null = null;

  async signIn(options: AcquireTokenOptions): Promise<AcquireTokenResult> {
    const pca = await this.getInstance();
    try {
      await pca.loginRedirect({
        scopes: options.scopes ?? [],
        domainHint: options.domainHint,
        prompt: options.prompt,
      });
    } catch (error) {
      throw this.rejection('SIGN_IN_FAILED', this.messageOf(error));
    }
    // Unreachable in practice: loginRedirect() above navigates the page away
    // first. Nothing after this point runs in this JS context.
    return new Promise<AcquireTokenResult>(() => undefined);
  }

  async acquireTokenSilent(options: AcquireTokenOptions): Promise<AcquireTokenResult> {
    const pca = await this.getInstance();
    const account = pca.getActiveAccount() ?? pca.getAllAccounts()[0];
    if (!account) {
      throw this.rejection('UI_REQUIRED', 'No cached account - call signIn() first.');
    }
    try {
      const result = await pca.acquireTokenSilent({ account, scopes: options.scopes ?? [] });
      return this.toResult(result);
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        throw this.rejection('UI_REQUIRED', error.message);
      }
      throw this.rejection('SILENT_FAILED', this.messageOf(error));
    }
  }

  async getAccount(): Promise<AccountInfo | null> {
    const pca = await this.getInstance();
    const account = pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
    return account ? this.toAccountInfo(account) : null;
  }

  async signOut(options?: SignOutOptions): Promise<void> {
    const pca = await this.getInstance();
    const account = pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? undefined;
    try {
      if (options?.clearBrowserSession) {
        // Ends the Entra browser SSO session too, not just the local cache -
        // like signIn() above, this navigates away and never returns here.
        await pca.logoutRedirect({ account });
        return new Promise<void>(() => undefined);
      }
      // Local-only sign-out: clears this account's cached tokens without any
      // network call or navigation, matching native signOut()'s default
      // "local cache only" behavior.
      await pca.clearCache({ account });
    } catch (error) {
      throw this.rejection('SIGN_OUT_FAILED', this.messageOf(error));
    }
  }

  private async getInstance(): Promise<IPublicClientApplication> {
    if (!this.initPromise) {
      // Memoize per page load, but let a failed attempt be retried instead
      // of permanently poisoning every later call with the same rejection.
      this.initPromise = this.createInstance().catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async createInstance(): Promise<IPublicClientApplication> {
    const config = await this.loadConfig();
    const redirectUri = config.redirect_uri ?? window.location.origin;

    const pca = await createStandardPublicClientApplication({
      auth: {
        clientId: config.client_id,
        authority: config.authority_url,
        knownAuthorities: config.known_authorities ?? [],
        redirectUri,
        postLogoutRedirectUri: config.post_logout_redirect_uri ?? redirectUri,
      },
      cache: {
        // localStorage (not the sessionStorage default) so a signed-in user
        // stays signed in across app relaunches/tab closes, matching native
        // MSAL's persistent Keychain/EncryptedSharedPreferences cache - the
        // PWA equivalent of "not native" would otherwise re-prompt every
        // fresh tab, unlike iOS/Android.
        cacheLocation: BrowserCacheLocation.LocalStorage,
      },
    });

    // Must run exactly once per page load, before any other account-reading
    // call - this is what completes the loginRedirect()/logoutRedirect()
    // round trip from the previous page load, if one is in flight. A failure
    // here (e.g. the user denied consent on the Entra page) shouldn't break
    // the whole plugin instance - it's swallowed so getAccount() simply comes
    // back null and the app can prompt sign-in again, mirroring how a
    // rejected native signIn() call leaves the app just as unauthenticated.
    try {
      const redirectResult = await pca.handleRedirectPromise();
      if (redirectResult?.account) {
        pca.setActiveAccount(redirectResult.account);
      }
    } catch (error) {
      console.warn('[MsalAuthWeb] handleRedirectPromise() failed', error);
    }

    return pca;
  }

  private async loadConfig(): Promise<WebMsalConfigFile> {
    const help = `Add a web msal_config.json at "${CONFIG_PATH}" (e.g. src/assets/msal_config.json in an Ionic/Angular app) - see the plugin README's "Web / PWA setup" section.`;
    let response: Response;
    try {
      response = await fetch(CONFIG_PATH);
    } catch (error) {
      throw this.rejection('NOT_INITIALIZED', `Could not load ${CONFIG_PATH}: ${this.messageOf(error)}. ${help}`);
    }
    if (!response.ok) {
      throw this.rejection('NOT_INITIALIZED', `${CONFIG_PATH} returned HTTP ${response.status}. ${help}`);
    }
    const config = (await response.json()) as WebMsalConfigFile;
    if (!config.client_id || !config.authority_url) {
      throw this.rejection('NOT_INITIALIZED', `${CONFIG_PATH} is missing client_id or authority_url. ${help}`);
    }
    return config;
  }

  private toResult(result: AuthenticationResult): AcquireTokenResult {
    return {
      accessToken: result.accessToken,
      idToken: result.idToken,
      expiresOn: result.expiresOn ? result.expiresOn.getTime() : Date.now(),
      // Local MSAL account identifier, not the raw `oid` claim - matches the
      // native implementations' accountId semantics (see definitions.ts).
      accountId: result.account?.homeAccountId ?? '',
      scopes: result.scopes,
    };
  }

  private toAccountInfo(account: MsalAccountInfo): AccountInfo {
    return {
      accountId: account.homeAccountId,
      username: account.username ?? null,
      idTokenClaims: (account.idTokenClaims as Record<string, unknown> | undefined) ?? null,
    };
  }

  private rejection(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
