import Foundation
import Capacitor
import MSAL

/// Wraps the MSAL iOS SDK so the Ionic/Angular layer only ever deals with
/// plain JS objects and promises.
///
/// Requires the MSAL pod (pod 'MSAL', '~> 1.2') and an entry in Info.plist
/// registering the CFBundleURLSchemes redirect URI, plus LSApplicationQueriesSchemes
/// entries for "msauthv2" / "msauthv3" if you want broker support.
@objc(MsalAuthPlugin)
public class MsalAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MsalAuthPlugin"
    public let jsName = "MsalAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acquireTokenSilent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise)
    ]

    private var application: MSALPublicClientApplication?

    override public func load() {
        NSLog("MsalAuthPlugin: load() called")
        guard
            let path = Bundle.main.path(forResource: "msal_config", ofType: "json"),
            let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let clientId = json["client_id"] as? String,
            let authorityUrlString = json["authority_url"] as? String,
            let redirectUri = json["redirect_uri"] as? String,
            let authorityUrl = URL(string: authorityUrlString)
        else {
            NSLog("MsalAuthPlugin: failed to load msal_config.json")
            return
        }
        NSLog("MsalAuthPlugin: parsed config, clientId=%@ authority=%@ redirectUri=%@", clientId, authorityUrlString, redirectUri)

        do {
            let authority = try MSALCIAMAuthority(url: authorityUrl)
            let config = MSALPublicClientApplicationConfig(
                clientId: clientId,
                redirectUri: redirectUri,
                authority: authority
            )
            application = try MSALPublicClientApplication(configuration: config)
            NSLog("MsalAuthPlugin: MSALPublicClientApplication initialized successfully")
        } catch {
            NSLog("MsalAuthPlugin: failed to init MSAL - %@", String(describing: error))
        }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        NSLog("MsalAuthPlugin: signIn() called")
        // 'openid', 'profile' and 'offline_access' are reserved scopes MSAL
        // adds automatically - callers should only pass scopes for a specific
        // protected resource here, or none at all for a basic sign-in.
        let scopes = call.getArray("scopes", String.self) ?? []
        let domainHint = call.getString("domainHint")
        guard let application = application else {
            NSLog("MsalAuthPlugin: signIn() rejected - MSAL not initialized")
            call.reject("MSAL not initialized", "NOT_INITIALIZED")
            return
        }
        guard let viewController = bridge?.viewController else {
            NSLog("MsalAuthPlugin: signIn() rejected - no view controller")
            call.reject("No view controller to present sign-in from")
            return
        }
        NSLog("MsalAuthPlugin: signIn() guards passed, scopes=%@, domainHint=%@, dispatching acquireToken", scopes, domainHint ?? "nil")

        DispatchQueue.main.async {
            NSLog("MsalAuthPlugin: on main queue, building webParameters")
            let webParameters = MSALWebviewParameters(authPresentationViewController: viewController)
            let interactiveParameters = MSALInteractiveTokenParameters(scopes: scopes, webviewParameters: webParameters)
            if let domainHint = domainHint, !domainHint.isEmpty {
                interactiveParameters.extraQueryParameters = ["domain_hint": domainHint]
            }

            NSLog("MsalAuthPlugin: calling application.acquireToken(with:)")
            application.acquireToken(with: interactiveParameters) { result, error in
                NSLog("MsalAuthPlugin: acquireToken completion invoked, error=%@, result=%@", String(describing: error), String(describing: result))
                if let error = error {
                    call.reject(error.localizedDescription, self.errorCode(for: error), error)
                    return
                }
                guard let result = result else {
                    call.reject("No result returned from MSAL")
                    return
                }
                call.resolve(self.toResultJson(result))
            }
            NSLog("MsalAuthPlugin: acquireToken(with:) call returned (async, awaiting completion)")
        }
    }

    @objc func acquireTokenSilent(_ call: CAPPluginCall) {
        let scopes = call.getArray("scopes", String.self) ?? []
        guard let application = application else {
            call.reject("MSAL not initialized", "NOT_INITIALIZED")
            return
        }

        do {
            guard let account = try application.allAccounts().first else {
                call.reject("No cached account, call signIn() first", "UI_REQUIRED")
                return
            }
            let silentParameters = MSALSilentTokenParameters(scopes: scopes, account: account)
            application.acquireTokenSilent(with: silentParameters) { result, error in
                if let error = error as NSError? {
                    if error.domain == MSALErrorDomain,
                       error.code == MSALError.interactionRequired.rawValue {
                        call.reject("Interactive sign-in required", "UI_REQUIRED", error)
                    } else {
                        call.reject(error.localizedDescription, "SILENT_FAILED", error)
                    }
                    return
                }
                guard let result = result else {
                    call.reject("No result returned from MSAL")
                    return
                }
                call.resolve(self.toResultJson(result))
            }
        } catch {
            call.reject(error.localizedDescription, "SILENT_FAILED", error)
        }
    }

    @objc func getAccount(_ call: CAPPluginCall) {
        guard let application = application else {
            call.resolve(["value": NSNull()])
            return
        }
        do {
            guard let account = try application.allAccounts().first else {
                call.resolve(["value": NSNull()])
                return
            }
            call.resolve([
                "value": [
                    "accountId": account.identifier ?? "",
                    "username": account.username ?? NSNull(),
                    "idTokenClaims": account.accountClaims ?? [:]
                ]
            ])
        } catch {
            call.reject(error.localizedDescription, "GET_ACCOUNT_FAILED", error)
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        guard let application = application else {
            call.resolve()
            return
        }
        do {
            guard let account = try application.allAccounts().first else {
                call.resolve()
                return
            }
            try application.remove(account)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "SIGN_OUT_FAILED", error)
        }
    }

    private func toResultJson(_ result: MSALResult) -> [String: Any] {
        return [
            "accessToken": result.accessToken,
            "idToken": result.idToken ?? "",
            "expiresOn": (result.expiresOn?.timeIntervalSince1970 ?? 0) * 1000,
            "accountId": result.account.identifier ?? "",
            "scopes": result.scopes
        ]
    }

    private func errorCode(for error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == MSALErrorDomain, nsError.code == MSALError.userCanceled.rawValue {
            return "USER_CANCELLED"
        }
        return "SIGN_IN_FAILED"
    }
}
