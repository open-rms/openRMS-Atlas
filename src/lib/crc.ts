/**
 * CRC16 of a callsign exactly as Mercury puts it in CALL/ACCEPT frames:
 * uppercase, SSID kept, CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection,
 * no final xor). Same as openRMS-Watch src/crc.rs; vectors W1RMS-10 = 3DEF, K7TEST = C492.
 */
export function callsignCrc16(callsign: string): number {
  let crc = 0xffff;
  for (const b of Buffer.from(callsign.trim().toUpperCase(), "ascii")) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export const crcHex = (callsign: string) => callsignCrc16(callsign).toString(16).toUpperCase().padStart(4, "0");
