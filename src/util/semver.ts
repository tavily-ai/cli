interface Parsed {
  core: [number, number, number];
  pre: string[];
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_RE = /^\d+$/;

function parse(version: string): Parsed {
  const m = VERSION_RE.exec(version.trim());
  if (!m) throw new Error("The installed Tavily CLI version is invalid.");
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNum = NUMERIC_RE.test(a);
  const bNum = NUMERIC_RE.test(b);
  if (aNum && bNum) return sign(Number(a) - Number(b));
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = sign((pa.core[i] ?? 0) - (pb.core[i] ?? 0));
    if (diff !== 0) return diff;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    return sign(pb.pre.length - pa.pre.length);
  }
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const diff = compareIdentifier(pa.pre[i] ?? "", pb.pre[i] ?? "");
    if (diff !== 0) return diff;
  }
  return sign(pa.pre.length - pb.pre.length);
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}
