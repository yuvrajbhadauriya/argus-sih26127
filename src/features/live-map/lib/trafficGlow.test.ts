import { describe, it, expect } from 'vitest';
import { glowIcon, trafficDescription } from '../lib/trafficGlow';

describe('TrafficLayer glow', () => {
  const r = { code: 'SC-01', count: 7, intensity: 0.8, level: 'Heavy' as const, windowSec: 5 };

  it('describes the camera, the vehicle count and a Light/Moderate/Heavy word', () => {
    expect(trafficDescription({ code: 'SC-01', name: 'Sion Circle' }, r)).toBe('SC-01 Sion Circle: 7 vehicles in view (last 5 s) · Heavy traffic');
    expect(trafficDescription({ code: 'A', name: 'B' }, { ...r, count: 1, level: 'Light' })).toContain('1 vehicle in view');
  });

  it('is an accessible filled radial glow, escaped, whose strength follows the intensity', () => {
    const el = glowIcon('X "quoted" <b>', 1).createIcon() as HTMLElement;
    const glow = el.querySelector('.nero-heat') as HTMLElement;
    expect(glow.getAttribute('role')).toBe('img');
    expect(glow.getAttribute('aria-label')).toBe('X "quoted" <b>');
    expect(glow.innerHTML).toBe('');
    const heavy = glow.style.getPropertyValue('--heat-core');
    const light = (glowIcon('y', 0).createIcon() as HTMLElement).querySelector<HTMLElement>('.nero-heat')!.style.getPropertyValue('--heat-core');
    expect(heavy).toContain('hsl(0 ');
    expect(light).toContain('hsl(120 ');
  });

  it('reuses the icon while nothing visible changes (no per-second DOM rebuild)', () => {
    expect(glowIcon('same', 0.501)).toBe(glowIcon('same', 0.503));
    expect(glowIcon('same', 0.5)).not.toBe(glowIcon('same', 0.9));
  });
});
