package io.nativelement.msalentra

import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.microsoft.identity.client.AuthenticationCallback
import com.microsoft.identity.client.IAccount
import com.microsoft.identity.client.IAuthenticationResult
import com.microsoft.identity.client.IMultipleAccountPublicClientApplication
import com.microsoft.identity.client.IPublicClientApplication
import com.microsoft.identity.client.PublicClientApplication
import com.microsoft.identity.client.SilentAuthenticationCallback
import com.microsoft.identity.client.exception.MsalClientException
import com.microsoft.identity.client.exception.MsalException
import com.microsoft.identity.client.exception.MsalUiRequiredException
import org.json.JSONObject

/**
 * Wraps the MSAL Android SDK (com.microsoft.identity.client:msal) so the
 * Ionic/Angular layer only ever deals with plain JS objects and promises.
 *
 * Requires:
 *   implementation 'com.microsoft.identity.client:msal:5.+'
 * and a msal_config.json under android/app/src/main/res/raw/ describing
 * the client id, redirect uri, and Entra External ID authority.
 */
@CapacitorPlugin(name = "MsalAuth")
class MsalAuthPlugin : Plugin() {

    private var pca: IMultipleAccountPublicClientApplication? = null
    private val TAG = "MsalAuthPlugin"

    override fun load() {
        super.load()
        val configResId = context.resources.getIdentifier(
            "msal_config", "raw", context.packageName
        )
        PublicClientApplication.createMultipleAccountPublicClientApplication(
            context,
            configResId,
            object : IPublicClientApplication.IMultipleAccountApplicationCreatedListener {
                override fun onCreated(application: IMultipleAccountPublicClientApplication) {
                    pca = application
                }

                override fun onError(exception: MsalException) {
                    Log.e(TAG, "Failed to initialize MSAL", exception)
                }
            }
        )
    }

    @PluginMethod
    fun signIn(call: PluginCall) {
        // 'openid', 'profile' and 'offline_access' are reserved scopes MSAL
        // adds automatically, and callers should only pass scopes for a
        // specific resource - but unlike MSAL iOS (which accepts an empty
        // array), MSAL Android's TokenParameters.withScopes() throws
        // IllegalArgumentException on an empty list. Default to "openid" -
        // a standard, always-safe OIDC scope - so a caller passing [] (the
        // common case for a bare sign-in) works on both platforms.
        val requestedScopes = call.getArray("scopes")?.toList<String>() ?: emptyList()
        val scopes = requestedScopes.ifEmpty { listOf("openid") }
        val application = pca
        if (application == null) {
            call.reject("MSAL not initialized yet, try again shortly", "NOT_INITIALIZED")
            return
        }

        val activity = activity ?: run {
            call.reject("No current activity to launch sign-in from")
            return
        }

        val parameters = com.microsoft.identity.client.AcquireTokenParameters.Builder()
            .startAuthorizationFromActivity(activity)
            .withScopes(scopes)
            .withCallback(object : AuthenticationCallback {
                override fun onSuccess(authenticationResult: IAuthenticationResult) {
                    call.resolve(toResultJson(authenticationResult))
                }

                override fun onError(exception: MsalException) {
                    call.reject(exception.message, exception.errorCode, exception)
                }

                override fun onCancel() {
                    call.reject("User cancelled sign-in", "USER_CANCELLED")
                }
            })
            .build()

        application.acquireToken(parameters)
    }

    @PluginMethod
    fun acquireTokenSilent(call: PluginCall) {
        val requestedScopes = call.getArray("scopes")?.toList<String>() ?: emptyList()
        val scopes = requestedScopes.ifEmpty { listOf("openid") }
        val application = pca
        if (application == null) {
            call.reject("MSAL not initialized yet, try again shortly", "NOT_INITIALIZED")
            return
        }

        application.getAccounts(object : IPublicClientApplication.LoadAccountsCallback {
            override fun onTaskCompleted(accounts: MutableList<IAccount>) {
                val account = accounts.firstOrNull()
                if (account == null) {
                    call.reject("No cached account, call signIn() first", "UI_REQUIRED")
                    return
                }

                val silentParameters = com.microsoft.identity.client.AcquireTokenSilentParameters.Builder()
                    .forAccount(account)
                    .fromAuthority(account.authority)
                    .withScopes(scopes)
                    .withCallback(object : SilentAuthenticationCallback {
                        override fun onSuccess(authenticationResult: IAuthenticationResult) {
                            call.resolve(toResultJson(authenticationResult))
                        }

                        override fun onError(exception: MsalException) {
                            if (exception is MsalUiRequiredException) {
                                call.reject("Interactive sign-in required", "UI_REQUIRED", exception)
                            } else {
                                call.reject(exception.message, "SILENT_FAILED", exception)
                            }
                        }
                    })
                    .build()

                application.acquireTokenSilentAsync(silentParameters)
            }

            override fun onError(exception: MsalException) {
                call.reject(exception.message, "SILENT_FAILED", exception)
            }
        })
    }

    @PluginMethod
    fun getAccount(call: PluginCall) {
        val application = pca ?: run {
            call.resolve(JSObject().put("value", null))
            return
        }
        application.getAccounts(object : IPublicClientApplication.LoadAccountsCallback {
            override fun onTaskCompleted(accounts: MutableList<IAccount>) {
                val account = accounts.firstOrNull()
                if (account == null) {
                    call.resolve(JSObject().put("value", null))
                    return
                }
                val result = JSObject()
                result.put("accountId", account.id)
                result.put("username", account.username)
                val claims = JSObject()
                account.claims?.forEach { (k, v) -> claims.put(k, claimValueToJson(v)) }
                result.put("idTokenClaims", claims)
                val wrapper = JSObject()
                wrapper.put("value", result)
                call.resolve(wrapper)
            }

            override fun onError(exception: MsalException) {
                call.reject(exception.message, "GET_ACCOUNT_FAILED", exception)
            }
        })
    }

    @PluginMethod
    fun signOut(call: PluginCall) {
        val application = pca ?: run {
            call.resolve()
            return
        }
        application.getAccounts(object : IPublicClientApplication.LoadAccountsCallback {
            override fun onTaskCompleted(accounts: MutableList<IAccount>) {
                if (accounts.isEmpty()) {
                    call.resolve()
                    return
                }
                // Remove every cached account, not just the first - MSAL's
                // encrypted cache can accumulate more than one account over
                // time, and signOut() must guarantee no account remains
                // afterward, not just remove whichever one happens to be
                // first in the list. Callbacks land on the main thread (MSAL
                // Android convention), so plain vars are safe here without
                // atomics.
                var remaining = accounts.size
                var failed = false
                for (account in accounts) {
                    application.removeAccount(
                        account,
                        object : IMultipleAccountPublicClientApplication.RemoveAccountCallback {
                            override fun onRemoved() {
                                remaining--
                                if (remaining == 0 && !failed) {
                                    call.resolve()
                                }
                            }

                            override fun onError(exception: MsalException) {
                                if (!failed) {
                                    failed = true
                                    call.reject(exception.message, "SIGN_OUT_FAILED", exception)
                                }
                            }
                        }
                    )
                }
            }

            override fun onError(exception: MsalException) {
                call.reject(exception.message, "SIGN_OUT_FAILED", exception)
            }
        })
    }

    private fun toResultJson(result: IAuthenticationResult): JSObject {
        val json = JSObject()
        json.put("accessToken", result.accessToken)
        // IAccount extends IClaimable, whose getIdToken() returns the raw JWT id_token
        // directly - IAuthenticationResult itself has no idToken accessor, and the
        // claims map (IClaimable.getClaims()) holds *decoded* claims, not the raw JWT
        // under an "id_token" key.
        json.put("idToken", result.account.idToken ?: "")
        json.put("expiresOn", result.expiresOn.time)
        json.put("accountId", result.account.id)
        json.put("scopes", JSArray(result.scope.toList()))
        return json
    }

    private inline fun <reified T> JSArray.toList(): List<T> {
        val out = mutableListOf<T>()
        for (i in 0 until this.length()) {
            out.add(this.get(i) as T)
        }
        return out
    }

    // account.claims (IClaimable.getClaims()) is a Map<String, ?> decoded from JSON:
    // non-string claims (amr, groups, roles, nested objects) come through as List/Map,
    // not String - a plain toString() would mangle them instead of preserving their
    // shape as real JSON arrays/objects for the JS side.
    private fun claimValueToJson(value: Any?): Any {
        return when (value) {
            null -> JSONObject.NULL
            is String, is Boolean, is Int, is Long, is Double, is Float -> value
            is Map<*, *> -> {
                val obj = JSObject()
                value.forEach { (k, v) -> obj.put(k.toString(), claimValueToJson(v)) }
                obj
            }
            is Collection<*> -> {
                val arr = JSArray()
                value.forEach { arr.put(claimValueToJson(it)) }
                arr
            }
            is Array<*> -> {
                val arr = JSArray()
                value.forEach { arr.put(claimValueToJson(it)) }
                arr
            }
            else -> value.toString()
        }
    }
}
