import { Resolver } from 'node:dns/promises';

/** Each lookup owns its resolver so its deadline cancels only its own DNS queries. */
export async function resolveAddresses(hostname: string): Promise<{ address: string; family: number }[]> {
  const resolver = new Resolver({ timeout: 2500, tries: 2 });
  const deadline = setTimeout(() => resolver.cancel(), 5000);
  deadline.unref();
  async function records(query: Promise<string[]>, family: number) {
    try {
      return (await query).map((address) => ({ address, family }));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENODATA') return [];
      throw error;
    }
  }
  try {
    const addresses = (
      await Promise.all([records(resolver.resolve4(hostname), 4), records(resolver.resolve6(hostname), 6)])
    ).flat();
    if (!addresses.length) throw new Error('DNS returned no addresses');
    return addresses;
  } finally {
    clearTimeout(deadline);
    resolver.cancel();
  }
}
