# capacitor-msal-entra-plugin

Capacitor plugin wrapping the native MSAL SDKs (MSAL Android / MSAL iOS) for
sign-in against Microsoft Entra External ID, with secure native token
caching instead of a hand-rolled browser+PKCE flow.

This is a starting scaffold, not a published package — copy it into your
Ionic project (e.g. `packages/capacitor-msal-entra-plugin`), reference it
as a local dependency, and adjust package names / bundle ids to match your
app.

## 1. Install into your Ionic app

```bash
npm install /path/to/capacitor-msal-entra-plugin
npx cap sync
```

## 2. Android setup

- `android/app/build.gradle`: no extra step needed, the plugin module
  already declares the MSAL dependency. **But your app's root
  `android/build.gradle` does need one addition**: MSAL pulls in
  `com.microsoft.identity:common`, which transitively depends on
  `com.microsoft.device.display:display-mask` — a package published only to
  a Microsoft-hosted Azure DevOps Maven feed, not to Maven Central or
  Google's repo. Without it, `:app:assembleDebug` fails at
  `checkDebugAarMetadata` unable to resolve `display-mask`. Add this
  repository to your app's `allprojects { repositories { ... } }` block (a
  subproject-level `repositories {}`, including this plugin module's own, is
  **not** enough — Gradle resolves the app module's full transitive
  classpath using the app module's own repository list):
  ```groovy
  maven {
      url 'https://pkgs.dev.azure.com/MicrosoftDeviceSDK/DuoSDK-Public/_packaging/Duo-SDK-Feed/maven/v1'
      name 'Duo-SDK-Feed'
  }
  ```
- Copy `android/src/main/res/raw/msal_config.json` into
  `android/app/src/main/res/raw/msal_config.json` in your app and fill in:
  - `client_id`: the Ionic app's registration client id
  - `redirect_uri`: `msauth://<your.package.name>/<base64 signature hash>`
    — generate the signature hash with `keytool` + `openssl` per the MSAL
    Android docs, once per signing key (debug and release will differ). The
    signature hash must be **URL-encoded** here (`+`→`%2B`, `/`→`%2F`,
    `=`→`%3D`) — this is easy to get wrong since the *same* hash goes into
    `AndroidManifest.xml` (below) **unencoded**.
  - `authority_url`: your Entra External ID tenant's CIAM authority.
- In `AndroidManifest.xml`, add the `BrowserTabActivity` intent filter MSAL
  needs to catch the redirect:
  ```xml
  <activity
      android:name="com.microsoft.identity.client.BrowserTabActivity"
      android:exported="true">
      <intent-filter>
          <action android:name="android.intent.action.VIEW" />
          <category android:name="android.intent.category.DEFAULT" />
          <category android:name="android.intent.category.BROWSABLE" />
          <data
              android:scheme="msauth"
              android:host="<your.package.name>"
              android:path="/<base64 signature hash, NOT URL-encoded>" />
      </intent-filter>
  </activity>
  ```
  The `android:path` value must have a leading `/` and use the raw
  (non-URL-encoded) signature hash — unlike `redirect_uri` in
  `msal_config.json` above.

## 3. iOS setup

- Your app's `ios/App` must use CocoaPods, not Capacitor's default Swift
  Package Manager integration — this plugin ships a podspec
  (`CapacitorMsalEntraPlugin.podspec`), not a `Package.swift`, so Capacitor
  CLI cannot include it via SPM. If `ios/App/CapApp-SPM` exists in your app,
  remove it, delete any `CapApp-SPM` Swift package reference from the Xcode
  project, and add an `ios/App/Podfile` (Capacitor's classic CocoaPods
  template — see `ios/App-Podfile.example`) before running `cap sync`.
  Mixing SPM-managed Capacitor core with a CocoaPods-only plugin is not
  supported; pick CocoaPods for the whole app.
- Once on CocoaPods, no manual `Podfile` edits needed for this plugin:
  `npx cap sync ios` reads this plugin's `package.json`
  (`capacitor.ios.src: "ios"`), derives the pod name
  `CapacitorMsalEntraPlugin` from the package name, and auto-injects a
  `pod 'CapacitorMsalEntraPlugin', :path => ...` line into your app's
  `ios/App/Podfile`, which pulls in MSAL transitively via the podspec's
  `s.dependency 'MSAL'`. See `ios/App-Podfile.example` for exactly what
  that generated block looks like. Just run `npx cap sync ios` then
  `pod install` inside `ios/App` (`cap sync` does this for you if
  CocoaPods is installed).
- Copy `ios/Plugin/msal_config.json` into your app's bundle (add it to the
  Xcode target) and fill in `client_id`, `redirect_uri`, `authority_url`.
- In `Info.plist`:
  - Add a `CFBundleURLTypes` entry with `CFBundleURLSchemes` containing your
    redirect scheme, e.g. `msauth.com.yourcompany.loyaltyos`.
  - Add `LSApplicationQueriesSchemes` with `msauthv2` and `msauthv3` if you
    want broker (Microsoft Authenticator) support.
- Add a **Keychain Sharing** entitlement. MSAL caches accounts/tokens in the
  Keychain under its own shared access group; without this, interactive
  `signIn()` still works (the result comes back in-memory) but any call that
  reads the cache back — `getAccount()`, `acquireTokenSilent()`,
  `signOut()` — fails with `OSStatus error -34018`
  (`errSecMissingEntitlement`). Add an entitlements file (or enable "Keychain
  Sharing" under Xcode's Signing & Capabilities tab) containing:
  ```xml
  <key>keychain-access-groups</key>
  <array>
      <string>$(AppIdentifierPrefix)com.microsoft.adalcache</string>
  </array>
  ```
  and make sure it's wired up via the target's `CODE_SIGN_ENTITLEMENTS` build
  setting.

## 4. Web / PWA setup

Unlike earlier scaffolds of this plugin, the web platform is a real
implementation backed by [`@azure/msal-browser`](https://github.com/AzureAD/microsoft-authentication-library-for-js/tree/dev/lib/msal-browser)
(added automatically as a dependency of this package) - not a stub. It's
used automatically whenever the app runs somewhere without the native
bridge: `ionic serve`, a browser tab, or an installed PWA.

- Add a **Single-page application** platform (not "Web" - that platform
  type is for confidential/server-side clients and doesn't get CORS-allowed
  on the token endpoint for the PKCE flow msal-browser uses, which fails
  with an opaque CORS error) to the same Entra app registration used by
  iOS/Android (Authentication -> Add a platform), with a redirect URI
  matching where the app is actually served - e.g. `http://localhost:4200`
  for this app's `ng serve` (`http://localhost:8100` if you use the Ionic
  CLI's `ionic serve` instead, which defaults to a different port), or your
  deployed PWA's origin. This is a separate platform entry from the
  `msauth://...` redirect URIs iOS/Android use, and Entra allows a plain
  `http://localhost:<port>` redirect URI here for local dev even though
  other platforms require `https`.
- Copy `web/msal_config.json` from this plugin into your app's assets
  folder as `assets/msal_config.json` (in an Ionic/Angular app: put it at
  `src/assets/msal_config.json` - the default Angular CLI asset config
  copies `src/assets/**` to `www/assets/**`, so this is fetched at
  `assets/msal_config.json` relative to the app's `<base href>` at
  runtime). Fill in:
  - `client_id`: the Web/SPA platform's client id (usually the same app
    registration as iOS/Android, just a different platform entry).
  - `authority_url`: same CIAM authority as the other platforms, e.g.
    `https://<tenant-subdomain>.ciamlogin.com/<tenant-subdomain>.onmicrosoft.com/`.
  - `redirect_uri` / (optional) `known_authorities`: see the comments in
    `web/msal_config.json`.
- No manifest/Info.plist-equivalent step - the redirect is handled entirely
  by msal-browser inside the page, not an OS-level URL scheme.

### Behavioral differences from native (important)

- **Interactive sign-in uses a full-page redirect, not a popup.** MSAL.js's
  own guidance is that popups are "unreliable in Safari and mobile browsers
  due to popup blocker and gesture constraints," while redirect is "the
  most reliable interaction type across browsers, including Safari and
  mobile browsers" - the deciding factor for a PWA. The consequence:
  `signIn()` and `signOut({ clearBrowserSession: true })` **navigate the
  browser away and their returned promises never resolve on web** - the
  whole JS context is torn down and recreated once Entra redirects back,
  unlike native where an in-app browser overlay returns control to the same
  JS context. Don't block UI on those promises settling on web.
- **Call `getAccount()` on app startup** to pick up a sign-in that just
  completed via redirect (see `HomePage.ngOnInit()` in the demo app for the
  pattern) - this is how the result of `signIn()` actually reaches your app
  on web, instead of via `signIn()`'s own return value.
- `signOut()` without `clearBrowserSession` clears the local cache only (no
  navigation), same as native. With `clearBrowserSession: true` it also
  redirects to Entra's logout endpoint to end the browser SSO session (same
  never-resolves caveat as `signIn()`).
- The web token cache uses `localStorage` (not msal-browser's
  `sessionStorage` default) so a signed-in user stays signed in across tab
  closes/relaunches, matching native's persistent Keychain/
  EncryptedSharedPreferences cache.
- Calling an interactive `signIn()` from inside `AuthInterceptor`'s
  `UI_REQUIRED` fallback (see `auth.interceptor.ts`) will navigate the whole
  app away mid-request on web - fine for a demo, but a real app should
  surface a "session expired, please sign in again" state instead of
  re-authenticating unprompted from inside an HTTP interceptor.

## 5. Usage from Angular/Ionic

```typescript
import { MsalAuth } from 'capacitor-msal-entra-plugin';

const API_SCOPE = 'api://loyaltyos-api/access_as_user';

async function signIn() {
  const result = await MsalAuth.signIn({ scopes: [API_SCOPE] });
  // result.accessToken -> attach as Authorization: Bearer <token> on API calls
  // result.accountId   -> stable per-user id (maps to the token's oid claim)
}

async function getFreshToken(): Promise<string> {
  try {
    const result = await MsalAuth.acquireTokenSilent({ scopes: [API_SCOPE] });
    return result.accessToken;
  } catch (e: any) {
    if (e.code === 'UI_REQUIRED') {
      const result = await MsalAuth.signIn({ scopes: [API_SCOPE] });
      return result.accessToken;
    }
    throw e;
  }
}

async function signOut() {
  await MsalAuth.signOut();
}
```

A typical pattern is an Angular `AuthInterceptor` that calls
`getFreshToken()` before every outgoing API request, catching `UI_REQUIRED`
to trigger a re-auth prompt only when silent renewal genuinely fails.

### Federated sign-in (Google, Apple, ...) via `domainHint` — iOS and web

If the Entra External ID tenant's user flow has social identity providers
configured (see your tenant admin's setup, or the "Add Google/Apple as an
identity provider" docs), the hosted Entra sign-in page shows buttons for
each one alongside email/password. Pass `domainHint` to `signIn()` to skip
that picker page and go straight to a specific provider's own login screen:

```typescript
await MsalAuth.signIn({ scopes: [], domainHint: 'Google' }); // capital G, case-sensitive
await MsalAuth.signIn({ scopes: [], domainHint: 'apple' });
```

This sends `domain_hint=<value>` as an extra query parameter on the
authorize request (`MSALInteractiveTokenParameters.extraQueryParameters` on
iOS; the `domainHint` field on msal-browser's `loginRedirect()` request on
web). It has no effect on `acquireTokenSilent()`, does not yet work on
**Android** (that implementation does not read this option — see Known
gaps), and only works if the provider is actually enabled on the tenant's
user flow. On web it's subject to the same caveat as a plain `signIn()`
call - see "Web / PWA setup" above: the browser navigates away and
`signIn()`'s promise never resolves, so a "Sign in with Google" button
built this way still needs the `getAccount()`-on-startup pattern, not a
`.then()` off the `signIn()` call itself.

**The hint value must be the bare provider name for social IdPs** — Google,
Facebook, and Apple are `'Google'` (capital G — case-sensitive, `'google'`
fails with `AADSTS90023: 'google' '' pair is not an external identity
provider`), `'facebook'`, `'apple'` respectively (this is Microsoft's "issuer
acceleration" mechanism). A domain-shaped value like
`'apple.com'` is a *different*, unrelated mechanism ("domain acceleration")
reserved for custom SAML/WS-Fed IdPs matched by a configured domain — passing
one for a social IdP won't just fail cleanly, it can misroute the user to
whatever Entra associates with that literal domain (e.g. `'apple.com'`
routing to Apple's own business identity portal instead of "Sign in with
Apple"). For a custom OIDC provider, use the domain segment of its issuer URI
instead (e.g. `'www.linkedin.com'` for LinkedIn).

## 6. Backend API: validating the access token

The `accessToken` returned by `signIn()` / `acquireTokenSilent()` is a JWT
issued by the External ID (CIAM) tenant, scoped to your API via the
`scopes` you requested (e.g. `api://<api-client-id>/read`). The client
sends it as `Authorization: Bearer <accessToken>`; your API must validate
it on every request rather than trust it blindly. For a CIAM tenant the
token has this shape (decode any token at [jwt.ms](https://jwt.ms) to
check yours):

- `iss`: `https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0`
- `aud`: your API's Application (client) ID, or its Application ID URI
  (e.g. `api://<api-client-id>`) if you set one under **Expose an API**
- `scp`: a space-separated list of the *bare* scope names the token was
  granted, e.g. `"read write"` — not the full `api://...` URI
- signature: RS256, verified against the tenant's JWKS
  (`https://<tenant-id>.ciamlogin.com/<tenant-id>/discovery/v2.0/keys`,
  discoverable from
  `https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration`)

Never skip signature/issuer/audience checks and never decode-and-trust a
token client-side — validation has to happen on the API.

### .NET (ASP.NET Core + Microsoft.Identity.Web)

This follows Microsoft's own pattern for protecting an ASP.NET Core API
against an External ID tenant.

```bash
dotnet add package Microsoft.Identity.Web
```

`appsettings.json`:

```json
{
  "AzureAd": {
    "Instance": "https://<tenant-subdomain>.ciamlogin.com/",
    "TenantId": "<tenant-id>",
    "ClientId": "<api-client-id>",
    "Scopes": {
      "Read": ["read", "write"],
      "Write": ["write"]
    }
  }
}
```

`Program.cs`:

```csharp
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Identity.Web;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"));

builder.Services.AddAuthorization();
builder.Services.AddControllers();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.Run();
```

Controller:

```csharp
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Identity.Web.Resource;

[Authorize]
[ApiController]
[Route("api/[controller]")]
public class WidgetsController : ControllerBase
{
    [HttpGet]
    [RequiredScopeOrAppPermission(RequiredScopesConfigurationKey = "AzureAd:Scopes:Read")]
    public IActionResult Get() => Ok(new[] { "widget-1", "widget-2" });

    [HttpPost]
    [RequiredScopeOrAppPermission(RequiredScopesConfigurationKey = "AzureAd:Scopes:Write")]
    public IActionResult Post([FromBody] object widget) => Created("", widget);
}
```

`[Authorize]` rejects anything that fails signature/issuer/audience/expiry
validation; `Microsoft.Identity.Web` handles all of that from the
`AzureAd` config above. `[RequiredScopeOrAppPermission]` then checks the
token's `scp` (or `roles`, for app-only calls) against the configured
scope list and returns `403` if it doesn't match.

### Express.js (Node)

There's no CIAM-specific Microsoft package for Express — `passport-azure-ad`
predates External ID and isn't a good fit. The standard approach is
`express-jwt` + `jwks-rsa`, which is generic OIDC/JWT validation, not
Microsoft-specific:

```bash
npm install express express-jwt jwks-rsa
```

```javascript
const express = require('express');
const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');

const TENANT_ID = '<tenant-id>';
const API_CLIENT_ID = '<api-client-id>'; // or 'api://<api-client-id>' if you set an App ID URI
const ISSUER = `https://${TENANT_ID}.ciamlogin.com/${TENANT_ID}/v2.0`;

const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `${ISSUER}/.well-known/openid-configuration`, // resolved to jwks_uri internally
  }),
  issuer: ISSUER,
  audience: API_CLIENT_ID,
  algorithms: ['RS256'],
});

function requireScope(...allowed) {
  return (req, res, next) => {
    const granted = (req.auth?.scp ?? '').split(' ');
    if (allowed.some((s) => granted.includes(s))) return next();
    res.status(403).json({ error: 'insufficient_scope' });
  };
}

const app = express();
app.use(express.json());

app.get('/api/widgets', checkJwt, requireScope('read', 'write'), (req, res) => {
  res.json(['widget-1', 'widget-2']);
});

app.post('/api/widgets', checkJwt, requireScope('write'), (req, res) => {
  res.status(201).json(req.body);
});

app.listen(3000);
```

`jwks-rsa`'s `expressJwtSecret` accepts a `jwksUri` — pass the
`.well-known/openid-configuration` discovery URL (as above) so it doesn't
depend on hardcoding the tenant's JWKS path, which lets Microsoft rotate
the endpoint shape without breaking your API. `express-jwt` verifies
signature, `issuer`, `audience`, and expiry before your route handler
ever runs; `requireScope` is a thin extra check on top for per-route
authorization, mirroring what `[RequiredScopeOrAppPermission]` does on
the .NET side.

References: [Tutorial: Build and secure an ASP.NET Core web API](https://learn.microsoft.com/en-us/entra/identity-platform/tutorial-web-api-dotnet-core-build-app),
[Validating tokens](https://learn.microsoft.com/en-us/azure/active-directory/develop/access-tokens#validating-tokens).

## Notes

- `accountId` is the local MSAL account identifier, not the raw `oid` claim
  — decode the returned `idToken` (or have your backend read `oid` from the
  validated access/id token) if you need the tenant's object id specifically.
- This scaffold assumes single-tenant, single-account usage (one signed-in
  user at a time). Both native SDKs support multiple accounts if you need
  account switching later.
- Test the Android redirect URI signature hash separately for debug and
  release keystores — this is the single most common MSAL Android setup
  failure.
