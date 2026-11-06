// Soft feedback tones synthesized at runtime: sine voices with a light second harmonic, a short attack and a
// smooth exponential decay, mixed at low level so they sit under speech instead of cutting through it.
import AVFoundation

enum Earcon: String {
  case start, end, done, failed, approval

  /// Notes as (frequency Hz, onset seconds); every note rings with the same gentle envelope.
  private var notes: [(Double, Double)] {
    switch self {
    case .start: return [(784, 0), (1047, 0.075)]              // G5 → C6, rising
    case .end: return [(1047, 0), (784, 0.075)]                // C6 → G5, falling
    case .done: return [(523, 0), (659, 0.09), (784, 0.18)]    // C5 E5 G5, a soft major arpeggio
    case .failed: return [(440, 0), (349, 0.12)]               // A4 → F4, low and calm
    case .approval: return [(659, 0), (659, 0.16)]             // E5 twice, a light knock
    }
  }

  /// PCM WAV of the tone at 44.1 kHz.
  fileprivate func wave(level: Double) -> Data {
    let rate = 44_100.0, tail = 0.45
    let length = Int(((notes.map(\.1).max() ?? 0) + tail) * rate)
    var samples = [Double](repeating: 0, count: length)
    for (frequency, onset) in notes {
      let start = Int(onset * rate)
      for i in 0..<(length - start) {
        let t = Double(i) / rate
        let attack = min(1, t / 0.012)
        let decay = exp(-t * 9)
        let voice = sin(2 * .pi * frequency * t) + 0.18 * sin(4 * .pi * frequency * t) * exp(-t * 18)
        samples[start + i] += voice * attack * decay
      }
    }
    let peak = max(samples.map(abs).max() ?? 1, 1)
    var data = Data()
    func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    let bytes = length * 2
    data.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + bytes)); data.append(contentsOf: Array("WAVEfmt ".utf8))
    u32(16); u16(1); u16(1); u32(44_100); u32(88_200); u16(2); u16(16)
    data.append(contentsOf: Array("data".utf8)); u32(UInt32(bytes))
    for sample in samples {
      let value = Int16(max(-1, min(1, sample / peak * level)) * Double(Int16.max))
      withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
  }
}

/// Plays earcons through the current output (the AirPods while connected); players are cached per tone.
final class EarconPlayer {
  var enabled = true
  /// Linear output level; 0.18 keeps tones well below speech.
  var level = 0.18
  private var players: [Earcon: AVAudioPlayer] = [:]

  func play(_ earcon: Earcon, force: Bool = false) {
    guard enabled || force else { return }
    let player = players[earcon] ?? (try? AVAudioPlayer(data: earcon.wave(level: level)))
    players[earcon] = player
    player?.currentTime = 0
    player?.play()
  }
}

let earcons = EarconPlayer()
