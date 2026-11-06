// Classic Bluetooth connections (IOBluetooth) and the default audio route (CoreAudio). Both are broadcast-style
// notifications, so they coexist with every other app watching the same devices.
import CoreAudio
import Foundation
import IOBluetooth

final class Connections: NSObject {
  /// Enriched device info (model, precise batteries) for each connected device.
  var onDevice: (([String: Any]) -> Void)?
  var onDisconnect: (() -> Void)?
  private var connectNotification: IOBluetoothUserNotification?
  /// IOBluetooth reports one connect per profile (A2DP, HFP, AVRCP); report each device once.
  private var connected = Set<String>()

  func start() {
    connectNotification = IOBluetoothDevice.register(forConnectNotifications: self, selector: #selector(connected(_:device:)))
  }

  @objc private func connected(_ notification: IOBluetoothUserNotification, device: IOBluetoothDevice) {
    let address = device.addressString ?? ""
    guard !connected.contains(address) else { return }
    connected.insert(address)
    device.register(forDisconnectNotification: self, selector: #selector(disconnected(_:device:)))
    let name = device.name ?? ""
    emit("connected", ["address": address, "deviceName": name, "headphones": device.deviceClassMajor == 0x04])
    // Product id and battery are not exposed by IOBluetooth; system_profiler reads them from bluetoothd (~0.1 s).
    DispatchQueue.global(qos: .userInitiated).async {
      guard let info = profilerDevice(address: address) else { return }
      var fields: [String: Any] = ["address": address, "deviceName": name]
      if let pid = info["device_productID"] as? String, let id = UInt16(pid.dropFirst(2), radix: 16) { fields.merge(modelFields(id)) { $1 } }
      for (key, field) in [("device_batteryLevelLeft", "left"), ("device_batteryLevelRight", "right"), ("device_batteryLevelCase", "case")] {
        if let text = info[key] as? String, let value = Int(text.dropLast()) { fields[field] = value }
      }
      emit("device", fields)
      DispatchQueue.main.async { self.onDevice?(fields) }
    }
  }

  @objc private func disconnected(_ notification: IOBluetoothUserNotification, device: IOBluetoothDevice) {
    notification.unregister()
    guard connected.remove(device.addressString ?? "") != nil else { return }
    emit("disconnected", ["address": device.addressString ?? "", "deviceName": device.name ?? ""])
    onDisconnect?()
  }
}

/// Read one device's properties from `system_profiler SPBluetoothDataType -json`.
func profilerDevice(address: String) -> [String: Any]? {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/system_profiler")
  process.arguments = ["SPBluetoothDataType", "-json"]
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = FileHandle.nullDevice
  guard (try? process.run()) != nil else { return nil }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let controllers = root["SPBluetoothDataType"] as? [[String: Any]] else { return nil }
  let wanted = address.uppercased().replacingOccurrences(of: "-", with: ":")
  for controller in controllers {
    for group in ["device_connected", "device_not_connected"] {
      for entry in controller[group] as? [[String: Any]] ?? [] {
        for (_, value) in entry {
          if let info = value as? [String: Any], (info["device_address"] as? String)?.uppercased() == wanted { return info }
        }
      }
    }
  }
  return nil
}

// MARK: - Audio route

func audioProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                      scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ initial: T) -> T? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func deviceName(_ id: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr, let value = name?.takeRetainedValue() else { return "" }
  return value as String
}

func isBluetooth(_ id: AudioDeviceID) -> Bool {
  let transport: UInt32? = audioProperty(id, kAudioDevicePropertyTransportType, UInt32(0))
  return transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
}

final class AudioRoute {
  private(set) var input: AudioDeviceID = 0
  private(set) var output: AudioDeviceID = 0
  var onChange: (() -> Void)?

  func start() {
    for selector in [kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice] {
      var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main) { [weak self] _, _ in self?.refresh() }
    }
    refresh()
  }

  /// Bluetooth headphones are the current output; this is how "wearing AirPods" shows up once they auto-connect.
  var headphonesOutput: Bool { output != 0 && isBluetooth(output) }

  private func refresh() {
    let system = AudioObjectID(kAudioObjectSystemObject)
    input = audioProperty(system, kAudioHardwarePropertyDefaultInputDevice, AudioDeviceID(0)) ?? 0
    output = audioProperty(system, kAudioHardwarePropertyDefaultOutputDevice, AudioDeviceID(0)) ?? 0
    emit("route", ["input": deviceName(input), "output": deviceName(output),
                   "inputBluetooth": isBluetooth(input), "outputBluetooth": isBluetooth(output)])
    onChange?()
  }
}

/// Product ids of Apple audio devices paired with this Mac.
func pairedAppleModels() -> Set<UInt16> {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/system_profiler")
  process.arguments = ["SPBluetoothDataType", "-json"]
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = FileHandle.nullDevice
  guard (try? process.run()) != nil else { return [] }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let controllers = root["SPBluetoothDataType"] as? [[String: Any]] else { return [] }
  var models = Set<UInt16>()
  for controller in controllers {
    for group in ["device_connected", "device_not_connected"] {
      for entry in controller[group] as? [[String: Any]] ?? [] {
        for (_, value) in entry {
          guard let info = value as? [String: Any], (info["device_vendorID"] as? String) == "0x004C",
                let pid = info["device_productID"] as? String, let id = UInt16(pid.dropFirst(2), radix: 16) else { continue }
          models.insert(id)
        }
      }
    }
  }
  return models
}

// MARK: - Connect to this Mac

/// A paired Apple audio device that can be pulled to this Mac.
struct PairedPods {
  let address: String
  let name: String
  let productId: UInt16
  let lastUsed: Date
  let connected: Bool
  /// Percent levels reported by bluetoothd while connected.
  let left: Int?
  let right: Int?
  let caseLevel: Int?

  var fields: [String: Any] {
    var out = modelFields(productId)
    out.merge(["address": address, "deviceName": name, "connected": connected,
               "left": left ?? NSNull(), "right": right ?? NSNull(), "case": caseLevel ?? NSNull()]) { $1 }
    return out
  }
}

/// Paired AirPods with their product ids (system_profiler) and last use (IOBluetooth), most recent first.
func pairedPods() -> [PairedPods] {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/system_profiler")
  process.arguments = ["SPBluetoothDataType", "-json"]
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = FileHandle.nullDevice
  guard (try? process.run()) != nil else { return [] }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let controllers = root["SPBluetoothDataType"] as? [[String: Any]] else { return [] }
  var found: [PairedPods] = []
  for controller in controllers {
    for group in ["device_connected", "device_not_connected"] {
      for entry in controller[group] as? [[String: Any]] ?? [] {
        for (name, value) in entry {
          guard let info = value as? [String: Any], (info["device_vendorID"] as? String) == "0x004C",
                let pid = info["device_productID"] as? String, let id = UInt16(pid.dropFirst(2), radix: 16),
                let address = info["device_address"] as? String else { continue }
          let device = IOBluetoothDevice(addressString: address)
          func level(_ key: String) -> Int? { (info[key] as? String).flatMap { Int($0.dropLast()) } }
          found.append(PairedPods(address: address, name: name, productId: id, lastUsed: device?.recentAccessDate() ?? .distantPast,
                                  connected: group == "device_connected", left: level("device_batteryLevelLeft"),
                                  right: level("device_batteryLevelRight"), caseLevel: level("device_batteryLevelCase")))
        }
      }
    }
  }
  return found.sorted { $0.lastUsed > $1.lastUsed }
}

extension Connections {
  /// Whether any device of this model is connected to this Mac right now.
  func isConnected(productId: UInt16, paired: [PairedPods]) -> Bool {
    paired.contains { $0.productId == productId && IOBluetoothDevice(addressString: $0.address)?.isConnected() == true }
  }

  /// Connect one paired device by address.
  /// - Returns: whether it is connected afterwards.
  func connect(address: String) -> Bool {
    guard let device = IOBluetoothDevice(addressString: address) else { return false }
    // Page timeout in 0.625 ms slots: 8000 ≈ 5 s, so an absent pair fails quickly instead of hanging.
    return device.isConnected() || device.openConnection(nil, withPageTimeout: 8000, authenticationRequired: false) == kIOReturnSuccess
  }

  /// Open a connection to the most recently used paired device of this model, falling back to older ones.
  /// - Returns: the connected device's name, or nil when none could be reached.
  func connect(productId: UInt16, paired: [PairedPods]) -> String? {
    for candidate in paired where candidate.productId == productId {
      guard let device = IOBluetoothDevice(addressString: candidate.address) else { continue }
      if device.isConnected() { return candidate.name }
      if device.openConnection(nil, withPageTimeout: 8000, authenticationRequired: false) == kIOReturnSuccess { return candidate.name }
    }
    return nil
  }
}

// MARK: - Headset microphone

/// Input devices carried over Bluetooth (the AirPods microphone appears here once connected).
func bluetoothInputDevices() -> [(id: AudioDeviceID, name: String)] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.filter { id in
    guard isBluetooth(id) else { return false }
    var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var streamSize: UInt32 = 0
    return AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr && streamSize > 0
  }.map { ($0, deviceName($0)) }
}

/// The connected AirPods' microphone; never the built-in or another wired microphone.
/// - Parameter names: names of connected paired AirPods, preferred in order.
func headsetMicrophone(names: [String]) -> AudioDeviceID? {
  let inputs = bluetoothInputDevices()
  for name in names { if let hit = inputs.first(where: { $0.name == name }) { return hit.id } }
  return inputs.first(where: { isHeadphones($0.name) })?.id
}

func isHeadphones(_ name: String) -> Bool {
  name.range(of: "airpods|耳机|headphone|buds|beats", options: [.regularExpression, .caseInsensitive]) != nil
}
