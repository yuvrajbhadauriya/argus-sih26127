import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { getDataSource, reportLiveError, reportLiveOk, reportSimUnavailable, resetDataSource, useDataSource } from './dataSource';

beforeEach(() => resetDataSource());

describe('dataSource', () => {
  it('is "simulated" without Supabase, "demo" once the sim files fail', () => {
    expect(getDataSource()).toBe('simulated');
    const { result } = renderHook(() => useDataSource());
    expect(result.current.label).toBe('Simulated network');
    act(() => reportSimUnavailable());
    expect(getDataSource()).toBe('demo');
    expect(result.current.label).toBe('Demo fixtures');
  });

  it('records and clears the last live error', () => {
    const { result } = renderHook(() => useDataSource());
    act(() => reportLiveError(new Error('JWT expired')));
    expect(result.current.liveError?.message).toBe('JWT expired');
    act(() => reportLiveOk());
    expect(result.current.liveError).toBeNull();
  });
});
