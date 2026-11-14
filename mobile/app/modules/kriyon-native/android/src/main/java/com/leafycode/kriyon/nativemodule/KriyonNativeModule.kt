// The phone app's way into Kriyon's Rust library (crates/kriyon-mobile) on
// Android: a pass-through with no logic, call for call the Swift module's.
// Rust decides; this hands calls to it and its news to JavaScript as events.

package com.leafycode.kriyon.nativemodule

import android.os.Build
import android.view.WindowManager
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.lang.ref.WeakReference
import uniffi.kriyon_mobile.EntriesListener
import uniffi.kriyon_mobile.HostListener
import uniffi.kriyon_mobile.MobileDevice
import uniffi.kriyon_mobile.MobileException
import uniffi.kriyon_mobile.Pairing
import uniffi.kriyon_mobile.ScreenListener

/** Rust's news about a computer, as an event. */
private class HostEvents(module: KriyonNativeModule) : HostListener {
  private val module = WeakReference(module)

  override fun hostChanged(summary: String) {
    module.get()?.sendEvent("onHostChanged", objectOf(summary))
  }
}

/** One open session's screen, as events. */
private class ScreenEvents(
  module: KriyonNativeModule,
  private val hostId: String,
  private val sessionId: String,
) : ScreenListener {
  private val module = WeakReference(module)

  override fun frame(frame: ByteArray) {
    module.get()?.sendEvent(
      "onScreenFrame",
      mapOf("hostId" to hostId, "sessionId" to sessionId, "frame" to frame),
    )
  }
}

/** One open session's readable view, as events: Rust's summary, whole. */
private class EntriesEvents(
  module: KriyonNativeModule,
  private val hostId: String,
  private val sessionId: String,
) : EntriesListener {
  private val module = WeakReference(module)

  override fun entriesChanged(summary: String) {
    module.get()?.sendEvent(
      "onEntriesChanged",
      mapOf("hostId" to hostId, "sessionId" to sessionId, "summary" to parsed(summary)),
    )
  }
}

/**
 * A Rust error as a JavaScript one, its kind as the code (`NotConnected`,
 * `NoControl`, …), so the screens never read the wording. The words are
 * Rust's own (its Display, exported through UniFFI).
 */
private inline fun <T> rust(call: () -> T): T =
  try {
    call()
  } catch (error: MobileException) {
    throw CodedException(error.javaClass.simpleName, error.toString(), error)
  }

class KriyonNativeModule : Module() {
  /** `device` and `pairing` are reached from several threads: always under this lock. */
  private val lock = Any()
  private var device: MobileDevice? = null
  private var pairing: Pairing? = null

  private fun started(): MobileDevice =
    synchronized(lock) { device }
      ?: throw CodedException("NotStarted", "start the device first", null)

  /** Where the store keeps its sealed values: never backed up or moved to another phone. */
  private fun storeDir(): File {
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    return File(context.noBackupFilesDir, "kriyon")
  }

  override fun definition() = ModuleDefinition {
    Name("KriyonNative")

    Events("onEntriesChanged", "onHostChanged", "onScreenFrame")

    // Once per app run: a later call returns the same device and its name
    // stays the first one given.
    AsyncFunction("start") { deviceName: String ->
      synchronized(lock) {
        device?.let { return@AsyncFunction it.id() }
        val sealer = KeystoreSealer()
        val store = SealedFileStore(storeDir(), sealer)
        // Values sealed by a key the Keystore no longer has can't be opened
        // again: start afresh rather than fail every launch.
        if (!sealer.hasKey()) store.clear()
        val started = rust { MobileDevice.start(store, HostEvents(this@KriyonNativeModule), deviceName) }
        device = started
        started.id()
      }
    }

    AsyncFunction("hosts") {
      parsed(rust { started().hosts() })
    }

    AsyncFunction("pair") Coroutine { inviteText: String ->
      val next = rust { started().pair(inviteText) }
      synchronized(lock) {
        pairing?.cancel()
        pairing = next
      }
      // The code step: {code, role, expiresAtMs}, as JSON.
      next.offer()
    }

    AsyncFunction("finishPairing") Coroutine { ->
      val current = synchronized(lock) { pairing }
        ?: throw CodedException("NoPairing", "no pairing is in progress", null)
      try {
        parsed(rust { current.finish() })
      } finally {
        // Only this pairing: a newer one started meanwhile stays.
        synchronized(lock) {
          if (pairing === current) pairing = null
        }
      }
    }

    AsyncFunction("cancelPairing") {
      synchronized(lock) {
        pairing?.cancel()
        pairing = null
      }
    }

    AsyncFunction("forget") Coroutine { hostId: String ->
      rust { started().forget(hostId) }
    }

    AsyncFunction("setPushToken") Coroutine { token: String, platform: String ->
      rust { started().setPushToken(token, platform) }
    }

    AsyncFunction("relay") Coroutine { ->
      parsed(started().relay())
    }

    AsyncFunction("relaySignIn") Coroutine { ->
      parsed(rust { started().relaySignIn() })
    }

    AsyncFunction("relayWaitSignIn") Coroutine { ->
      started().relayWaitSignIn()
    }

    AsyncFunction("relayCancelSignIn") Coroutine { ->
      started().relayCancelSignIn()
    }

    AsyncFunction("relaySignOut") Coroutine { ->
      parsed(rust { started().relaySignOut() })
    }

    AsyncFunction("relaySetOn") Coroutine { on: Boolean ->
      parsed(rust { started().relaySetOn(on) })
    }

    AsyncFunction("relayAccount") Coroutine { ->
      parsed(rust { started().relayAccount() })
    }

    // Firebase starts from the resources its google-services.json makes:
    // a build without the file has none, and no push token can come.
    Function("hasPushService") {
      val context = appContext.reactContext ?: return@Function false
      @Suppress("DiscouragedApi")
      context.resources.getIdentifier("google_app_id", "string", context.packageName) != 0
    }

    Function("wake") {
      started().wake()
    }

    // One call shows a session as the person wants it: open (its screen
    // and its entries each on or off) or closed. Rust takes only a view
    // newer than the last (`seq`), so calls may arrive in any order.
    AsyncFunction("setView") Coroutine {
      hostId: String, sessionId: String, seq: Double, open: Boolean, screen: String, entries: Boolean ->
      // "fresh": a new screen, to these events; "kept" or "off": none here.
      val screenEvents = if (screen == "fresh") ScreenEvents(this@KriyonNativeModule, hostId, sessionId) else null
      val entriesEvents = if (entries) EntriesEvents(this@KriyonNativeModule, hostId, sessionId) else null
      rust {
        started().setView(hostId, sessionId, seq.toLong().toULong(), open, screen, screenEvents, entriesEvents)
      }
    }

    AsyncFunction("startSession") Coroutine { hostId: String, projectId: String, title: String? ->
      rust { started().startSession(hostId, projectId, title) }
    }

    AsyncFunction("takeControl") Coroutine { hostId: String, sessionId: String ->
      rust { started().takeControl(hostId, sessionId) }
    }

    AsyncFunction("giveBack") Coroutine { hostId: String, sessionId: String ->
      rust { started().giveBack(hostId, sessionId) }
    }

    // A message to Claude, as the desktop's composer sends it: the computer
    // types it, then Enter. Resolves once it reached the terminal.
    AsyncFunction("compose") Coroutine { hostId: String, sessionId: String, text: String ->
      rust { started().compose(hostId, sessionId, text) }
    }

    AsyncFunction("setAlerts") Coroutine { on: Boolean ->
      rust { started().setAlerts(on) }
    }

    Function("alertsOn") {
      synchronized(lock) { device }?.alertsOn() ?: true
    }

    // The app lock as the person set it: {on, afterS}, `on` null until chosen.
    Function("appLock") {
      synchronized(lock) { device }?.appLockJson() ?: """{"on":null,"afterS":300}"""
    }

    AsyncFunction("setAppLock") Coroutine { on: Boolean?, afterS: Int ->
      rust { started().setAppLock(on, afterS.toUInt()) }
    }

    // With the lock on, the app switcher shows no picture of the app: from
    // Android 13 the system's own switch; before it, a secure window (which
    // also keeps screenshots out).
    AsyncFunction("setPrivateInSwitcher") { on: Boolean ->
      val activity = appContext.currentActivity ?: return@AsyncFunction
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        activity.setRecentsScreenshotEnabled(!on)
      } else if (on) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("input") Coroutine { hostId: String, sessionId: String, bytes: ByteArray ->
      rust { started().input(hostId, sessionId, bytes) }
    }
  }
}
