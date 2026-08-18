export interface MagneticNodeLike {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
  style?: { width?: number | string; height?: number | string };
  data?: Record<string, unknown>;
}

export interface MagneticLayoutOptions {
  grid?: [number, number];
  gap?: number;
  maxRings?: number;
  parentPadding?: number;
}

export interface MagneticProfile {
  gap: number;
  grid: [number, number];
}

interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NodeBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const fallbackSizes: Record<string, { width: number; height: number }> = {
  stage: { width: 214, height: 126 },
  rail: { width: 228, height: 154 },
  agentSummary: { width: 300, height: 180 },
  agentGroup: { width: 1100, height: 475 },
  railDecision: { width: 252, height: 150 },
  definition: { width: 264, height: 154 },
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function magneticProfile(strength: number): MagneticProfile {
  const normalized = clamp(strength, 1, 100) / 100;
  const gridSize = strength < 34 ? 10 : strength < 67 ? 16 : 20;
  return {
    gap: Math.round(10 + normalized * 38),
    grid: [gridSize, gridSize],
  };
}

export function magneticStrengthLabel(strength: number) {
  if (strength < 34) return "弱";
  if (strength < 67) return "中";
  return "强";
}

function cssDimension(value: number | string | undefined) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nodeSize(node: MagneticNodeLike) {
  const compact = node.type === "stage" && node.data?.compact === true;
  const fallback = compact
    ? { width: 190, height: 110 }
    : fallbackSizes[node.type ?? "stage"] ?? fallbackSizes.stage;
  return {
    width:
      node.measured?.width ??
      node.width ??
      cssDimension(node.style?.width) ??
      fallback.width,
    height:
      node.measured?.height ??
      node.height ??
      cssDimension(node.style?.height) ??
      fallback.height,
  };
}

function nodeRect(
  node: MagneticNodeLike,
  position = node.position,
): NodeRect {
  return { ...position, ...nodeSize(node) };
}

function overlapsWithGap(first: NodeRect, second: NodeRect, gap: number) {
  return (
    first.x < second.x + second.width + gap &&
    first.x + first.width + gap > second.x &&
    first.y < second.y + second.height + gap &&
    first.y + first.height + gap > second.y
  );
}

function snap(value: number, gridSize: number) {
  return Math.round(value / gridSize) * gridSize;
}

function nodeBounds(
  nodes: MagneticNodeLike[],
  node: MagneticNodeLike,
  parentPadding: number,
): NodeBounds | undefined {
  if (!node.parentId) return undefined;
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  if (!parent) return undefined;

  const parentSize = nodeSize(parent);
  const size = nodeSize(node);
  const hierarchy = node.data?.hierarchy;
  let minY = parentPadding;
  let maxY = parentSize.height - size.height - parentPadding;

  if (hierarchy === "main") {
    minY = 104;
    maxY = Math.max(minY, 145);
  } else if (hierarchy === "branch") {
    minY = 292;
    maxY = Math.max(minY, parentSize.height - size.height - 18);
  }

  return {
    minX: parentPadding,
    maxX: Math.max(parentPadding, parentSize.width - size.width - parentPadding),
    minY,
    maxY,
  };
}

function clampToBounds(
  position: { x: number; y: number },
  bounds?: NodeBounds,
) {
  if (!bounds) return position;
  return {
    x: clamp(position.x, bounds.minX, bounds.maxX),
    y: clamp(position.y, bounds.minY, bounds.maxY),
  };
}

function candidateOffsets(
  ring: number,
  [gridX, gridY]: [number, number],
) {
  const offsets: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  const add = (x: number, y: number) => {
    const key = `${x}:${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    offsets.push({ x, y });
  };

  for (let axis = -ring; axis <= ring; axis += 1) {
    add(axis * gridX, -ring * gridY);
    add(axis * gridX, ring * gridY);
    add(-ring * gridX, axis * gridY);
    add(ring * gridX, axis * gridY);
  }

  return offsets.sort(
    (first, second) =>
      first.x ** 2 + first.y ** 2 - (second.x ** 2 + second.y ** 2),
  );
}

function separationCandidates(
  anchor: MagneticNodeLike,
  moving: MagneticNodeLike,
  gap: number,
) {
  const anchorRect = nodeRect(anchor);
  const movingRect = nodeRect(moving);
  const anchorCenter = {
    x: anchorRect.x + anchorRect.width / 2,
    y: anchorRect.y + anchorRect.height / 2,
  };
  const movingCenter = {
    x: movingRect.x + movingRect.width / 2,
    y: movingRect.y + movingRect.height / 2,
  };
  const horizontal =
    movingCenter.x >= anchorCenter.x
      ? [
          { x: anchorRect.x + anchorRect.width + gap, y: moving.position.y },
          { x: anchorRect.x - movingRect.width - gap, y: moving.position.y },
        ]
      : [
          { x: anchorRect.x - movingRect.width - gap, y: moving.position.y },
          { x: anchorRect.x + anchorRect.width + gap, y: moving.position.y },
        ];
  const vertical =
    movingCenter.y >= anchorCenter.y
      ? [
          { x: moving.position.x, y: anchorRect.y + anchorRect.height + gap },
          { x: moving.position.x, y: anchorRect.y - movingRect.height - gap },
        ]
      : [
          { x: moving.position.x, y: anchorRect.y - movingRect.height - gap },
          { x: moving.position.x, y: anchorRect.y + anchorRect.height + gap },
        ];
  const preferHorizontal =
    anchor.parentId !== undefined &&
    anchor.parentId === moving.parentId &&
    (anchor.data?.hierarchy === "main" || moving.data?.hierarchy === "main");

  if (preferHorizontal) return [...horizontal, ...vertical];

  return [...horizontal, ...vertical].sort((first, second) => {
    const firstDistance =
      (first.x - moving.position.x) ** 2 +
      (first.y - moving.position.y) ** 2;
    const secondDistance =
      (second.x - moving.position.x) ** 2 +
      (second.y - moving.position.y) ** 2;
    return firstDistance - secondDistance;
  });
}

function positionKey(position: { x: number; y: number }) {
  return `${Math.round(position.x * 100) / 100}:${Math.round(position.y * 100) / 100}`;
}

function nearestFreePosition(
  nodes: MagneticNodeLike[],
  anchor: MagneticNodeLike,
  moving: MagneticNodeLike,
  requestedGap: number,
  parentPadding: number,
  maxRings: number,
) {
  const bounds = nodeBounds(nodes, moving, parentPadding);
  const blockers = nodes.filter(
    (node) =>
      node.id !== moving.id &&
      (node.parentId ?? null) === (moving.parentId ?? null),
  );
  const movingSize = nodeSize(moving);
  const anchorRect = nodeRect(anchor);
  const movingRect = nodeRect(moving);
  const horizontalDirection =
    movingRect.x + movingRect.width / 2 >=
    anchorRect.x + anchorRect.width / 2
      ? 1
      : -1;
  const verticalDirection =
    movingRect.y + movingRect.height / 2 >=
    anchorRect.y + anchorRect.height / 2
      ? 1
      : -1;
  const preferHorizontal =
    anchor.parentId !== undefined &&
    anchor.parentId === moving.parentId &&
    (anchor.data?.hierarchy === "main" || moving.data?.hierarchy === "main");

  for (const gap of [requestedGap, requestedGap * 0.66, requestedGap * 0.33, 0]) {
    const candidates: Array<{ x: number; y: number }> = [];
    const seen = new Set<string>();
    const add = (candidate: { x: number; y: number }) => {
      const resolved = clampToBounds(candidate, bounds);
      const key = positionKey(resolved);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(resolved);
    };

    blockers.forEach((blocker) => {
      separationCandidates(blocker, moving, gap).forEach(add);
    });
    add(moving.position);
    if (bounds) {
      add({ x: bounds.minX, y: moving.position.y });
      add({ x: bounds.maxX, y: moving.position.y });
      add({ x: moving.position.x, y: bounds.minY });
      add({ x: moving.position.x, y: bounds.maxY });
    }

    const searchStep = Math.max(10, Math.round(Math.max(gap, 20) / 2));
    for (let ring = 1; ring <= maxRings; ring += 1) {
      candidateOffsets(ring, [searchStep, searchStep]).forEach((offset) =>
        add({
          x: moving.position.x + offset.x,
          y: moving.position.y + offset.y,
        }),
      );
    }

    const freeCandidates = candidates.filter((candidate) => {
      const candidateRect = nodeRect(moving, candidate);
      return blockers.every(
        (blocker) =>
          !overlapsWithGap(candidateRect, nodeRect(blocker), gap),
      );
    });
    if (freeCandidates.length === 0) continue;

    freeCandidates.sort((first, second) => {
      const score = (candidate: { x: number; y: number }) => {
        const distance =
          (candidate.x - moving.position.x) ** 2 +
          (candidate.y - moving.position.y) ** 2;
        const candidateCenter = {
          x: candidate.x + movingSize.width / 2,
          y: candidate.y + movingSize.height / 2,
        };
        const crossedAnchor = preferHorizontal
          ? horizontalDirection *
              (candidateCenter.x -
                (anchorRect.x + anchorRect.width / 2)) <
            0
          : verticalDirection *
              (candidateCenter.y -
                (anchorRect.y + anchorRect.height / 2)) <
            0;
        return distance + (crossedAnchor ? 1_000_000 : 0);
      };
      return score(first) - score(second);
    });
    return freeCandidates[0];
  }

  return moving.position;
}

export function repelNodeCollisions<T extends MagneticNodeLike>(
  nodes: T[],
  draggedId: string,
  options: MagneticLayoutOptions = {},
): T[] {
  const dragged = nodes.find((node) => node.id === draggedId);
  if (!dragged) return nodes;

  const gap = options.gap ?? 24;
  const parentPadding = options.parentPadding ?? 18;
  const family = nodes
    .filter(
      (node) =>
        (node.parentId ?? null) === (dragged.parentId ?? null),
    );
  const positions = new Map(
    nodes.map((node) => [node.id, { ...node.position }]),
  );
  const currentDragged = { ...dragged, position: positions.get(dragged.id)! };
  const collidingPeers = family.filter(
    (peer) =>
      peer.id !== draggedId &&
      overlapsWithGap(nodeRect(currentDragged), nodeRect(peer), gap),
  );

  collidingPeers.forEach((peerSource) => {
    const currentNodes = nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    }));
    const anchor = currentNodes.find((node) => node.id === draggedId)!;
    const moving = currentNodes.find((node) => node.id === peerSource.id)!;
    const nextPosition = nearestFreePosition(
      currentNodes,
      anchor,
      moving,
      gap,
      parentPadding,
      Math.min(options.maxRings ?? 12, 20),
    );
    positions.set(moving.id, nextPosition);
  });

  let didMove = false;
  const resolved = nodes.map((node) => {
    const position = positions.get(node.id) ?? node.position;
    if (position.x === node.position.x && position.y === node.position.y) {
      return node;
    }
    didMove = true;
    return { ...node, position };
  });
  return didMove ? resolved : nodes;
}

export function magnetizeNode<T extends MagneticNodeLike>(
  nodes: T[],
  draggedId: string,
  options: MagneticLayoutOptions = {},
): T[] {
  const index = nodes.findIndex((node) => node.id === draggedId);
  if (index < 0) return nodes;

  const grid = options.grid ?? [20, 20];
  const gap = options.gap ?? 24;
  const maxRings = options.maxRings ?? 48;
  const dragged = nodes[index];
  const bounds = nodeBounds(nodes, dragged, options.parentPadding ?? 18);
  const desired = clampToBounds(
    {
      x: snap(dragged.position.x, grid[0]),
      y: snap(dragged.position.y, grid[1]),
    },
    bounds,
  );
  const peers = nodes.filter(
    (node) =>
      node.id !== dragged.id &&
      (node.parentId ?? null) === (dragged.parentId ?? null),
  );
  const isFree = (position: { x: number; y: number }) => {
    const candidate = nodeRect(dragged, position);
    return peers.every(
      (peer) => !overlapsWithGap(candidate, nodeRect(peer), gap),
    );
  };

  let resolved = desired;
  if (!isFree(resolved)) {
    search: for (let ring = 1; ring <= maxRings; ring += 1) {
      for (const offset of candidateOffsets(ring, grid)) {
        const candidate = clampToBounds(
          {
            x: desired.x + offset.x,
            y: desired.y + offset.y,
          },
          bounds,
        );
        if (isFree(candidate)) {
          resolved = candidate;
          break search;
        }
      }
    }
  }

  if (
    dragged.position.x === resolved.x &&
    dragged.position.y === resolved.y
  ) {
    return nodes;
  }

  return nodes.map((node) =>
    node.id === draggedId ? { ...node, position: resolved } : node,
  );
}
