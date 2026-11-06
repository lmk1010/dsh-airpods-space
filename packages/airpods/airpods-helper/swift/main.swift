// dsh-airpods-helper: AirPods sensing and press-to-talk for DeepSeek Harness. Spawned by the Host plugin; exits on stdin EOF.
import AppKit
import AVFoundation
import CoreBluetooth
import Foundation

disclaimResponsibility()

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
emit("hello", ["version": protocolVersion, "pid": Int(getpid()), "macos": ProcessInfo.processInfo.operatingSystemVersionString])

let route = AudioRoute()
let voice = Voice(route: route)
let conflicts = ConflictWatch()
let proximity = Proximity()
let connections = Connections()
let popup = Popup()
let reader = Reader()
let head = HeadGestures()
let guide = Guide()
let capsule = CapsuleWindow()
var guideAuto = false
voice.reader = reader


var paired: [PairedPods] = []
func refreshPaired() {
  DispatchQueue.global(qos: .utility).async {
    let list = pairedPods()
    DispatchQueue.main.async {
      paired = list
      emit("devices", ["devices": list.map(\.fields)])
    }
  }
}
// The headset dropped mid-turn: finish the turn so what was already recognized is sent, then release the mic.
connections.onDisconnect = {
  refreshPaired()
  voice.endTalk(reason: "disconnected")
  voice.closeMic()
  reader.stop()
}
// IOBluetooth blocks the calling thread until Bluetooth is authorized, so everything that uses it waits for this.
proximity.onReady = {
  connections.start()
  refreshPaired()
  DispatchQueue.global(qos: .utility).async {
    let models = pairedAppleModels()
    DispatchQueue.main.async { proximity.pairedModels = models; emit("paired", ["models": models.map { String(format: "0x%04X", $0) }.sorted()]) }
  }
}
proximity.onState = { emit("permissions", permissions()) }

/// Product id of the AirPods shown on the card, for the connect button.
var cardProductId: UInt16?

/// After the card opens, offer "Connect to this Mac" when the case's AirPods went to another device.
func offerConnect(_ fields: [String: Any]) {
  guard let text = fields["productId"] as? String, let id = UInt16(text.dropFirst(2), radix: 16) else { return }
  cardProductId = id
  if fields["unpaired"] as? Bool == true {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { if cardProductId == id { popup.setConnect("pair") } }
    return
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
    guard cardProductId == id else { return }
    DispatchQueue.global(qos: .userInitiated).async {
      let connected = connections.isConnected(productId: id, paired: paired)
      let name = paired.first { $0.productId == id }?.name ?? ""
      DispatchQueue.main.async { if !connected && cardProductId == id && !name.isEmpty { popup.setConnect("available", name: name) } }
    }
  }
}

func micStatus() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "granted"
  case .notDetermined: return "prompt"
  default: return "denied"
  }
}
/// Ask through the system dialog, which macOS shows only while the answer is undetermined; never nag afterwards.
func requestMicrophoneIfUndetermined() {
  guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else { return }
  AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { emit("permissions", permissions()) } }
}
popup.onAllow = {
  if micStatus() == "denied" {
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
    return
  }
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    DispatchQueue.main.async {
      popup.permissionAnswered(granted ? "granted" : "denied")
      emit("permissions", permissions())
    }
  }
}
voice.onNeedsMicrophone = { requestMicrophoneIfUndetermined() }
voice.headsetInput = { headsetMicrophone(names: paired.filter(\.connected).map(\.name)) }

popup.onConnect = {
  guard let id = cardProductId else { return }
  DispatchQueue.global(qos: .userInitiated).async {
    let name = connections.connect(productId: id, paired: paired)
    DispatchQueue.main.async {
      popup.setConnect(name == nil ? "failed" : "connected", name: name ?? "")
      emit("connect", ["productId": String(format: "0x%04X", id), "ok": name != nil, "deviceName": name ?? ""])
    }
  }
}

func snapshot(_ fields: [String: Any]) -> PodsSnapshot {
  let charging = fields["charging"] as? [String: Bool] ?? [:]
  return PodsSnapshot(model: fields["model"] as? String ?? "unknown", name: fields["name"] as? String ?? "AirPods",
    left: fields["left"] as? Int, right: fields["right"] as? Int, caseLevel: fields["case"] as? Int,
    chargingLeft: charging["left"] ?? false, chargingRight: charging["right"] ?? false, chargingCase: charging["case"] ?? false,
    gesture: fields["gesture"] as? String ?? "double-tap", caseSide: fields["caseSide"] as? String ?? "both",
    unpaired: fields["unpaired"] as? Bool ?? false)
}

/// Latest in-ear state from adverts.
var podsInEar = (value: false, at: Date.distantPast)

/// Latest precise batteries from system_profiler per product id; BLE adverts only carry 10 % steps.
var precise: [String: (fields: [String: Any], at: Date)] = [:]

func withPrecise(_ fields: [String: Any]) -> [String: Any] {
  guard let id = fields["productId"] as? String, let hit = precise[id], Date().timeIntervalSince(hit.at) < 120 else { return fields }
  var merged = fields
  for key in ["left", "right", "case"] where hit.fields[key] != nil { merged[key] = hit.fields[key] }
  return merged
}

// A paired AirPods connecting usually precedes the first lid advert by ~2 s, so either one opens the card.
let started = Date()
connections.onDevice = { fields in
  // IOBluetooth replays already-connected devices at startup; those are not new connections.
  guard Date().timeIntervalSince(started) > 3 else { return }
  guard let id = fields["productId"] as? String, (fields["model"] as? String) != "unknown" else { return }
  precise[id] = (fields, Date())
  refreshPaired()
  if let card = cardProductId, String(format: "0x%04X", card) == id { popup.setConnect("connected") }
  // Connecting while the buds are already out means they were just put on, not that the lid opened.
  if podsInEar.value && Date().timeIntervalSince(podsInEar.at) < 600 { popup.worn(snapshot(fields)) } else { popup.show(snapshot(fields), key: id) }
  let model = fields["model"] as? String ?? "airpods-2", name = fields["deviceName"] as? String ?? "AirPods"
  // Before setup is completed the setup dialog covers gestures; the floating guide waits.
  DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if guideAuto { guide.show(model: model, name: name, firstTimeOnly: true) } }
}

proximity.onEvent = { raw in
  let fields = withPrecise(raw)
  if let ear = fields["inEar"] as? Bool { podsInEar = (ear, Date()) }
  switch fields["state"] as? String {
  case "open": popup.show(snapshot(fields), key: fields["productId"] as? String ?? ""); offerConnect(fields)
  case "near", "buds": popup.update(snapshot(fields))
  case "closed": popup.lidClosed()
  case "in-ear":
    podsInEar = (true, Date()); voice.lastEarChange = Date()
    reader.resume()
    if micStatus() != "granted" { requestMicrophoneIfUndetermined() }
    // The other bud still sits in an open case: keep the case view, now with one bud.
    if let buds = fields["budsInCase"] as? Int, buds > 0, fields["lidOpen"] as? Bool == true { popup.update(snapshot(fields)) }
    else { popup.worn(snapshot(fields)) }
  case "out-of-ear":
    podsInEar = (false, Date()); voice.lastEarChange = Date(); reader.pause()
    // Taking the AirPod out ends listening at once and closes the microphone; words already typed stay in the draft.
    voice.cancelTurn()
  case "gone": popup.hide(reason: "gone")
  default: break
  }
}


/// DSH (any build) is the frontmost app.
func dshFrontmost() -> Bool {
  NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.hasPrefix("com.deepseek.harness") == true
}
route.onChange = {
  // AirPods became the output (put in ears / connected): be ready for the first press. While the user is in DSH the
  // press belongs to DSH even if another app keeps an audio stream open (a browser tab holds one while silent).
  if route.headphonesOutput && (conflicts.otherAudioIdleSeconds > 2 || dshFrontmost()) { voice.claim(reason: "headphones") }
}
// Coming back to DSH takes the press back from whatever app last played; without a claim macOS sends it to Music.
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in
  if dshFrontmost() && route.headphonesOutput { voice.claim(reason: "focus") }
}
conflicts.onOtherStartedOutput = { info in
  // A stream restarted by our own microphone switch, or any start while the user is in DSH, does not hand the press
  // to that app: claim again instead of reporting a conflict.
  if dshFrontmost() || Date().timeIntervalSince(voice.micChangedAt) < 4 {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { if route.headphonesOutput { voice.claim(reason: "kept") } }
  } else { voice.lostClaim(to: info) }
}
route.start()
conflicts.start()
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in voice.reclaimIfIdle(otherAudioIdleSeconds: conflicts.otherAudioIdleSeconds) }

func permissions() -> [String: Any] {
  let mic: String
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: mic = "granted"
  case .denied, .restricted: mic = "denied"
  default: mic = "prompt"
  }
  let bluetooth: String
  switch CBCentralManager.authorization {
  case .allowedAlways: bluetooth = "granted"
  case .denied, .restricted: bluetooth = "denied"
  default: bluetooth = "prompt"
  }
  return ["microphone": mic, "bluetooth": bluetooth, "speech": AppleRecognizer.status(), "headMotion": head.available]
}

readCommands { command in
  switch command["cmd"] as? String {
  case "press": voice.press(source: command["source"] as? String ?? "host")
  case "end": voice.endTalk(reason: command["reason"] as? String ?? "host")
  case "close-mic": voice.closeMic()
  case "claim": voice.claimEnabled = true; voice.claim(reason: "host")
  case "release": voice.claimEnabled = false; voice.release()
  case "conflicts": conflicts.snapshot()
  case "permissions": emit("permissions", permissions())
  // From inside DSH the user already chose to allow: system dialog while undetermined, Settings once denied.
  case "request-microphone":
    if micStatus() == "denied" { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!) }
    else { requestMicrophoneIfUndetermined() }
  case "permission-demo": popup.showPermission(command["state"] as? String ?? "prompt")
  case "ping": emit("pong")
  case "speak":
    if let text = command["text"] as? String, !text.isEmpty { voice.claim(reason: "reading"); reader.speak(text, rate: Float(command["rate"] as? Double ?? 0.52)) }
  case "stop-speaking": reader.stop()
  case "caption": capsule.update(phase: command["phase"] as? String ?? "listening", text: command["text"] as? String)
  case "caption-hide": capsule.hide()
  case "chime":
    // Task outcome tones are switched on by the Host; previews from settings play regardless.
    earcons.play(Earcon(rawValue: command["name"] as? String ?? "done") ?? .done, force: true)
  case "earcons": earcons.enabled = command["on"] as? Bool ?? true
  case "guide-auto": guideAuto = command["on"] as? Bool ?? false
  case "asr":
    voice.useApple = (command["source"] as? String) == "apple"
    voice.appleLocale = command["locale"] as? String ?? "zh-CN"
    emit("asr", ["phase": "source", "source": voice.useApple ? "apple" : "host",
                 "available": AppleRecognizer.available(locale: voice.appleLocale)])
  case "head": if command["on"] as? Bool == true { head.start() } else { head.stop() }
  case "guide":
    guide.show(model: command["model"] as? String ?? "airpods-2", name: command["name"] as? String ?? "AirPods", firstTimeOnly: false)
  case "devices": if CBCentralManager.authorization == .allowedAlways { refreshPaired() }
  case "open-bluetooth-pairing":
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.BluetoothSettings")!)
  case "open-bluetooth-settings":
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth")!)
  case "connect":
    guard let address = command["address"] as? String else { break }
    // Exactly one result within 8 s, even if the Bluetooth stack never returns.
    var answered = false
    let answer = { (ok: Bool) in
      guard !answered else { return }
      answered = true
      emit("connect", ["address": address, "ok": ok])
      refreshPaired()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { answer(false) }
    DispatchQueue.global(qos: .userInitiated).async {
      let ok = connections.connect(address: address)
      DispatchQueue.main.async { answer(ok) }
    }
  case "open-microphone-settings":
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
  case "popup":
    popup.enabled = command["enabled"] as? Bool ?? popup.enabled
    if command["demo"] as? Bool == true {
      var fields = modelFields(UInt16((command["productId"] as? String ?? "0x200F").dropFirst(2), radix: 16) ?? 0x200F)
      fields.merge(["left": 90, "right": 80, "case": 60, "charging": ["case": true]]) { $1 }
      if command["worn"] as? Bool == true { popup.worn(snapshot(fields)) } else { popup.show(snapshot(fields), key: "demo-\(Date().timeIntervalSince1970)") }
    }
  default: emit("error", ["message": "unknown command", "command": command])
  }
}

// Report permission changes made anywhere (system dialog, System Settings) within two seconds.
var lastPermissions = ""
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
  let current = permissions()
  let key = "\(current["microphone"] ?? "")/\(current["bluetooth"] ?? "")"
  if key != lastPermissions { lastPermissions = key; emit("permissions", current) }
}
emit("permissions", permissions())
app.run()
