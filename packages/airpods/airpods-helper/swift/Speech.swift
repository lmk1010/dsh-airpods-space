// Built-in speech: system voices read replies into the headset (no download), and Apple's on-device recognizer turns
// the captured audio into streaming text (no download). Both are the plugin's small default; local models and cloud
// services are optional providers on the Host side.
import AVFoundation
import Foundation
import Speech

/// Reads text aloud with the system voice for the text's language.
final class Reader: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private(set) var speaking = false
  var onFinish: (() -> Void)?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  /// Speak, replacing anything being read.
  /// - Parameters:
  ///   - text: plain text; markdown symbols are stripped by the Host.
  ///   - rate: 0...1, `AVSpeechUtteranceDefaultSpeechRate` is about 0.5.
  func speak(_ text: String, rate: Float) {
    if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    let utterance = AVSpeechUtterance(string: text)
    let chinese = text.range(of: "\\p{Han}", options: .regularExpression) != nil
    utterance.voice = AVSpeechSynthesisVoice(language: chinese ? "zh-CN" : "en-US")
    utterance.rate = rate
    speaking = true
    emit("speaking", ["state": "start", "characters": text.count])
    synthesizer.speak(utterance)
  }

  /// Stop reading at once; reports `stopped` when something was being read.
  func stop() {
    guard synthesizer.isSpeaking else { return }
    synthesizer.stopSpeaking(at: .immediate)
  }

  func pause() { if synthesizer.isSpeaking { synthesizer.pauseSpeaking(at: .word); emit("speaking", ["state": "paused"]) } }
  func resume() { if synthesizer.isPaused { synthesizer.continueSpeaking(); emit("speaking", ["state": "resumed"]) } }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    speaking = false; emit("speaking", ["state": "end"]); onFinish?()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    speaking = false; emit("speaking", ["state": "stopped"]); onFinish?()
  }
}

/// Streams captured audio into Apple's on-device recognizer and reports partial and final text.
final class AppleRecognizer {
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  /// Latest non-empty transcription of the current turn.
  private var finalText = ""

  static func status() -> String {
    guard describable else { return "denied" }
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "granted"
    case .notDetermined: return "prompt"
    default: return "denied"
    }
  }

  /// Without the usage description TCC terminates the process, so never ask then.
  static var describable: Bool { Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil }

  static func requestAccess(_ done: @escaping (String) -> Void) {
    guard describable else { done("denied"); return }
    SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async { done(status()) } }
  }

  /// Whether on-device recognition exists for the locale (no network use).
  static func available(locale: String) -> Bool {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else { return false }
    return recognizer.isAvailable && recognizer.supportsOnDeviceRecognition
  }

  /// Begin a turn; returns false when the recognizer is unavailable or not authorized.
  func start(locale: String) -> Bool {
    cancel()
    guard SFSpeechRecognizer.authorizationStatus() == .authorized,
          let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else { return false }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    finalText = ""
    self.request = request
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let result {
          let text = result.bestTranscription.formattedString
          if !text.isEmpty { self.finalText = text }
          if result.isFinal { emit("asr", ["phase": "final", "text": self.finalText]); self.clear() }
          else { emit("asr", ["phase": "partial", "text": text]) }
        } else if let error {
          // An error after speech (the recognizer timing out after endAudio) keeps the words already heard; "No speech
          // detected" ends a silent turn as an empty final so the Host closes the turn.
          emit("asr", ["phase": "final", "text": self.finalText, "error": error.localizedDescription]); self.clear()
        }
      }
    }
    return true
  }

  func append(_ buffer: AVAudioPCMBuffer) { request?.append(buffer) }

  /// Input finished; the final result follows asynchronously.
  func finish() { request?.endAudio() }

  func cancel() { task?.cancel(); clear() }

  private func clear() { request = nil; task = nil }
}
