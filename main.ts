// Sokoban solver: room-decomposed, push-optimal A*.
//
// Why this shape: make.fun's generator builds every level as a 1-wide hallway
// with 1-4 independent rooms off it (3-4 boxes each). A box pushed out of a
// room's door into the hallway can never come back, so each room is its own
// puzzle and the level's push-optimum P* is the sum of the rooms' optima.
// Searching the whole level at once meets the product of the rooms' state
// spaces; solving room by room meets only their sum.
//
// Per room we run A* over pushes (not moves): a state is the sorted box
// squares plus the player's reachable region, named by its lowest square.
// The heuristic is the minimum-cost assignment of boxes to goals under
// Manhattan distance (brute-forced over the <= 4! permutations). Each push
// moves one box one square, so the assignment cost can drop by at most 1 per
// push: the heuristic is admissible and consistent, so the first solved state
// A* pops is push-optimal for that room. Deadlock pruning: dead squares
// (reverse pull-reachability from the goals), frozen 2x2 blocks, and frozen
// boxes (a box blocked in both axes by walls or frozen neighbours, off its
// goal — it can never move again).
//
// Deterministic by construction: fixed iteration orders, a work budget counted
// in expanded states (never the wall clock), no randomness, no environment
// reads apart from the input/output directories the harness specifies.
// Run: node main.ts  (Node 22; MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// override /input and /output, as the kit's starter does.)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets, counted in expanded states: deterministic, never the clock. */
const MAX_EXPANSIONS_PER_ROOM = 300_000;
const MAX_EXPANSIONS_TOTAL = 2_000_000;
/** Fallback greedy search budget (best-first on the heuristic alone). */
const MAX_EXPANSIONS_GREEDY = 200_000;

type Dir = [number, number, string, string];
const DIRS: Dir[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text. Short rows and the outer frame count as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Live squares: squares from which a box alone can be pushed onto some goal.
 * Found by pulling boxes backwards from the goals over open floor. A box on
 * any other square is dead: no sequence of pushes can ever goal it.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Flood fill from `from` around walls and boxes; returns the lowest square reached. */
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // Neighbours, in fixed order; index arithmetic stays in-bounds because
    // the outer frame is always wall.
    if (wall[p - w] === 0 && occupied[p - w] === 0 && seen[p - w] !== stamp) {
      seen[p - w] = stamp;
      stack[n++] = p - w;
    }
    if (wall[p + w] === 0 && occupied[p + w] === 0 && seen[p + w] !== stamp) {
      seen[p + w] = stamp;
      stack[n++] = p + w;
    }
    if (wall[p - 1] === 0 && occupied[p - 1] === 0 && seen[p - 1] !== stamp) {
      seen[p - 1] = stamp;
      stack[n++] = p - 1;
    }
    if (wall[p + 1] === 0 && occupied[p + 1] === 0 && seen[p + 1] !== stamp) {
      seen[p + 1] = stamp;
      stack[n++] = p + 1;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares
 * of walls and boxes with a box among them off its goal. Such a block can
 * never change, so the state is dead.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Whether any box is frozen off its goal: a box is frozen when it is blocked
 * in both axes by walls or by boxes that are themselves frozen (computed to a
 * fixpoint). A frozen box can never move again, so a frozen box off its goal
 * makes the state dead. A frozen box on a goal is fine — it stays goaled.
 * Sound: a non-frozen neighbour might still move away, so only walls and
 * already-frozen boxes count as blocking.
 */
function frozenOffGoal(level: Level, occupied: Uint8Array, goal: Uint8Array, boxes: number[]): boolean {
  const { w, wall } = level;
  const frozen = new Set<number>();
  const blocked = (q: number): boolean => wall[q] === 1 || (occupied[q] === 1 && frozen.has(q));
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen.has(b)) continue;
      if (blocked(b - 1) && blocked(b + 1) && blocked(b - w) && blocked(b + w)) {
        frozen.add(b);
        changed = true;
      }
    }
  }
  for (const b of frozen) if (!goal[b]) return true;
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes; lower-case LURD. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** All permutations of [0..n), generated once, in lexicographic order. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i]!, a[k]!];
      gen(k + 1);
      [a[k], a[i]] = [a[i]!, a[k]!];
    }
  };
  gen(0);
  return out;
}

/**
 * Push search over one (sub-)level. A* when `greedy` is false (admissible
 * assignment heuristic: push-optimal), best-first on the heuristic alone when
 * true (a fast fallback that may overshoot). Returns {pushes, moves} or null
 * when the state budget runs out or no solution exists.
 *
 * `budget` is a shared counter object so the whole run stays inside one
 * deterministic work budget.
 */
function pushSearch(
  level: Level,
  maxExpansions: number,
  greedy: boolean,
  budget: { left: number },
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const perms = n <= 5 ? permutations(n) : null;
  // Manhattan distance from every square to every goal, precomputed once:
  // the heuristic is evaluated for every generated state.
  const distToGoal = new Int32Array(size * n);
  for (let s = 0; s < size; s++) {
    for (let gi = 0; gi < n; gi++) {
      distToGoal[s * n + gi] = Math.abs((s % w) - (goals[gi]! % w)) + Math.abs(Math.floor(s / w) - Math.floor(goals[gi]! / w));
    }
  }
  // Minimum-cost assignment of boxes to goals (distinct goals), Manhattan.
  // With > 5 boxes the permutations explode, so fall back to the weaker but
  // still admissible sum of each box's nearest-goal distance.
  const heuristic = (boxes: number[]): number => {
    if (perms !== null) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) s += distToGoal[boxes[i]! * n + p[i]!]!;
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let gi = 0; gi < n; gi++) {
        const d = distToGoal[boxes[i]! * n + gi]!;
        if (d < m) m = d;
      }
      s += m;
    }
    return s;
  };
  const onGoal = (boxes: number[]): number => {
    let c = 0;
    for (const b of boxes) if (goal[b]) c++;
    return c;
  };

  const occupied = new Uint8Array(size);
  for (const b of level.boxes) occupied[b] = 1;
  if (frozenOffGoal(level, occupied, goal, level.boxes)) return null;
  for (const b of level.boxes) occupied[b] = 0;
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // State key: region-low plus box squares as digits in base `size`.
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const boxesList: number[][] = [level.boxes.slice()];
  const playerList: number[] = [level.player];
  const gList: number[] = [0];
  const hList: number[] = [heuristic(level.boxes)];
  const onGoalList: number[] = [onGoal(level.boxes)];
  const keyList: number[] = [];
  const parent: number[] = [-1];
  const closed = new Map<number, number>(); // key -> best g seen

  // Binary heap of state indices, ordered by (f, -g, -onGoal, insertion).
  // f = g + h for A*, f = h for greedy.
  const heap: number[] = [];
  const seq: number[] = [0];
  let seqCounter = 1;
  const score = (s: number): number => (greedy ? hList[s]! : gList[s]! + hList[s]!);
  const less = (a: number, b: number): boolean => {
    const fa = score(a);
    const fb = score(b);
    if (fa !== fb) return fa < fb;
    if (gList[a] !== gList[b]) return gList[a]! > gList[b]!;
    if (onGoalList[a] !== onGoalList[b]) return onGoalList[a]! > onGoalList[b]!;
    return seq[a]! < seq[b]!;
  };
  const heapPush = (s: number): void => {
    heap.push(s);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reachLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  keyList.push(keyOf(level.boxes, low0));
  closed.set(keyList[0]!, 0);
  heapPush(0);

  let expanded = 0;
  while (heap.length > 0) {
    if (expanded >= maxExpansions || budget.left <= 0) return null;
    const s = heapPop();
    const boxes = boxesList[s]!;
    const g = gList[s]!;
    // A stale heap entry (a better g for this state was recorded since).
    if (closed.get(keyList[s]!) !== g) continue;
    if (solved(boxes)) {
      // Rebuild the push path, then the moves: walk to each push square, push.
      const path: number[] = [];
      for (let t = s; t > 0; t = parent[t]!) path.push(t);
      path.reverse();
      let moves = '';
      let player = level.player;
      let cur = level.boxes.slice();
      for (const t of path) {
        const nextBoxes = boxesList[t]!;
        const from = cur.find((b) => !nextBoxes.includes(b))!;
        const to = nextBoxes.find((b) => !cur.includes(b))!;
        const d = to - from;
        const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
        for (const b of cur) occupied[b] = 1;
        moves += walkTo(level, occupied, player, from - d);
        for (const b of cur) occupied[b] = 0;
        moves += dir[3];
        player = from;
        cur = nextBoxes;
      }
      return { pushes: path.length, moves };
    }
    expanded++;
    budget.left--;
    // Reachability from the player's square with the boxes as walls.
    for (const b of boxes) occupied[b] = 1;
    reachLow(level, occupied, playerList[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        // The player must reach the square behind the box, and the box must
        // land on open, live floor.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          // Freeze deadlock: a box that can never move again, off its goal.
          if (!frozenOffGoal(level, occupied, goal, next)) {
            low = reachLow(level, occupied, b, mark, ++stamp, stack);
            key = keyOf(next, low);
          } else {
            next = null;
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const prevG = closed.get(key);
        if (prevG !== undefined && prevG <= g + 1) continue;
        closed.set(key, g + 1);
        const idx = boxesList.length;
        boxesList.push(next);
        playerList.push(b);
        gList.push(g + 1);
        hList.push(heuristic(next));
        onGoalList.push(onGoal(next));
        keyList.push(key);
        parent.push(s);
        seq.push(seqCounter++);
        heapPush(idx);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

/**
 * Split a level into rooms: cut the hallway's dead squares (the player's row
 * squares no box can ever reach a goal from) out of the floor; each remaining
 * component holding boxes is a room. Null when the level is no set of rooms
 * (a box starts in the hallway, or a component's boxes and goals mismatch).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** Solve one level's XSB text; always returns a (possibly empty) move string. */
function solve(text: string): string {
  const level = parseLevel(text);
  const budget = { left: MAX_EXPANSIONS_TOTAL };
  if (level.boxes.every((b) => level.goals.includes(b))) return '';

  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      // The other rooms' boxes stand as walls: unsolved rooms' boxes where
      // they started, solved rooms' boxes on their goals (where they now sit).
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved =
        pushSearch(sub, MAX_EXPANSIONS_PER_ROOM, false, budget) ??
        pushSearch(sub, MAX_EXPANSIONS_GREEDY, true, budget);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.boxes = room.goals.slice().sort((a, b) => a - b);
    }
    if (ok) return moves;
    // A room failed: fall through to a whole-level attempt below.
  }

  const whole =
    pushSearch(level, MAX_EXPANSIONS_PER_ROOM, false, budget) ??
    pushSearch(level, MAX_EXPANSIONS_GREEDY, true, budget);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
