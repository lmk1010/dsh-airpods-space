// Who else competes for the headphone press: event taps that can swallow media keys, apps playing audio (they take
// Now Playing), apps capturing the mic (they take the mute gesture), and apps that keep re-claiming Now Playing with
// short silent blips. Uses public APIs only: CGGetEventTapList and CoreAudio process objects (macOS 14.4+).
import AppKit
import CoreAudio
import CoreGraphics
import Foundation

struct AudioProcess: Hashable {
  let pid: pid_t
  let bundle: String
  let output: Bool
  let input: Bool
}

/// The app a process belongs to: helpers such as "Google Chrome Helper (Aperitif)" live inside the outermost .app.
func appInfo(_ pid: pid_t, bundle: String = "") -> [String: Any] {
  var buffer = [CChar](repeating: 0, count: 4096)
  if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0, let range = String(cString: buffer).range(of: ".app/") {
    let path = String(String(cString: buffer)[..<range.lowerBound]) + ".app"
    let outer = Bundle(path: path)
    let name = FileManager.default.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")
    return ["pid": Int(pid), "app": name, "bundle": outer?.bundleIdentifier ?? bundle]
  }
  let app = NSRunningApplication(processIdentifier: pid)
  return ["pid": Int(pid), "app": app?.localizedName ?? (bundle.isEmpty ? "pid \(pid)" : bundle),
          "bundle": app?.bundleIdentifier ?? bundle]
}

func audioProcesses() -> [AudioProcess] {
  guard #available(macOS 14.4, *) else { return [] }
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
                                           mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
  var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects) == noErr else { return [] }
  return objects.compactMap { object in
    guard let pid: pid_t = audioProperty(object, kAudioProcessPropertyPID, pid_t(0)) else { return nil }
    let output: UInt32 = audioProperty(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0
    let input: UInt32 = audioProperty(object, kAudioProcessPropertyIsRunningInput, UInt32(0)) ?? 0
    var bundleAddress = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var bundle: Unmanaged<CFString>?
    var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let id = AudioObjectGetPropertyData(object, &bundleAddress, 0, nil, &bundleSize, &bundle) == noErr ? (bundle?.takeRetainedValue() as String? ?? "") : ""
    return AudioProcess(pid: pid, bundle: id, output: output != 0, input: input != 0)
  }
}

/// Active event taps from other processes that see system-defined (media key) events and may consume them.
func mediaKeyInterceptors() -> [[String: Any]] {
  var count: UInt32 = 0
  CGGetEventTapList(0, nil, &count)
  guard count > 0 else { return [] }
  var taps = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(count))
  CGGetEventTapList(count, &taps, &count)
  let me = getpid()
  return taps.filter { $0.enabled && $0.tappingProcess != me && ($0.eventsOfInterest & (1 << 14)) != 0 && $0.options != .listenOnly }
    .map { appInfo($0.tappingProcess) }
}

/// Polls audio processes; reports who took Now Playing, who holds the mic, and repeat silent re-claimers.
final class ConflictWatch {
  private let me = getpid()
  private var outputs = Set<pid_t>()
  private var lastOtherOutput = Date()
  private var bursts: [pid_t: [Date]] = [:]   // output start times
  private var burstStart: [pid_t: Date] = [:]
  private var reported = Set<String>()
  var onOtherStartedOutput: (([String: Any]) -> Void)?

  /// Seconds since any other app produced audio.
  var otherAudioIdleSeconds: Double { outputs.isEmpty ? Date().timeIntervalSince(lastOtherOutput) : 0 }

  func start() {
    // Streams open before the helper started took nothing from it; only later starts can move Now Playing.
    outputs = Set(audioProcesses().filter { $0.pid != me && $0.output && !isSystemAudio($0.bundle) && !isSystemProcess($0.pid) }.map(\.pid))
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
    snapshot()
  }

  func snapshot() {
    let processes = audioProcesses().filter { $0.pid != me }
    emit("conflicts", [
      "interceptors": mediaKeyInterceptors(),
      "playing": processes.filter(\.output).map { appInfo($0.pid, bundle: $0.bundle) },
      "recording": processes.filter(\.input).map { appInfo($0.pid, bundle: $0.bundle) },
      "supported": { if #available(macOS 14.4, *) { return true } else { return false } }(),
    ])
  }

  private func poll() {
    let now = Date()
    let current = Set(audioProcesses().filter { $0.pid != me && $0.output && !isSystemAudio($0.bundle) && !isSystemProcess($0.pid) }.map(\.pid))
    for pid in current.subtracting(outputs) {
      burstStart[pid] = now
      onOtherStartedOutput?(appInfo(pid))
    }
    for pid in outputs.subtracting(current) {
      // A short burst that repeats is a silent Now Playing re-claim loop.
      if let started = burstStart.removeValue(forKey: pid), now.timeIntervalSince(started) < 1.5 {
        let recent = (bursts[pid] ?? []).filter { now.timeIntervalSince($0) < 60 } + [now]
        bursts[pid] = recent
        let info = appInfo(pid)
        let key = "reclaimer:\(info["bundle"] ?? pid)"
        if recent.count >= 3 && !reported.contains(key) {
          reported.insert(key)
          emit("conflict", ["kind": "now-playing-reclaimer", "app": info, "bursts": recent.count])
        }
      }
    }
    if !current.isEmpty { lastOtherOutput = now }
    outputs = current
  }

  /// macOS daemons (system sounds, Siri, call services) live under /usr, /System or /Library/Apple and never take presses.
  private func isSystemProcess(_ pid: pid_t) -> Bool {
    var buffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
    let path = String(cString: buffer)
    return path.hasPrefix("/usr/") || path.hasPrefix("/System/") || path.hasPrefix("/Library/Apple/")
  }

  private func isSystemAudio(_ bundle: String) -> Bool {
    bundle.hasPrefix("com.apple.") && !["com.apple.Music", "com.apple.TV", "com.apple.podcasts", "com.apple.Safari", "com.apple.QuickTimePlayerX"].contains(bundle)
  }
}
