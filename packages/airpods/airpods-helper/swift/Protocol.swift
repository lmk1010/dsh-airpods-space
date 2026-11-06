// Line-delimited JSON over stdio. stdout: events; stdin: commands. One JSON object per line.
import Foundation

let protocolVersion = 1
private let out = FileHandle.standardOutput
private let outLock = NSLock()

/// Write one event; safe from any thread.
func emit(_ event: String, _ fields: [String: Any] = [:]) {
  var object = fields
  object["event"] = event
  object["t"] = Date().timeIntervalSince1970
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
  outLock.lock(); defer { outLock.unlock() }
  out.write(data)
  out.write(Data([0x0A]))
}

/// Read commands from stdin until EOF; EOF means the Host is gone, so the helper exits.
func readCommands(_ handle: @escaping ([String: Any]) -> Void) {
  DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
      guard let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emit("error", ["message": "invalid command line"]); continue
      }
      DispatchQueue.main.async { handle(object) }
    }
    DispatchQueue.main.async { exit(0) }
  }
}

/// AirPods and Beats models seen in proximity pairing adverts and IOBluetooth product ids (same 16-bit id).
struct PodModel {
  let id: UInt16
  let key: String        // stable id used by the UI artwork
  let name: String
  /// Press-to-mute gesture is available (stem press / Digital Crown) on macOS 14+.
  let muteGesture: Bool
  /// What the user physically does to talk.
  let gesture: String    // "press" | "double-tap" | "crown"
}

let podModels: [UInt16: PodModel] = {
  let list = [
    PodModel(id: 0x2002, key: "airpods-1", name: "AirPods", muteGesture: false, gesture: "double-tap"),
    PodModel(id: 0x200F, key: "airpods-2", name: "AirPods (2nd generation)", muteGesture: false, gesture: "double-tap"),
    PodModel(id: 0x2013, key: "airpods-3", name: "AirPods (3rd generation)", muteGesture: true, gesture: "press"),
    PodModel(id: 0x2019, key: "airpods-4", name: "AirPods 4", muteGesture: true, gesture: "press"),
    PodModel(id: 0x201B, key: "airpods-4-anc", name: "AirPods 4 (ANC)", muteGesture: true, gesture: "press"),
    PodModel(id: 0x200E, key: "airpods-pro", name: "AirPods Pro", muteGesture: true, gesture: "press"),
    PodModel(id: 0x2014, key: "airpods-pro-2", name: "AirPods Pro 2", muteGesture: true, gesture: "press"),
    PodModel(id: 0x2024, key: "airpods-pro-2-usbc", name: "AirPods Pro 2 (USB-C)", muteGesture: true, gesture: "press"),
    PodModel(id: 0x2027, key: "airpods-pro-3", name: "AirPods Pro 3", muteGesture: true, gesture: "press"),
    PodModel(id: 0x200A, key: "airpods-max", name: "AirPods Max", muteGesture: true, gesture: "crown"),
    PodModel(id: 0x201F, key: "airpods-max-usbc", name: "AirPods Max (USB-C)", muteGesture: true, gesture: "crown"),
  ]
  return Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
}()

func modelFields(_ id: UInt16) -> [String: Any] {
  let model = podModels[id]
  return ["productId": String(format: "0x%04X", id), "model": model?.key ?? "unknown", "name": model?.name ?? "AirPods",
          "muteGesture": model?.muteGesture ?? false, "gesture": model?.gesture ?? "double-tap"]
}
