import { dashboardFilterQuery, dashboardHref, readDashboardFilter, rememberDashboardFilter } from '../dashboard-filter';

describe('dashboard filter in the address', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads tag and search, absent as empty', () => {
    expect(readDashboardFilter(new URLSearchParams('tag=photo_frame&q=gold'))).toEqual({ tag: 'photo_frame', q: 'gold' });
    expect(readDashboardFilter(new URLSearchParams(''))).toEqual({ tag: '', q: '' });
  });

  it('leaves empty values out of the address', () => {
    expect(dashboardFilterQuery({ tag: 'photo_frame', q: 'gold' })).toBe('?tag=photo_frame&q=gold');
    expect(dashboardFilterQuery({ tag: '', q: 'gold leaf' })).toBe('?q=gold+leaf');
    expect(dashboardFilterQuery({ tag: '', q: '' })).toBe('');
  });

  it('round-trips a search with special characters', () => {
    const query = dashboardFilterQuery({ tag: 'photo_frame', q: '12x18 & 4"' });
    expect(readDashboardFilter(new URLSearchParams(query))).toEqual({ tag: 'photo_frame', q: '12x18 & 4"' });
  });

  it('Back to Layouts returns to the remembered filter', () => {
    expect(dashboardHref()).toBe('/dashboard');
    rememberDashboardFilter({ tag: 'photo_frame', q: '' });
    expect(dashboardHref()).toBe('/dashboard?tag=photo_frame');
    rememberDashboardFilter({ tag: '', q: '' });
    expect(dashboardHref()).toBe('/dashboard');
  });
});
