// The phone app's way into Kriyon's Rust library (crates/kriyon-mobile):
// a pass-through with no logic. Rust decides; this hands calls to it and
// its news to JavaScript as events.

import ExpoModulesCore
import Security

/// The phone's store for the Rust library: the iPhone keychain, the same
/// store expo-secure-store uses, readable after the first unlock and never
/// leaving this device.
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
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
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

  func hostChanged(state: HostState) {
    module?.sendEvent("onHostChanged", Records.host(state))
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

/// Rust's records as JavaScript objects, field for field; an absent value
/// is JavaScript's null.
enum Records {
  static func orNull(_ value: Any?) -> Any {
    value ?? NSNull()
  }

  static func pairedHost(_ host: PairedHost) -> [String: Any] {
    [
      "hostId": host.hostId,
      "name": host.name,
      "addrs": host.addrs,
      "relayUrl": orNull(host.relayUrl),
      "pairedAtMs": Double(host.pairedAtMs),
    ]
  }

  static func host(_ state: HostState) -> [String: Any] {
    [
      "hostId": state.hostId,
      "link": "\(state.link)",
      "hostName": orNull(state.hostName),
      "role": orNull(state.role),
      "refused": orNull(state.refused),
      "sessions": state.sessions.map { session -> [String: Any] in
        [
          "id": session.id,
          "title": session.title,
          "projectId": session.projectId,
          "status": session.status,
          "standing": session.standing,
          "needsYou": session.needsYou,
          "dialogOpen": session.dialogOpen,
          "lastChangeMs": Double(session.lastChangeMs),
          "typing": orNull(session.typing.map { "\($0)" }),
        ]
      },
    ]
  }
}

/// A Rust error as a JavaScript one, its kind as the code (`NotConnected`,
/// `NoControl`, …), so the screens never read the wording.
func rust<T>(_ call: () async throws -> T) async throws -> T {
  do {
    return try await call()
  } catch let error as MobileError {
    let kind = "\(error)".split(separator: "(").first.map(String.init) ?? "MobileError"
    throw Exception(name: "MobileError", description: error.localizedDescription, code: kind)
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

    Events("onHostChanged", "onScreenFrame")

    // Once per app run: a later call returns the same device and its name
    // stays the first one given.
    AsyncFunction("start") { (deviceName: String) -> String in
      self.lock.lock()
      defer { self.lock.unlock() }
      if let device = self.device { return device.id() }
      self.events.module = self
      let device = try MobileDevice.start(
        store: KeychainStore(), listener: self.events, deviceName: deviceName)
      self.device = device
      return device.id()
    }

    AsyncFunction("hosts") { () -> [[String: Any]] in
      try await rust { try self.started().hosts().map(Records.pairedHost) }
    }

    AsyncFunction("pair") { (inviteText: String) -> String in
      let pairing = try await rust { try await self.started().pair(inviteText: inviteText) }
      self.lock.lock()
      self.pairing?.cancel()
      self.pairing = pairing
      self.lock.unlock()
      return pairing.code()
    }

    AsyncFunction("finishPairing") { () -> [String: Any] in
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
      return Records.pairedHost(try await rust { try await pairing.finish() })
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

    Function("wake") {
      try self.started().wake()
    }

    AsyncFunction("openSession") { (hostId: String, sessionId: String) in
      let screen = ScreenEvents(module: self, hostId: hostId, sessionId: sessionId)
      try await rust {
        try await self.started().openSession(hostId: hostId, sessionId: sessionId, listener: screen)
      }
    }

    AsyncFunction("closeSession") { (hostId: String, sessionId: String) in
      try await rust { try await self.started().closeSession(hostId: hostId, sessionId: sessionId) }
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
