// The phone app's way into Kriyon's Rust library (crates/kriyon-mobile):
// a pass-through with no logic. Rust decides; this hands calls to it and
// its news to JavaScript as events.

import ExpoModulesCore
import Security

/// The phone's store for the Rust library: the iPhone keychain, the same
/// store expo-secure-store uses, readable only while the phone is unlocked
/// and never leaving it (the spec's choice, as the desktop's device key).
/// Nothing reads it while the phone is locked: an alert is shown by iOS,
/// and links come up when the app is in front. A start the system made
/// while the phone was locked is tried again when the app comes to the front.
final class KeychainStore: PhoneStore, @unchecked Sendable {
  private let service = "com.leafycode.kriyon.mobile"

  private func query(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  func read(key: String) throws -> Data? {
    var query = query(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else {
      throw StoreError.Failed(reason: "keychain read failed (\(status))")
    }
    return found as? Data
  }

  func write(key: String, value: Data) throws {
    let update = [kSecValueData as String: value]
    var status = SecItemUpdate(query(key) as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var add = query(key)
      add[kSecValueData as String] = value
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw StoreError.Failed(reason: "keychain write failed (\(status))")
    }
  }

  func remove(key: String) throws {
    let status = SecItemDelete(query(key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw StoreError.Failed(reason: "keychain remove failed (\(status))")
    }
  }
}

/// Rust's news about a computer, as an event.
final class HostEvents: HostListener, @unchecked Sendable {
  weak var module: KriyonNativeModule?

  func hostChanged(summary: String) {
    module?.sendEvent("onHostChanged", object(summary))
  }
}

/// One open session's screen, as events.
final class ScreenEvents: ScreenListener, @unchecked Sendable {
  weak var module: KriyonNativeModule?
  let hostId: String
  let sessionId: String

  init(module: KriyonNativeModule, hostId: String, sessionId: String) {
    self.module = module
    self.hostId = hostId
    self.sessionId = sessionId
  }

  func frame(frame: Data) {
    module?.sendEvent("onScreenFrame", [
      "hostId": hostId,
      "sessionId": sessionId,
      "frame": frame,
    ])
  }
}

/// One open session's readable view, as events: Rust's summary, whole.
final class EntriesEvents: EntriesListener, @unchecked Sendable {
  weak var module: KriyonNativeModule?
  let hostId: String
  let sessionId: String

  init(module: KriyonNativeModule, hostId: String, sessionId: String) {
    self.module = module
    self.hostId = hostId
    self.sessionId = sessionId
  }

  func entriesChanged(summary: String) {
    module?.sendEvent("onEntriesChanged", [
      "hostId": hostId,
      "sessionId": sessionId,
      "summary": parsed(summary),
    ])
  }
}

/// Rust's JSON as a JavaScript value, as it is: the module adds nothing, so
/// a Kotlin module reads the same JSON.
func parsed(_ text: String) -> Any {
  (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]))
    ?? NSNull()
}

/// Rust's JSON object as an event's body.
func object(_ text: String) -> [String: Any] {
  parsed(text) as? [String: Any] ?? [:]
}

/// A Rust error as a JavaScript one, its kind as the code (`NotConnected`,
/// `NoControl`, …), so the screens never read the wording.
func rust<T>(_ call: () async throws -> T) async throws -> T {
  do {
    return try await call()
  } catch let error as MobileError {
    // The words are Rust's own (its Display, exported through UniFFI).
    throw Exception(name: "MobileError", description: error.description, code: kind(error))
  }
}

/// `rust`, for a call that doesn't wait (`start`, under the module's lock).
func rustNow<T>(_ call: () throws -> T) throws -> T {
  do {
    return try call()
  } catch let error as MobileError {
    throw Exception(name: "MobileError", description: error.description, code: kind(error))
  }
}

/// A Rust error's kind, the code JavaScript tells errors apart by.
func kind(_ error: MobileError) -> String {
  switch error {
  case .Store: return "Store"
  case .Invalid: return "Invalid"
  case .Link: return "Link"
  case .Refused: return "Refused"
  case .NotConnected: return "NotConnected"
  case .NotOpen: return "NotOpen"
  case .NoControl: return "NoControl"
  case .NoScreen: return "NoScreen"
  }
}

public final class KriyonNativeModule: Module {
  /// `device` and `pairing` are reached from the JavaScript thread and from
  /// async calls on other threads: always under this lock.
  private let lock = NSLock()
  private var device: MobileDevice?
  private var pairing: Pairing?
  private let events = HostEvents()

  private func started() throws -> MobileDevice {
    lock.lock()
    defer { lock.unlock() }
    guard let device else {
      throw Exception(name: "NotStarted", description: "start the device first", code: "NotStarted")
    }
    return device
  }

  public func definition() -> ModuleDefinition {
    Name("KriyonNative")

    Events("onEntriesChanged", "onHostChanged", "onScreenFrame")

    // Once per app run: a later call returns the same device and its name
    // stays the first one given.
    AsyncFunction("start") { (deviceName: String) -> String in
      self.lock.lock()
      defer { self.lock.unlock() }
      if let device = self.device { return device.id() }
      self.events.module = self
      let device = try rustNow {
        try MobileDevice.start(
          store: KeychainStore(), listener: self.events, deviceName: deviceName)
      }
      self.device = device
      return device.id()
    }

    AsyncFunction("hosts") { () -> Any in
      parsed(try await rust { try self.started().hosts() })
    }

    AsyncFunction("pair") { (inviteText: String) -> String in
      let pairing = try await rust { try await self.started().pair(inviteText: inviteText) }
      self.lock.lock()
      self.pairing?.cancel()
      self.pairing = pairing
      self.lock.unlock()
      return pairing.code()
    }

    AsyncFunction("finishPairing") { () -> Any in
      self.lock.lock()
      let pairing = self.pairing
      self.lock.unlock()
      guard let pairing else {
        throw Exception(name: "NoPairing", description: "no pairing is in progress", code: "NoPairing")
      }
      defer {
        // Only this pairing: a newer one started meanwhile stays.
        self.lock.lock()
        if self.pairing === pairing { self.pairing = nil }
        self.lock.unlock()
      }
      return parsed(try await rust { try await pairing.finish() })
    }

    AsyncFunction("cancelPairing") {
      self.lock.lock()
      self.pairing?.cancel()
      self.pairing = nil
      self.lock.unlock()
    }

    AsyncFunction("forget") { (hostId: String) in
      try await rust { try await self.started().forget(hostId: hostId) }
    }

    AsyncFunction("setPushToken") { (token: String, platform: String) -> Bool in
      try await rust { try await self.started().setPushToken(token: token, platform: platform) }
    }

    AsyncFunction("relay") { () -> Any in
      parsed(try await self.started().relay())
    }

    AsyncFunction("relaySignIn") { () -> Any in
      parsed(try await rust { try await self.started().relaySignIn() })
    }

    AsyncFunction("relayWaitSignIn") { () -> Bool in
      try await self.started().relayWaitSignIn()
    }

    AsyncFunction("relayCancelSignIn") {
      try await self.started().relayCancelSignIn()
    }

    AsyncFunction("relaySignOut") { () -> Any in
      parsed(try await rust { try await self.started().relaySignOut() })
    }

    AsyncFunction("relaySetOn") { (on: Bool) -> Any in
      parsed(try await rust { try await self.started().relaySetOn(on: on) })
    }

    AsyncFunction("relayAccount") { () -> Any in
      parsed(try await rust { try await self.started().relayAccount() })
    }

    // Apple's push service is the system's: there is nothing to set up.
    Function("hasPushService") { true }

    Function("wake") {
      try self.started().wake()
    }

    // Opened for its entries only: its screen comes with setScreen.
    AsyncFunction("openSession") { (hostId: String, sessionId: String) in
      try await rust {
        try await self.started().openSession(hostId: hostId, sessionId: sessionId, listener: nil)
      }
    }

    AsyncFunction("setScreen") { (hostId: String, sessionId: String, on: Bool) in
      let screen = on ? ScreenEvents(module: self, hostId: hostId, sessionId: sessionId) : nil
      try await rust {
        try await self.started().setScreen(hostId: hostId, sessionId: sessionId, listener: screen)
      }
    }

    AsyncFunction("readEntries") { (hostId: String, sessionId: String) in
      let entries = EntriesEvents(module: self, hostId: hostId, sessionId: sessionId)
      try await rust {
        try await self.started().readEntries(hostId: hostId, sessionId: sessionId, listener: entries)
      }
    }

    AsyncFunction("stopEntries") { (hostId: String, sessionId: String) in
      try await rust { try await self.started().stopEntries(hostId: hostId, sessionId: sessionId) }
    }

    AsyncFunction("closeSession") { (hostId: String, sessionId: String) in
      try await rust { try await self.started().closeSession(hostId: hostId, sessionId: sessionId) }
    }

    AsyncFunction("startSession") { (hostId: String, projectId: String, title: String?) -> String in
      try await rust {
        try await self.started().startSession(hostId: hostId, projectId: projectId, title: title)
      }
    }

    AsyncFunction("takeControl") { (hostId: String, sessionId: String) in
      try await rust { try await self.started().takeControl(hostId: hostId, sessionId: sessionId) }
    }

    AsyncFunction("input") { (hostId: String, sessionId: String, bytes: Data) in
      try await rust {
        try await self.started().input(hostId: hostId, sessionId: sessionId, bytes: bytes)
      }
    }
  }
}
