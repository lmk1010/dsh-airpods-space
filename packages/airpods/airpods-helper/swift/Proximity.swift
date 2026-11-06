// AirPods case lid / battery from Apple proximity pairing adverts (manufacturer 0x004C, type 0x07).
// Layout (furiousMAC continuity): [5..6] model LE, [7] status, [8] L/R battery nibbles, [9] charging bits + case battery,
// [10] lid open counter with bit 3 = lid closed.
//
// Lid-open detection must not depend on seeing the "closed" state: adverts stop almost immediately after the lid
// closes, so a close is often never observed. An open is reported when, with the buds in the case and the lid open,
// (a) the lid byte differs from the last one seen, or (b) the pod reappears after an advert gap.
import CoreBluetooth
import Foundation

struct ProximityConfig {
  var minRssi = -85              // weaker adverts belong to someone else's AirPods across the room
  var gapSeconds = 2.5           // adverts arrive every ~0.1–1 s while the lid is open; a gap means it was closed
  var goneSeconds = 12.0
  var nearReportSeconds = 10.0
  var openDebounceSeconds = 3.0  // one physical open can toggle the lid byte more than once
}

final class Proximity: NSObject, CBCentralManagerDelegate {
  private var central: CBCentralManager!
  private let config: ProximityConfig
  private var tracked: (id: UUID, lidByte: UInt8, lastSeen: Date, lastReport: Date, lastOpen: Date, lidOpen: Bool, rssi: Int, inCase: Bool)?
  private var lastRaw = ""
  private var lastInOut = Date.distantPast
  private var lastBuds = -1
  private var lastEar = false
  private var lastOpenCounter: UInt8?

  /// Called once Bluetooth is authorized and powered on; IOBluetooth calls block until then.
  var onReady: (() -> Void)?
  /// Called on every authorization or power change.
  var onState: (() -> Void)?
  private var readyFired = false

  /// Every `pods` event, after it is written to stdout.
  var onEvent: (([String: Any]) -> Void)?
  /// Product ids of AirPods paired with this Mac; adverts from other models (someone else's pods) are ignored.
  var pairedModels: Set<UInt16> = []

  private func report(_ fields: [String: Any]) {
    emit("pods", fields)
    onEvent?(fields)
  }

  init(config: ProximityConfig = ProximityConfig()) {
    self.config = config
    super.init()
    central = CBCentralManager(delegate: self, queue: .main)
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.expire() }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let state: String
    switch central.state {
    case .poweredOn: state = "on"
    case .unauthorized: state = "denied"
    case .poweredOff: state = "off"
    case .unsupported: state = "unsupported"
    default: state = "unknown"
    }
    emit("bluetooth", ["state": state])
    onState?()
    if central.state == .poweredOn {
      central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
      if !readyFired { readyFired = true; onReady?() }
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData ad: [String: Any], rssi: NSNumber) {
    guard let data = ad[CBAdvertisementDataManufacturerDataKey] as? Data, data.count >= 11 else { return }
    let b = [UInt8](data)
    guard b[0] == 0x4C, b[1] == 0x00, b[2] == 0x07 else { return }
    let signal = rssi.intValue
    guard signal < 0, signal >= config.minRssi else { return }
    let now = Date()
    // Follow one pair: switch only when another pair is clearly closer.
    if let current = tracked, current.id != peripheral.identifier,
       now.timeIntervalSince(current.lastSeen) < config.gapSeconds, signal < current.rssi + 10 { return }

    let model = UInt16(b[6]) << 8 | UInt16(b[5])
    if !pairedModels.isEmpty && !pairedModels.contains(model) { return }
    let status = b[7]
    let flip = (status & 0x20) == 0
    let hi = b[8] >> 4, lo = b[8] & 0x0F
    let charge = b[9] >> 4
    // 0x04: the advertising bud is in the case; 0x10: the other bud is in the case (verified with one bud worn).
    // 0x02: the advertising bud is in an ear. Case battery 0xF means the case is closed or out of range, so the
    // other bud's location is unknown and must not be read as "out of the case".
    let caseKnown = (b[9] & 0x0F) != 0x0F
    let budsInCase = ((status & 0x04) != 0 ? 1 : 0) + ((status & 0x10) != 0 ? 1 : 0)
    let inCase = budsInCase > 0
    let inEar = (status & 0x02) != 0
    let lidOpen = (b[10] & 0x08) == 0
    func pct(_ n: UInt8) -> Any { n <= 10 ? Int(n) * 10 : NSNull() }
    let chargingLeft = (charge & (flip ? 0x2 : 0x1)) != 0, chargingRight = (charge & (flip ? 0x1 : 0x2)) != 0
    var fields = modelFields(model)
    fields.merge([
      // Flipped (bit 0x20 clear): the high nibble is the left bud (OpenPods/librepods layout; confirmed with a dead left bud).
      "left": pct(flip ? hi : lo), "right": pct(flip ? lo : hi), "case": pct(b[9] & 0x0F),
      "charging": ["left": chargingLeft, "right": chargingRight, "case": (charge & 0x4) != 0],
      "inCase": inCase, "budsInCase": caseKnown ? budsInCase : NSNull(), "inEar": inEar, "lidOpen": lidOpen, "rssi": signal,
      "raw": b.prefix(12).map { String(format: "%02x", $0) }.joined(),
    ]) { $1 }

    fields["caseSide"] = !caseKnown ? "unknown" : budsInCase == 2 ? "both" : budsInCase == 0 ? "none"
      : chargingLeft != chargingRight ? (chargingLeft ? "left" : "right") : "unknown"
    guard var current = tracked, current.id == peripheral.identifier else {
      lastEar = inEar; lastBuds = caseKnown ? budsInCase : lastBuds
      if inCase && lidOpen { lastOpenCounter = b[10] & 0x07 }
      tracked = (peripheral.identifier, b[10], now, now, inCase && lidOpen ? now : .distantPast, lidOpen, signal, inCase)
      fields["state"] = inCase && lidOpen ? "open" : "near"
      report(fields); return
    }
    let gap = now.timeIntervalSince(current.lastSeen)
    let lidChanged = b[10] != current.lidByte
    current.lastSeen = now; current.rssi = signal
    defer { tracked = current }
    // Worn buds alternate adverts with opposite lid bits; only judge the lid while the buds are in the case.
    // b[10] & 0x07 counts lid openings. With one bud worn both buds advertise and one of them relays a stale lid
    // state for seconds, so an open counts only when the counter moved or the case reappears after a gap.
    let counter = b[10] & 0x07
    if inCase && lidOpen && (counter != lastOpenCounter || gap > config.gapSeconds)
        && now.timeIntervalSince(current.lastOpen) > config.openDebounceSeconds {
      current.lastOpen = now
      lastOpenCounter = counter
      current.lidByte = b[10]; current.lidOpen = true; current.lastReport = now
      lastEar = inEar; if caseKnown { lastBuds = budsInCase }
      fields["state"] = "open"; report(fields); return
    }
    if inCase && lidChanged && !lidOpen && current.lidOpen {
      current.lidByte = b[10]; current.lidOpen = false; current.lastReport = now
      fields["state"] = "closed"; report(fields); return
    }
    // A bud went into an ear: report at once, it drives the worn animation.
    if inEar != lastEar && now.timeIntervalSince(lastInOut) > 1.5 {
      lastEar = inEar; lastInOut = now; current.lastReport = now
      fields["state"] = inEar ? "in-ear" : "out-of-ear"; report(fields); return
    }
    // One bud taken out or put back while the case is open: refresh the artwork at once.
    if caseKnown && budsInCase != lastBuds && now.timeIntervalSince(lastInOut) > 1.5 {
      lastBuds = budsInCase; lastInOut = now; current.lastReport = now
      fields["state"] = "buds"; report(fields); return
    }
    // Only real open/closed events change lidOpen; a stale relay must not flip it back.
    if inCase { current.lidByte = b[10] }
    if now.timeIntervalSince(current.lastReport) > config.nearReportSeconds {
      current.lastReport = now; fields["state"] = "near"; report(fields)
    }
  }

  private func expire() {
    guard let current = tracked, Date().timeIntervalSince(current.lastSeen) > config.goneSeconds else { return }
    tracked = nil
    report(["state": "gone"])
  }
}
