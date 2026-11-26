const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const GROUPS = 8;
const PREFIX_GROUPS = 4;

const ipv4Tail = (text: string): [number, number] | null => {
  const match = IPV4.exec(text);
  if (match === null) {
    return null;
  }
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return [(a << 8) | b, (c << 8) | d];
};

const parseSide = (part: string): number[] | null => {
  if (part === "") {
    return [];
  }
  const raw = part.split(":");
  const last = raw.at(-1) ?? "";
  const tail = last.includes(".") ? ipv4Tail(last) : null;
  const hexes = tail === null ? raw : raw.slice(0, -1);
  if (last.includes(".") && tail === null) {
    return null;
  }
  if (!hexes.every((group) => HEX_GROUP.test(group))) {
    return null;
  }
  const values = hexes.map((group) => Number.parseInt(group, 16));
  return tail === null ? values : [...values, ...tail];
};

const expandIpv6 = (address: string): number[] | null => {
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = parseSide(halves[0] ?? "");
  if (left === null) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === GROUPS ? left : null;
  }
  const right = parseSide(halves[1] ?? "");
  if (right === null || left.length + right.length >= GROUPS) {
    return null;
  }
  return [...left, ...Array<number>(GROUPS - left.length - right.length).fill(0), ...right];
};

const isMappedIpv4 = (groups: readonly number[]): boolean =>
  groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;

const formatIpv4 = (high: number, low: number): string =>
  `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;

export const normalizeIp = (raw: string | null): string => {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return "unknown";
  }
  if (!trimmed.includes(":")) {
    return trimmed;
  }
  const bare = trimmed.split("%", 1)[0] ?? trimmed;
  const groups = expandIpv6(bare);
  if (groups === null) {
    return trimmed;
  }
  if (isMappedIpv4(groups)) {
    return formatIpv4(groups[6] ?? 0, groups[7] ?? 0);
  }
  const prefix = groups
    .slice(0, PREFIX_GROUPS)
    .map((group) => group.toString(16))
    .join(":");
  return `${prefix}::/64`;
};
