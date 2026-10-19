import { describe, expect, it } from "vitest";
import { adjacencyFromSvg, buildAdjacency, splitEdgeTitle } from "./graphfocus";

const render = async (dot: string) => {
  const { instance } = await import("@viz-js/viz");
  return (await instance()).renderString(dot, { format: "svg" });
};

/** つながりを比べやすい形にする */
const plain = (adj: ReturnType<typeof buildAdjacency>) =>
  Object.fromEntries([...adj].map(([k, v]) => [k, { edges: v.edges.length, neighbors: [...v.neighbors].sort() }]));

describe("splitEdgeTitle", () => {
  const nodes = new Set(["a-b", "c", "d1/kama/x", "t0", "t1"]);

  it("splits at the separator whose both sides are nodes", () => {
    expect(splitEdgeTitle("a-b->c", nodes)).toEqual(["a-b", "c"]);
    expect(splitEdgeTitle("c--a-b", nodes)).toEqual(["c", "a-b"]);
    expect(splitEdgeTitle("d1/kama/x->c", nodes)).toEqual(["d1/kama/x", "c"]);
  });

  it("drops ports", () => {
    expect(splitEdgeTitle("t0:c3->t1:c0", nodes)).toEqual(["t0", "t1"]);
    expect(splitEdgeTitle("t0:c3:e->t1:w", nodes)).toEqual(["t0", "t1"]);
  });

  it("returns null when the ends are unknown", () => {
    expect(splitEdgeTitle("x->y", nodes)).toBeNull();
  });
});

describe("adjacencyFromSvg", () => {
  it("reads the requirement's sample: both directions, one step only", async () => {
    const svg = await render(`digraph G {
      subgraph cluster_x { id="grp-x"; label="X"; A [label="A", URL="#dest"]; B; }
      C; D; D2;
      A -> B [label="a-b"];
      B -> C [label="b-c"];
      D -> D2;
    }`);
    expect(svg).toContain("&#45;&gt;");
    expect(plain(adjacencyFromSvg(svg))).toEqual({
      A: { edges: 1, neighbors: ["B"] },
      B: { edges: 2, neighbors: ["A", "C"] },
      C: { edges: 1, neighbors: ["B"] },
      D: { edges: 1, neighbors: ["D2"] },
      D2: { edges: 1, neighbors: ["D"] },
    });
  });

  it("handles undirected graphs, self loops and isolated nodes", async () => {
    const svg = await render("graph { a -- b; b -- b; lone; }");
    expect(plain(adjacencyFromSvg(svg))).toEqual({
      a: { edges: 1, neighbors: ["b"] },
      b: { edges: 2, neighbors: ["a"] },
      lone: { edges: 0, neighbors: [] },
    });
  });

  it("keeps nodes with the same label apart by their id", async () => {
    const svg = await render(`digraph {
      "m1/f/tbl" [label="tbl"]; "m2/f/tbl" [label="tbl"]; x;
      "m1/f/tbl" -> x;
    }`);
    const adj = adjacencyFromSvg(svg);
    expect([...adj.get("m1/f/tbl")!.neighbors]).toEqual(["x"]);
    expect(adj.get("m2/f/tbl")!.edges).toEqual([]);
  });
});
