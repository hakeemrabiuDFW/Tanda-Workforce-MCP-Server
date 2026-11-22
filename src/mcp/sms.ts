/**
 * SMS length maths for draft messages (WFM-105). A message that fits the GSM-7 alphabet is
 * 160 characters a segment (153 when split); one character outside it (e.g. Spanish á, í, ó, ú,
 * ¿ are not all in GSM-7) makes the whole message UCS-2: 70 a segment (67 when split).
 */

// GSM 03.38 basic set (one septet each)
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
);
// Extension set: each costs two septets (escape + char)
const GSM_EXTENDED = new Set('^{}\\[~]|€\f');

export interface SmsLength {
  encoding: 'GSM-7' | 'UCS-2';
  /** Length in the encoding's units: septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
  /** Characters outside GSM-7 that forced UCS-2 (up to 5), so a writer can swap them. */
  non_gsm_chars?: string[];
}

export function smsLength(message: string): SmsLength {
  let septets = 0;
  const nonGsm = new Set<string>();
  for (const ch of message) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXTENDED.has(ch)) septets += 2;
    else nonGsm.add(ch);
  }
  if (!nonGsm.size) {
    return { encoding: 'GSM-7', units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  const units = message.length;
  return {
    encoding: 'UCS-2',
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
    non_gsm_chars: [...nonGsm].slice(0, 5),
  };
}
