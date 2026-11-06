// Press-to-talk. Idle: DSH holds the system "Now Playing" slot (claimed politely, never while another app plays),
// so a headphone press arrives as a remote command. Talking: the mic is open; on macOS 14+ the input-mute gesture
// (stem press on AirPods 3/4/Pro, Digital Crown on Max) reaches this process because it is capturing, and models
// without the gesture (AirPods 1/2 double-tap) keep arriving as remote commands. After a turn the mic lingers open
// so a quick follow-up needs no Bluetooth profile switch, then closes to restore high-quality playback.
import AppKit
import AudioToolbox
import AVFoundation
import Foundation
import MediaPlayer

struct VoiceConfig {
  var lingerSeconds = 0.2            // close right after a turn: an open mic keeps the AirPods in call mode, where presses never arrive
  var maxTalkSeconds = 120.0
  var pressDebounceSeconds = 0.35    // one press can deliver pause + toggle
  var reclaimAfterIdleSeconds = 300.0 // take Now Playing back once other audio has been silent this long
  var chunkMilliseconds = 100
}

final class Voice {
  enum State: String { case idle, opening, talking, lingering }

  private let config: VoiceConfig
  private let route: AudioRoute
  private(set) var state: State = .idle
  private var engine: AVAudioEngine?
  private var converter: AVAudioConverter?
  private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
  private var pending = Data()
  private var lastPress = Date.distantPast
  private var pressAt = Date.distantPast
  private var talkStarted = Date.distantPast
  private var linger: Timer?
  private var claimed = false
  private var claimPlayer: AVAudioPlayer?
  private var remoteTargets: [(MPRemoteCommand, Any)] = []
  private var muteHandlerInstalled = false
  private var lastMuted: Bool?
  var claimEnabled = true
  /// Called when a press arrives without microphone access; main shows the onboarding card.
  var onNeedsMicrophone: (() -> Void)?
  /// Opening or closing the headset microphone switches the AirPods profile, which makes other apps restart their output.
  var micChangedAt = Date.distantPast
  /// Apple's on-device recognizer, used when the Host selects the `apple` source.
  let apple = AppleRecognizer()
  var useApple = false
  var appleLocale = "zh-CN"
  /// Reads replies aloud; a press while reading stops it instead of starting a turn.
  var reader: Reader?
  /// The headset microphone to record from; nil means no headset is connected, so nothing is recorded.
  var headsetInput: () -> AudioDeviceID? = { nil }
  private var device: AudioDeviceID = 0
  /// Last in-ear / out-of-ear change; automatic ear detection sends play/pause that is not a press.
  var lastEarChange = Date.distantPast
  var earGraceSeconds = 1.5

  init(config: VoiceConfig = VoiceConfig(), route: AudioRoute) {
    self.config = config
    self.route = route
  }

  // MARK: Now Playing

  /// Register remote commands and become the Now Playing app with a single silent blip (no periodic re-claiming).
  func claim(reason: String) {
    guard claimEnabled else { return }
    if remoteTargets.isEmpty {
      let center = MPRemoteCommandCenter.shared()
      for (command, name) in [(center.nextTrackCommand, "next"), (center.previousTrackCommand, "previous")] {
        command.isEnabled = true
        let token = command.addTarget { [weak self] _ in
          DispatchQueue.main.async { self?.gesture(name) }
          return .success
        }
        remoteTargets.append((command, token))
      }
      for (command, name) in [(center.togglePlayPauseCommand, "toggle"), (center.playCommand, "play"), (center.pauseCommand, "pause")] {
        command.isEnabled = true
        let token = command.addTarget { [weak self] _ in
          DispatchQueue.main.async { self?.press(source: "remote", detail: name) }
          return .success
        }
        remoteTargets.append((command, token))
      }
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "DeepSeek Harness", MPMediaItemPropertyArtist: "Press your AirPods to talk"]
    claimPlayer = try? AVAudioPlayer(data: silentWave(milliseconds: 200))
    claimPlayer?.volume = 0
    claimPlayer?.play()
    MPNowPlayingInfoCenter.default().playbackState = .playing
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MPNowPlayingInfoCenter.default().playbackState = .paused }
    claimed = true
    emit("claim", ["state": "claimed", "reason": reason])
  }

  func release() {
    for (command, token) in remoteTargets { command.removeTarget(token) }
    remoteTargets = []
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    MPNowPlayingInfoCenter.default().playbackState = .stopped
    claimed = false
    emit("claim", ["state": "released"])
  }

  /// Another app started playing; the system moved Now Playing to it.
  func lostClaim(to app: [String: Any]) {
    guard claimed else { return }
    claimed = false
    emit("claim", ["state": "lost", "to": app])
  }

  /// Other audio has been silent long enough that the user is likely done with it.
  func reclaimIfIdle(otherAudioIdleSeconds: Double) {
    if !claimed && otherAudioIdleSeconds >= config.reclaimAfterIdleSeconds && route.headphonesOutput { claim(reason: "idle") }
  }

  /// "Next track" interrupts (DSH's task, reading, or the current turn); "previous track" undoes the last sentence.
  func gesture(_ name: String) {
    let now = Date()
    guard now.timeIntervalSince(lastEarChange) >= earGraceSeconds, now.timeIntervalSince(lastPress) > config.pressDebounceSeconds else { return }
    lastPress = now
    if name == "next" {
      reader?.stop()
      if state == .talking || state == .opening { cancelTurn() }
      emit("gesture", ["kind": "interrupt"])
    } else {
      if state == .talking || state == .opening { cancelTurn() }
      emit("gesture", ["kind": "undo"])
    }
  }

  /// Apple recognition was refused: tell the Host so turns use its recognizers instead.
  func useAppleDenied() { useApple = false; emit("asr", ["phase": "unavailable"]) }

  /// Drop the current turn without sending.
  func cancelTurn() {
    guard state == .talking || state == .opening else { return }
    apple.cancel()
    pending.removeAll()
    emit("voice", ["state": "ended", "reason": "cancel", "cancelled": true])
    state = .lingering
    setInputMuted(true)
    linger = Timer.scheduledTimer(withTimeInterval: config.lingerSeconds, repeats: false) { [weak self] _ in self?.closeMic() }
  }

  // MARK: Talk

  /// A headphone press, keyboard shortcut or UI action.
  func press(source: String, detail: String = "") {
    let now = Date()
    if source == "remote" && now.timeIntervalSince(lastEarChange) < earGraceSeconds {
      emit("press", ["source": source, "detail": detail, "ignored": "ear-detection"]); return
    }
    guard now.timeIntervalSince(lastPress) > config.pressDebounceSeconds else { return }
    lastPress = now
    emit("press", ["source": source, "detail": detail, "state": state.rawValue])
    if reader?.speaking == true && state != .talking {
      reader?.stop(); emit("gesture", ["kind": "stop-reading"]); return
    }
    switch state {
    case .idle, .lingering: startTalk(trigger: source)
    case .talking: endTalk(reason: source)
    case .opening: endTalk(reason: "cancel")
    }
  }

  private func startTalk(trigger: String) {
    // Only the headset's microphone is ever used; without connected AirPods there is no talk turn.
    guard let headset = headsetInput() else {
      emit("voice", ["state": "idle", "error": "no-headset"])
      return
    }
    // Without authorization macOS delivers silent buffers; ask first, never record zeros.
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: break
    case .notDetermined:
      emit("voice", ["state": "idle", "error": "microphone-prompt"])
      onNeedsMicrophone?()
      return
    default:
      emit("voice", ["state": "idle", "error": "microphone-denied"])
      onNeedsMicrophone?()
      return
    }
    // First use of Apple recognition: ask, then start listening by itself once allowed (no second press needed).
    if useApple && AppleRecognizer.status() == "prompt" {
      emit("voice", ["state": "idle", "error": "speech-prompt"])
      AppleRecognizer.requestAccess { status in
        emit("permissions", permissions())
        // Refused or never shown (the responsible app lacks a usage string): this same press continues with the
        // Host's recognizers instead of leaving the user with no reaction.
        if status != "granted" { self.useAppleDenied() }
        self.startTalk(trigger: trigger)
      }
      return
    }
    pressAt = Date()
    linger?.invalidate(); linger = nil
    if engine != nil && headset != device { closeMic() }
    device = headset
    if engine == nil {
      state = .opening
      emit("voice", ["state": "opening", "trigger": trigger])
      do { try openMic() } catch {
        state = .idle
        emit("voice", ["state": "idle", "error": "\(error.localizedDescription)"])
        return
      }
    } else {
      beginTurn()
    }
  }

  /// Short system sounds in the headset so the user knows when listening starts and ends without looking.
  private func cue(_ name: String) { NSSound(named: NSSound.Name(name))?.play() }

  private func beginTurn() {
    cue("Tink")
    state = .talking
    talkStarted = Date()
    pending.removeAll()
    if useApple && !apple.start(locale: appleLocale) { emit("asr", ["phase": "unavailable"]) }
    setInputMuted(false)
    earcons.play(.start)
    emit("voice", ["state": "talking", "input": deviceName(device),
                   "readyMs": Int(Date().timeIntervalSince(pressAt) * 1000)])
  }

  func endTalk(reason: String) {
    guard state == .talking || state == .opening else { return }
    if state == .talking { cue("Pop") }
    flush()
    if useApple { apple.finish() }
    earcons.play(.end)
    emit("voice", ["state": "ended", "reason": reason, "seconds": Date().timeIntervalSince(talkStarted)])
    state = .lingering
    setInputMuted(true)
    linger = Timer.scheduledTimer(withTimeInterval: config.lingerSeconds, repeats: false) { [weak self] _ in self?.closeMic() }
  }

  func closeMic() {
    micChangedAt = Date()
    linger?.invalidate(); linger = nil
    if state == .talking { endTalk(reason: "close") }
    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    engine = nil
    converter = nil
    lastMuted = nil
    state = .idle
    emit("voice", ["state": "idle"])
  }

  private func openMic() throws {
    micChangedAt = Date()
    let engine = AVAudioEngine()
    let input = engine.inputNode
    // Bind the engine to the headset explicitly instead of following the system default input.
    var selected = device
    guard let unit = input.audioUnit, AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                                          &selected, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
      throw NSError(domain: "airpods-helper", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not use the AirPods microphone"])
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, let converter = AVAudioConverter(from: format, to: target) else {
      throw NSError(domain: "airpods-helper", code: 1, userInfo: [NSLocalizedDescriptionKey: "No usable microphone input"])
    }
    self.converter = converter
    installMuteHandler()
    var first = true
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { [weak self] buffer, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        if first { first = false; if self.state == .opening { self.beginTurn() } }
        self.capture(buffer)
      }
    }
    engine.prepare()
    try engine.start()
    self.engine = engine
  }

  private func capture(_ buffer: AVAudioPCMBuffer) {
    guard state == .talking, let converter else { return }
    if useApple { apple.append(buffer) }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true; status.pointee = .haveData; return buffer
    }
    guard error == nil, let samples = out.int16ChannelData else { return }
    pending.append(Data(bytes: samples[0], count: Int(out.frameLength) * 2))
    let chunkBytes = Int(target.sampleRate) * 2 * config.chunkMilliseconds / 1000
    while pending.count >= chunkBytes {
      emit("audio", ["pcm": pending.prefix(chunkBytes).base64EncodedString()])
      pending.removeFirst(chunkBytes)
    }
    if Date().timeIntervalSince(talkStarted) > config.maxTalkSeconds { endTalk(reason: "limit") }
  }

  private func flush() {
    if !pending.isEmpty { emit("audio", ["pcm": pending.base64EncodedString()]); pending.removeAll() }
  }

  // MARK: Input mute gesture (macOS 14+)

  private func installMuteHandler() {
    guard #available(macOS 14.0, *), !muteHandlerInstalled else { return }
    do {
      // Called on an AudioSession XPC queue; hop to main before touching state.
      try AVAudioApplication.shared.setInputMuteStateChangeHandler { @Sendable muted in
        DispatchQueue.main.async { [weak self] in self?.muteGesture(muted) }
        return true
      }
      muteHandlerInstalled = true
    } catch {
      emit("error", ["message": "mute gesture unavailable: \(error.localizedDescription)"])
    }
  }

  private func muteGesture(_ muted: Bool) {
    // The handler also fires to sync state when a stream opens; only a change is a press.
    defer { lastMuted = muted }
    guard let previous = lastMuted, previous != muted else { return }
    if muted && state == .talking { press(source: "mute-gesture", detail: "mute") }
    else if !muted && state == .lingering { press(source: "mute-gesture", detail: "unmute") }
  }

  private func setInputMuted(_ muted: Bool) {
    guard #available(macOS 14.0, *), muteHandlerInstalled else { return }
    lastMuted = muted
    try? AVAudioApplication.shared.setInputMuted(muted)
  }
}

/// 16 kHz mono PCM16 WAV of silence.
func silentWave(milliseconds: Int) -> Data {
  let samples = 16 * milliseconds, bytes = samples * 2
  var data = Data()
  func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  data.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + bytes)); data.append(contentsOf: Array("WAVEfmt ".utf8))
  u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
  data.append(contentsOf: Array("data".utf8)); u32(UInt32(bytes)); data.append(Data(count: bytes))
  return data
}
