// @effect-diagnostics nodeBuiltinImport:off - Reading a firmware/machine identifier needs platform shell-outs and a sync digest; no Effect runtime is loaded here.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeProcess from "node:process";

/** Digest of a reinstall-stable machine id; the raw id never leaves the machine and an unreadable one omits the header. */
const DEEPAI_MACHINE_HEADER = "X-DeepAI-Code-Machine";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SMBIOS_PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

function parseIOPlatformUUID(ioreg: string): string | null {
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioreg);
  return match?.[1] && UUID.test(match[1]) ? match[1].toLowerCase() : null;
}

function parseSmbiosUUID(output: string): string | null {
  const uuid = UUID.exec(output)?.[0]?.toLowerCase() ?? null;
  return uuid && !SMBIOS_PLACEHOLDERS.has(uuid) ? uuid : null;
}

function parseMachineGuid(regQuery: string): string | null {
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(regQuery);
  return match?.[1] && UUID.test(match[1]) ? match[1].toLowerCase() : null;
}

function parseLinuxMachineId(file: string): string | null {
  const id = file.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : null;
}

function hashMachineId(raw: string): string {
  return NodeCrypto.createHash("sha256").update(raw).digest("hex");
}

function run(file: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      file,
      args as string[],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
      (error: unknown, stdout: string | Buffer) => resolve(error ? "" : String(stdout)),
    );
  });
}

async function detect(): Promise<string | null> {
  if (NodeProcess.platform === "darwin") {
    return parseIOPlatformUUID(await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
  }
  if (NodeProcess.platform === "win32") {
    const wmic = await run("wmic", ["csproduct", "get", "uuid"]);
    const fromWmic = parseSmbiosUUID(wmic);
    if (fromWmic) return fromWmic;
    return parseMachineGuid(
      await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]),
    );
  }
  if (NodeProcess.platform === "linux") {
    try {
      const file = await NodeFSP.readFile("/etc/machine-id", "utf8");
      return parseLinuxMachineId(file);
    } catch {
      return null;
    }
  }
  return null;
}

let cachedHeaders: Promise<Record<string, string>> | undefined;

/** Headers identifying this machine to DeepAI's metered endpoints; empty when unreadable. */
export function deepAIMachineHeaders(): Promise<Record<string, string>> {
  return (cachedHeaders ??= detect().then((id) =>
    id ? { [DEEPAI_MACHINE_HEADER]: hashMachineId(id) } : {},
  ));
}
