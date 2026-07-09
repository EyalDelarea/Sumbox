/**
 * Machine + Ollama environment capture for benchmark provenance, plus best-effort
 * macOS memory-pressure sampling. Everything is wrapped in try/catch — a missing
 * tool degrades to `undefined`, never a crash.
 */
import { execFileSync } from "node:child_process";

function sh(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

export type SysInfo = {
  chip?: string;
  ramGb?: number;
  gpuCores?: number;
  macos?: string;
  ollamaVersion?: string;
  /** Server-config label supplied by the runner (e.g. "default" or "flash+kv-q8_0"). */
  serverConfig: string;
  capturedAt: string;
};

export function captureSysInfo(serverConfig: string, capturedAt: string): SysInfo {
  const ramBytes = sh("sysctl", ["-n", "hw.memsize"]);
  const gpu = sh("system_profiler", ["SPDisplaysDataType"]);
  const gpuCores = gpu?.match(/Total Number of Cores:\s*(\d+)/)?.[1];
  return {
    chip: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
    ramGb: ramBytes ? Math.round(Number(ramBytes) / 1024 ** 3) : undefined,
    gpuCores: gpuCores ? Number(gpuCores) : undefined,
    macos: sh("sw_vers", ["-productVersion"]),
    ollamaVersion: sh("ollama", ["--version"])?.replace(/^ollama version is\s*/, ""),
    serverConfig,
    capturedAt,
  };
}

/**
 * Best-effort macOS memory-pressure snapshot: returns the system-wide free memory
 * percentage and the resident set size (MB) of the largest llama-server process
 * (the actual model host). undefined fields on non-macOS or parse failure.
 */
export function sampleMemory(): { freePct?: number; llamaServerRssMb?: number } {
  const mp = sh("memory_pressure", []);
  const freePct = mp?.match(/free percentage:\s*(\d+)%/)?.[1];

  let llamaServerRssMb: number | undefined;
  const ps = sh("bash", ["-lc", "ps -axo rss,comm | grep -i llama-server | grep -v grep || true"]);
  if (ps) {
    const maxRssKb = ps
      .split("\n")
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);
    if (maxRssKb > 0) llamaServerRssMb = Math.round(maxRssKb / 1024);
  }

  return {
    freePct: freePct ? Number(freePct) : undefined,
    llamaServerRssMb,
  };
}
