import { describe, expect, it, vi } from 'vitest';

import { ModelCatalogCache } from '../../src/adapters/model-selection.js';
import type { AdapterModelCatalog } from '../../src/adapters/types.js';

function catalog(overrides: Partial<AdapterModelCatalog> = {}): AdapterModelCatalog {
  return {
    support: 'catalog',
    source: 'provider-api',
    authoritative: true,
    models: [{ model: 'model-a', displayName: 'Model A' }],
    checkedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('ModelCatalogCache', () => {
  it('does not cache a degraded partial catalog', async () => {
    const cache = new ModelCatalogCache();
    const load = vi.fn()
      .mockResolvedValueOnce(catalog({
        authoritative: false,
        models: [{ model: 'configured-default', displayName: 'Configured default' }],
        warnings: ['provider temporarily unavailable'],
      }))
      .mockResolvedValueOnce(catalog());

    const degraded = await cache.get(undefined, load);
    const recovered = await cache.get(undefined, load);

    expect(degraded.warnings).toEqual(['provider temporarily unavailable']);
    expect(recovered.authoritative).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cold loads and caches the successful result', async () => {
    const cache = new ModelCatalogCache();
    let resolveLoad!: (value: AdapterModelCatalog) => void;
    const load = vi.fn(() => new Promise<AdapterModelCatalog>((resolve) => {
      resolveLoad = resolve;
    }));

    const first = cache.get(undefined, load);
    const second = cache.get(undefined, load);
    expect(load).toHaveBeenCalledOnce();

    const loaded = catalog();
    resolveLoad(loaded);
    await expect(Promise.all([first, second])).resolves.toEqual([loaded, loaded]);
    await expect(cache.get(undefined, load)).resolves.toBe(loaded);
    expect(load).toHaveBeenCalledOnce();
  });
});
