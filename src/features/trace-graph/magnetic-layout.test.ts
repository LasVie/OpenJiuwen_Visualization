import { describe, expect, it } from "vitest";
import {
  magneticProfile,
  magnetizeNode,
  repelNodeCollisions,
  type MagneticNodeLike,
} from "./magnetic-layout";

function node(
  id: string,
  x: number,
  y: number,
  overrides: Partial<MagneticNodeLike> = {},
): MagneticNodeLike {
  return {
    id,
    type: "stage",
    position: { x, y },
    width: 100,
    height: 80,
    data: {},
    ...overrides,
  };
}

function overlaps(
  first: MagneticNodeLike,
  second: MagneticNodeLike,
  gap = 0,
) {
  const firstWidth = first.width ?? 100;
  const firstHeight = first.height ?? 80;
  const secondWidth = second.width ?? 100;
  const secondHeight = second.height ?? 80;
  return (
    first.position.x < second.position.x + secondWidth + gap &&
    first.position.x + firstWidth + gap > second.position.x &&
    first.position.y < second.position.y + secondHeight + gap &&
    first.position.y + firstHeight + gap > second.position.y
  );
}

describe("magnetic graph layout", () => {
  it("maps magnetic strength to a larger field and grid", () => {
    expect(magneticProfile(20).gap).toBeLessThan(magneticProfile(60).gap);
    expect(magneticProfile(60).gap).toBeLessThan(magneticProfile(90).gap);
    expect(magneticProfile(20).grid[0]).toBe(10);
    expect(magneticProfile(90).grid[0]).toBe(20);
  });

  it("snaps a free card to the configured grid", () => {
    const result = magnetizeNode([node("moving", 31, 47)], "moving");
    expect(result[0].position).toEqual({ x: 40, y: 40 });
  });

  it("moves a colliding card to the nearest free grid position", () => {
    const result = magnetizeNode(
      [node("fixed", 0, 0), node("moving", 10, 10)],
      "moving",
      { gap: 20 },
    );
    const moving = result.find((item) => item.id === "moving")!;
    const horizontallySeparated =
      moving.position.x >= 120 || moving.position.x + 100 <= -20;
    const verticallySeparated =
      moving.position.y >= 100 || moving.position.y + 80 <= -20;
    expect(horizontallySeparated || verticallySeparated).toBe(true);
  });

  it("keeps the dragged card under the pointer and pushes its peer live", () => {
    const result = repelNodeCollisions(
      [node("moving", 20, 20), node("peer", 80, 20)],
      "moving",
      { gap: 24 },
    );

    expect(result[0].position).toEqual({ x: 20, y: 20 });
    expect(result[1].position.x).toBeGreaterThanOrEqual(144);
  });

  it("moves a collided peer to a position free from the whole layer", () => {
    const result = repelNodeCollisions(
      [
        node("moving", 0, 0),
        node("second", 90, 0),
        node("third", 180, 0),
      ],
      "moving",
      { gap: 20 },
    );

    expect(result[0].position).toEqual({ x: 0, y: 0 });
    expect(result[1].position).not.toEqual({ x: 90, y: 0 });
    expect(overlaps(result[0], result[1], 20)).toBe(false);
    expect(overlaps(result[1], result[2], 20)).toBe(false);
  });

  it("keeps expanded main-path modules in their horizontal lane", () => {
    const parent = node("deep-agent", 0, 0, {
      type: "agentGroup",
      width: 930,
      height: 475,
    });
    const result = repelNodeCollisions(
      [
        parent,
        node("moving", 100, 125, {
          parentId: "deep-agent",
          data: { compact: true, hierarchy: "main" },
        }),
        node("peer", 150, 125, {
          parentId: "deep-agent",
          data: { compact: true, hierarchy: "main" },
        }),
      ],
      "moving",
      { gap: 28 },
    );

    expect(result[1].position).toEqual({ x: 100, y: 125 });
    expect(result[2].position.y).toBe(125);
    expect(result[2].position.x).toBeGreaterThanOrEqual(228);
  });

  it("finds a globally free slot for a crowded expanded main path", () => {
    const parent = node("deep-agent", 0, 0, {
      type: "agentGroup",
      width: 1100,
      height: 475,
    });
    const mainNode = (id: string, x: number) =>
      node(id, x, 125, {
        parentId: "deep-agent",
        width: 190,
        height: 110,
        data: { compact: true, hierarchy: "main" },
      });
    const result = repelNodeCollisions(
      [
        parent,
        mainNode("react", 35),
        mainNode("context", 535),
        mainNode("model", 535),
        mainNode("decision", 785),
      ],
      "context",
      { gap: 44 },
    );
    const children = result.filter((item) => item.parentId === "deep-agent");

    expect(result.find((item) => item.id === "context")?.position).toEqual({
      x: 535,
      y: 125,
    });
    for (let first = 0; first < children.length; first += 1) {
      for (let second = first + 1; second < children.length; second += 1) {
        expect(overlaps(children[first], children[second], 44)).toBe(false);
      }
    }
  });

  it("ignores cards in a different parent canvas", () => {
    const result = repelNodeCollisions(
      [
        node("outer", 0, 0),
        node("inner", 1, 1, { parentId: "deep-agent" }),
      ],
      "inner",
    );

    expect(result[0].position).toEqual({ x: 0, y: 0 });
    expect(result[1].position).toEqual({ x: 1, y: 1 });
  });
});
