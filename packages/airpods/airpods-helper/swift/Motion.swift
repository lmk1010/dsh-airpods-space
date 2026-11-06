// Nod / shake from AirPods head tracking (AirPods Pro, 3rd gen and later, Max; macOS 14+). Runs only while the Host
// asks for it (an approval is pending), so the motion sensors stay off otherwise.
import CoreMotion
import Foundation

final class HeadGestures {
  /// CMHeadphoneMotionManager on macOS 14+, nil before.
  private let storage: AnyObject? = { if #available(macOS 14.0, *) { return CMHeadphoneMotionManager() } else { return nil } }()
  private var baseline: (pitch: Double, yaw: Double)?
  private var nodDownAt: Date?
  private var yawSigns: [(sign: Int, at: Date)] = []
  private var lastGesture = Date.distantPast

  /// Whether the connected headphones report motion.
  var available: Bool {
    guard #available(macOS 14.0, *), let manager = storage as? CMHeadphoneMotionManager else { return false }
    return manager.isDeviceMotionAvailable
  }

  func start() {
    guard #available(macOS 14.0, *), let manager = storage as? CMHeadphoneMotionManager,
          manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else {
      emit("head", ["state": available ? "active" : "unavailable"]); return
    }
    baseline = nil
    manager.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
      guard let self, let motion else { return }
      self.update(pitch: motion.attitude.pitch, yaw: motion.attitude.yaw)
    }
    emit("head", ["state": "active"])
  }

  func stop() {
    guard #available(macOS 14.0, *), let manager = storage as? CMHeadphoneMotionManager, manager.isDeviceMotionActive else { return }
    manager.stopDeviceMotionUpdates()
    emit("head", ["state": "stopped"])
  }

  /// Nod: pitch dips at least 0.22 rad and comes back within 1.2 s. Shake: yaw swings past ±0.25 rad both ways within 1.5 s.
  private func update(pitch: Double, yaw: Double) {
    let now = Date()
    guard let base = baseline else { baseline = (pitch, yaw); return }
    // Slowly follow posture changes so a tilted head does not count as a gesture.
    baseline = (base.pitch * 0.98 + pitch * 0.02, base.yaw * 0.98 + yaw * 0.02)
    guard now.timeIntervalSince(lastGesture) > 1.5 else { return }
    let dPitch = pitch - base.pitch, dYaw = yaw - base.yaw
    if dPitch < -0.22 { nodDownAt = nodDownAt ?? now }
    if let down = nodDownAt {
      if dPitch > -0.08 && now.timeIntervalSince(down) < 1.2 { fire("nod"); return }
      if now.timeIntervalSince(down) >= 1.2 { nodDownAt = nil }
    }
    if abs(dYaw) > 0.25 {
      let sign = dYaw > 0 ? 1 : -1
      if yawSigns.last?.sign != sign { yawSigns.append((sign, now)) }
      yawSigns.removeAll { now.timeIntervalSince($0.at) > 1.5 }
      if Set(yawSigns.map(\.sign)).count == 2 { fire("shake") }
    }
  }

  private func fire(_ gesture: String) {
    lastGesture = Date(); nodDownAt = nil; yawSigns.removeAll()
    emit("head", ["state": "gesture", "gesture": gesture])
  }
}
