import { vercelDnsInstructionsFor } from '../../src/lib/providers/vercelClient.js';

describe('vercelClient.vercelDnsInstructionsFor', () => {
  it('gives the CNAME host as the domain\'s first label, regardless of TLD complexity', () => {
    // A naive "count the labels" apex check gets this wrong for .co.za (3
    // labels) - this platform's actual market - so both options are always
    // returned rather than guessed; only the CNAME's host label depends on
    // the domain at all, and that's always just the first label.
    expect(vercelDnsInstructionsFor('mysalon.co.za').subdomain.host).toBe('mysalon');
    expect(vercelDnsInstructionsFor('book.mysalon.co.za').subdomain.host).toBe('book');
    expect(vercelDnsInstructionsFor('mysalon.com').subdomain.host).toBe('mysalon');
  });

  it('always returns both the apex (A) and subdomain (CNAME) options', () => {
    const result = vercelDnsInstructionsFor('mysalon.co.za');
    expect(result.apex).toEqual({ type: 'A', host: '@', value: '76.76.21.21' });
    expect(result.subdomain).toEqual({ type: 'CNAME', host: 'mysalon', value: 'cname.vercel-dns.com' });
  });
});
