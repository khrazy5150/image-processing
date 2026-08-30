// Snowflake -> Base62 (~11 chars), URL-safe, time-ordered
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const EPOCH = 1735689600000n; // 2025-01-01T00:00:00Z (keep stable)

let lastMs = 0n;
let seq = 0n;
const workerId = BigInt((Number(process.env.WORKER_ID || 1)) & 0x3FF); // 10 bits

function toBase62(x) {
  x = BigInt(x);
  const base = 62n;
  let out = "";
  while (x > 0n) { out = ALPHABET[Number(x % base)] + out; x /= base; }
  return out || "0";
}

export function generateId() {
  let now = BigInt(Date.now());
  if (now === lastMs) {
    seq = (seq + 1n) & 0x1FFFn; // 13 bits
    if (seq === 0n) { while (now <= lastMs) now = BigInt(Date.now()); }
  } else {
    seq = 0n;
  }
  lastMs = now;

  const timePart = (now - EPOCH) & 0x1FFFFFFFFFFn; // 41 bits
  const value = (timePart << 23n) | (workerId << 13n) | seq;
  return toBase62(value).padStart(11, "0");
}