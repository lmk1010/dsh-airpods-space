// Become this process's own TCC "responsible process". Spawned from DSH (or from a terminal during development), the
// helper would otherwise inherit its parent's responsibility, and permission prompts fail silently when that parent
// cannot present them. Re-exec once with responsibility disclaimed; stdio is inherited, so the protocol is unchanged.
import Darwin
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

private var child: pid_t = 0

/// Returns only in the disclaimed child (or when re-exec fails); the launcher process exits with the child's status.
func disclaimResponsibility() {
  guard ProcessInfo.processInfo.environment["DSH_AIRPODS_DISCLAIMED"] == nil,
        let path = Bundle.main.executablePath else { return }
  var attributes: posix_spawnattr_t?
  posix_spawnattr_init(&attributes)
  defer { posix_spawnattr_destroy(&attributes) }
  guard responsibility_spawnattrs_setdisclaim(&attributes, 1) == 0 else { return }
  setenv("DSH_AIRPODS_DISCLAIMED", "1", 1)
  let argv = CommandLine.arguments.map { strdup($0) } + [nil]
  defer { argv.forEach { free($0) } }
  guard posix_spawn(&child, path, nil, &attributes, argv, environ) == 0 else { unsetenv("DSH_AIRPODS_DISCLAIMED"); return }
  // Forward termination to the child so the Host's terminate() still stops the real helper.
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig) { received in if child > 0 { kill(child, received) } }
  }
  var status: Int32 = 0
  while waitpid(child, &status, 0) < 0 && errno == EINTR {}
  exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
}
