import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const GSI_STYLE = 'https://accounts.google.com/gsi/style';
const COOP_VALUE = 'same-origin-allow-popups';

const vercel = JSON.parse(read('vercel.json'));
const vercelHeaders = vercel.headers.find((h: any) => h.source === '/(.*)').headers;
const vercelCsp = vercelHeaders.find((h: any) => h.key === 'Content-Security-Policy').value;
const vercelCoop = vercelHeaders.find((h: any) => h.key === 'Cross-Origin-Opener-Policy').value;

const staticHeaders = read('public/_headers');
const staticCsp = staticHeaders.match(/^\s*Content-Security-Policy:\s*(.*)$/m)?.[1] ?? '';
const staticCoop = staticHeaders.match(/^\s*Cross-Origin-Opener-Policy:\s*(.*)$/m)?.[1]?.trim() ?? '';

const server = read('server.ts');
const serverCsp = server.match(/PRODUCTION_CSP[\s\S]*?const securityHeaders/)?.[0] ?? '';
const serverCoop = server.match(/setHeader\(\s*['"]Cross-Origin-Opener-Policy['"]\s*,\s*['"]([^'"]+)['"]/)?.[1] ?? '';

describe('Google Identity Services response headers', () => {
  it('allows the GIS stylesheet in every deployed CSP', () => {
    expect(vercelCsp).toContain(`style-src`);
    expect(vercelCsp).toContain(GSI_STYLE);
    expect(staticCsp).toContain(GSI_STYLE);
    expect(serverCsp).toContain(GSI_STYLE);
  });

  it('keeps the other GIS directives in every deployed CSP', () => {
    for (const csp of [vercelCsp, staticCsp, serverCsp]) {
      expect(csp).toContain('script-src');
      expect(csp).toContain('https://accounts.google.com');
      expect(csp).toContain('connect-src');
      expect(csp).toContain('frame-src');
    }
  });

  it('keeps popup opener communication available for the non-FedCM Google button', () => {
    expect(vercelCoop).toBe(COOP_VALUE);
    expect(staticCoop).toBe(COOP_VALUE);
    expect(serverCoop).toBe(COOP_VALUE);
  });
});
