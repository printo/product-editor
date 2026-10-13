/**
 * Shape catalogue parity: the previews build shapes from lib/shape-catalog.ts
 * and the print from services/shape_catalog.py. Both are held to
 * storage/parity-fixtures/shape-catalog.json (the Python side by
 * services/tests/test_shape_catalog_parity.py), so a shape added or changed
 * on one side fails here until the other side matches.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SHAPE_CATALOG, getShapePath } from '@/lib/shape-catalog';

// This file: frontend/nextjs/src/lib/__tests__/ → repo root is five levels up.
const FIXTURE_PATH = path.resolve(__dirname, '..', '..', '..', '..', '..', 'storage', 'parity-fixtures', 'shape-catalog.json');

interface FixtureShape {
  key: string;
  svgPath: string;
  fabricType?: string;
  polygonPoints?: Array<{ x: number; y: number }>;
}

describe('shape catalogue parity with the print', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as { shapes: FixtureShape[] };

  it('lists the same shapes, in the same order, with the same geometry', () => {
    const ours: FixtureShape[] = SHAPE_CATALOG.map(s => {
      const entry: FixtureShape = { key: s.key, svgPath: s.svgPath };
      if (s.fabricType) entry.fabricType = s.fabricType;
      if (s.polygonPoints) entry.polygonPoints = s.polygonPoints;
      return entry;
    });
    expect(ours).toEqual(fixture.shapes);
  });

  it('falls back to the rectangle path for an unknown key, which the print mirrors', () => {
    expect(getShapePath('no-such-shape')).toBe(fixture.shapes[0].svgPath);
    expect(fixture.shapes[0].key).toBe('rect');
  });
});
