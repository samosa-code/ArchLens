import { describe, expect, test } from 'vitest';
import { countEdgeCrossings } from '../crossings.js';

describe('countEdgeCrossings (Ticket 3.6.3)', () => {
  test('two segments forming a real X are one crossing', () => {
    const edges = [
      { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
      { points: [{ x: 0, y: 10 }, { x: 10, y: 0 }] },
    ];
    expect(countEdgeCrossings(edges)).toBe(1);
  });

  test('two parallel segments never cross', () => {
    const edges = [
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { points: [{ x: 0, y: 5 }, { x: 10, y: 5 }] },
    ];
    expect(countEdgeCrossings(edges)).toBe(0);
  });

  test('two segments that merely share an endpoint (edges meeting at the same node) are not a crossing', () => {
    const edges = [
      { points: [{ x: 5, y: 0 }, { x: 0, y: 10 }] },
      { points: [{ x: 5, y: 0 }, { x: 10, y: 10 }] },
    ];
    expect(countEdgeCrossings(edges)).toBe(0);
  });

  test('segments belonging to the same edge (a multi-point polyline) are never counted against each other', () => {
    const edges = [{ points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }] }];
    expect(countEdgeCrossings(edges)).toBe(0);
  });

  test('a real multi-edge diamond: only the two diagonals cross, the four outer sides never do', () => {
    // Square corners TL(0,0) TR(10,0) BL(0,10) BR(10,10); two diagonal edges
    // TL->BR and TR->BL cross once; the four side edges cross nothing.
    const edges = [
      { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }, // diagonal 1
      { points: [{ x: 10, y: 0 }, { x: 0, y: 10 }] }, // diagonal 2
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }, // top side
      { points: [{ x: 0, y: 10 }, { x: 10, y: 10 }] }, // bottom side
    ];
    expect(countEdgeCrossings(edges)).toBe(1);
  });

  test('counts multiple independent crossings across more than two edges', () => {
    const edges = [
      { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
      { points: [{ x: 0, y: 10 }, { x: 10, y: 0 }] },
      { points: [{ x: 20, y: 0 }, { x: 30, y: 10 }] },
      { points: [{ x: 20, y: 10 }, { x: 30, y: 0 }] },
    ];
    expect(countEdgeCrossings(edges)).toBe(2);
  });

  test('two segments whose INFINITE lines would cross are not counted unless BOTH actual finite segments reach that crossing point', () => {
    // A's line (y=0) crosses B's line (x=5) at (5,0) — which lies on A's
    // own segment (x from 0 to 10) but NOT on B's actual segment (B only
    // spans y=1 to y=100, well above the crossing point). A real
    // proper-intersection test must check straddling in BOTH directions,
    // not just one — checking only "does A straddle B's line" would give a
    // false positive here.
    const edges = [
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { points: [{ x: 5, y: 1 }, { x: 5, y: 100 }] },
    ];
    expect(countEdgeCrossings(edges)).toBe(0);
  });

  test('an orthogonal (right-angle) elbow path crossing another edge is still detected', () => {
    const edges = [
      { points: [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 10 }] },
      { points: [{ x: 5, y: 0 }, { x: 5, y: 10 }] },
    ];
    expect(countEdgeCrossings(edges)).toBe(1);
  });
});
