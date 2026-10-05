import type { RawField } from '../browser/types.js';

/** Address typed into email fields. A public disposable inbox: never a real person's address. */
export const SAMPLE_EMAIL = 'john@maildrop.cc';

/** Synthetic test data only. Never real personal data; payment-like fields are never filled (ActionGuard). */
export function validValue(f: RawField): string {
  const hint = `${f.name} ${f.label} ${f.placeholder}`.toLowerCase();
  switch (f.type) {
    case 'email': return SAMPLE_EMAIL;
    case 'url': return 'https://example.com';
    case 'tel': return '+15555550100';
    case 'password': return 'Qa!Test-12345';
    case 'number': case 'range': {
      const min = f.min !== undefined ? Number(f.min) : undefined; const max = f.max !== undefined ? Number(f.max) : undefined;
      const lo = min !== undefined && !Number.isNaN(min) ? min : undefined; const hi = max !== undefined && !Number.isNaN(max) ? max : undefined;
      // a plausible adult age when the field is an age and the constraints allow it
      if (/\bage\b/.test(hint) && (lo ?? 0) <= 25 && (hi ?? 200) >= 25) return '25';
      if (lo !== undefined) return String(hi !== undefined ? Math.floor((lo + hi) / 2) : lo + 1);
      if (hi !== undefined) return String(Math.min(5, hi));
      return '5';
    }
    case 'date': return '2030-01-15';
    case 'time': return '10:30';
    case 'datetime-local': return '2030-01-15T10:30';
    case 'month': return '2030-01';
    case 'week': return '2030-W03';
    case 'color': return '#336699';
    case 'search': return 'qa test';
    case 'textarea': return 'Automated QA test message.';
    default: break;
  }
  if (f.pattern) return patternSample(f.pattern) ?? 'QATest1';
  if (/zip|postal/.test(hint)) return '12345';
  if (/phone|mobile/.test(hint)) return '+15555550100';
  if (/e-?mail/.test(hint)) return SAMPLE_EMAIL;
  if (/company|organi[sz]ation|employer|business/.test(hint)) return 'Example Corp';
  if (/first/.test(hint)) return 'Demo';
  if (/last|surname/.test(hint)) return 'User';
  if (/city/.test(hint)) return 'Testville';
  if (/user(name)?|login/.test(hint)) return 'demo_user';
  let v = /name/.test(hint) ? 'Demo User' : 'qa test';
  if (f.minLength && v.length < f.minLength) v = v.padEnd(f.minLength, 'x');
  if (f.maxLength && v.length > f.maxLength) v = v.slice(0, f.maxLength);
  return v;
}

/** A value that violates the field's own declared constraints, or null when the field declares none we can violate. */
export function invalidValue(f: RawField): string | null {
  switch (f.type) {
    case 'email': return 'not-an-email';
    case 'url': return 'not a url';
    case 'tel': return f.pattern ? 'abc' : null;
    case 'number': case 'range': {
      if (f.min !== undefined && !Number.isNaN(Number(f.min))) return String(Number(f.min) - 1);
      if (f.max !== undefined && !Number.isNaN(Number(f.max))) return String(Number(f.max) + 1);
      return null;
    }
    default:
      if (f.pattern) return '!!!';
      if (f.minLength && f.minLength > 1) return 'a';
      return null;
  }
}

/** Tiny best-effort generator for simple patterns like [0-9]{5} or [A-Z]{2}\d{3}; null when too complex. */
function patternSample(p: string): string | null {
  if (/^\[0-9\]\{(\d+)\}$|^\\d\{(\d+)\}$/.test(p)) return '1'.repeat(Number(/(\d+)\}$/.exec(p)![1]));
  if (/^\[A-Za-z\]\{(\d+)\}$/.test(p)) return 'a'.repeat(Number(/(\d+)\}$/.exec(p)![1]));
  return null;
}

export function isPaymentField(f: RawField): boolean {
  return /(card|cvv|cvc|iban|routing|account.?number|cc-)/i.test(`${f.name} ${f.label}`);
}
