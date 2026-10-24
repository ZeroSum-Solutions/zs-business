// TwiML for the voice webhooks (docs/requirements/twilio.md T-10..T-13). Original code. Every
// text and URL is escaped, so a business name or a caller-supplied value cannot add a verb.

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
// XML 1.0 forbids most control characters; they are dropped, not escaped.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export const escapeXml = (text: string): string => text.replace(FORBIDDEN, "").replace(/[&<>"']/g, (char) => ESCAPES[char]!);

const attributes = (values: Readonly<Record<string, string | number>>) =>
  Object.entries(values).map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`).join("");

export const say = (text: string): string => `<Say>${escapeXml(text)}</Say>`;
export const hangup = (): string => "<Hangup/>";
export const dial = (number: string, options: { readonly timeout: number; readonly action?: string }): string =>
  `<Dial${attributes({ timeout: options.timeout, ...(options.action === undefined ? {} : { action: options.action }) })}>${escapeXml(number)}</Dial>`;
export const gather = (inner: string, options: { readonly action: string; readonly timeout: number }): string =>
  `<Gather${attributes({ input: "dtmf", numDigits: 1, timeout: options.timeout, action: options.action })}>${inner}</Gather>`;
export const record = (options: { readonly action: string; readonly statusCallback: string; readonly maxLength: number; readonly timeout: number }): string =>
  `<Record${attributes({
    maxLength: options.maxLength, timeout: options.timeout, playBeep: "true", action: options.action,
    recordingStatusCallback: options.statusCallback,
  })}/>`;

export const voiceResponse = (...verbs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;
