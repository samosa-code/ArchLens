interface Point {
  x: number;
  y: number;
}

interface CrossingCheckableEdge {
  points: Point[];
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/**
 * A real "proper crossing" test — two segments that merely touch at a
 * shared endpoint (the normal case for edges meeting at the same node) are
 * deliberately NOT a crossing, only a genuine interior intersection counts.
 * No separate shared-endpoint check is needed to get that right: a shared
 * endpoint is, by construction, one of the segment's own defining points,
 * so at least one of `d1..d4` below is always exactly `0` for it — which
 * the strict `d1 !== 0` (etc.) checks already reject. Confirmed directly
 * via mutation testing: an earlier explicit `pointsEqual()` early-return
 * here was provably dead code (removing it changed no test's outcome) and
 * was deleted rather than kept as unneeded defensive weight.
 */
function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = sign(cross(b1, b2, a1));
  const d2 = sign(cross(b1, b2, a2));
  const d3 = sign(cross(a1, a2, b1));
  const d4 = sign(cross(a1, a2, b2));

  return d1 !== d2 && d1 !== 0 && d2 !== 0 && d3 !== d4 && d3 !== 0 && d4 !== 0;
}

/**
 * Counts real, proper pairwise segment intersections across every DISTINCT
 * pair of edges' rendered polylines (Ticket 3.6.3's baseline metric) —
 * never within the same edge's own segments (a continuous path doesn't
 * "cross itself" in the sense that matters for visual clutter), and never
 * two segments that just meet at a shared endpoint (edges legitimately
 * converging on the same node).
 */
export function countEdgeCrossings(edges: CrossingCheckableEdge[]): number {
  let count = 0;

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const segmentsA = toSegments(edges[i]!.points);
      const segmentsB = toSegments(edges[j]!.points);
      for (const [a1, a2] of segmentsA) {
        for (const [b1, b2] of segmentsB) {
          if (segmentsCross(a1, a2, b1, b2)) count += 1;
        }
      }
    }
  }

  return count;
}

function toSegments(points: Point[]): [Point, Point][] {
  const segments: [Point, Point][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push([points[i]!, points[i + 1]!]);
  }
  return segments;
}
