# Sokoban Solver — push-optimal, room by room

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org)
[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

Entry for the [make.fun bounty "Build the best Sokoban solver"](https://make.fun/bounty/sokoban-solver-01-run-20261121)
($100, top 10 places win $10 each): a single `main.ts` (Node 22, no
dependencies) that solves a set of 5 Sokoban levels in one run, in as few
pushes as possible.

## How it works

The key observation is the generator's structure: every level is a
one-square-wide hallway with 1–4 rooms off it (3–4 boxes each). A box pushed
out of a room's door into the hallway can never be pushed back, so each room
is an independent puzzle and the level's push-optimum P\* is the sum of the
rooms' optima. Searching the whole level meets the *product* of the rooms'
state spaces; solving room by room meets only their *sum*.

1. **Split into rooms.** The hallway's dead squares (squares of the player's
   row from which no box can ever reach a goal) are cut out of the floor;
   each remaining component holding boxes is a room.
2. **Push-optimal A\* per room.** A state is the sorted box squares plus the
   player's reachable region, named by its lowest square. The heuristic is
   the minimum-cost assignment of boxes to goals under Manhattan distance
   (brute-forced over the ≤ 4! permutations). One push moves one box one
   square, so the assignment cost drops by at most 1 per push: the heuristic
   is admissible and consistent, so the first solved state popped is
   push-optimal for that room.
3. **Deadlock pruning.** Dead squares (reverse pull-reachability from the
   goals — a box there can never be goaled) and frozen 2×2 blocks. Neither
   prunes a solvable state, so optimality stands.
4. **Stitching.** Rooms are solved in turn with the other rooms' boxes as
   walls (solved rooms' boxes sit on their goals). The player walks on from
   where the last room left them; the concatenated moves solve the level in
   exactly the summed room optima — i.e. in P\* pushes.
5. **Fallbacks.** If a room search ever exhausts its state budget, a greedy
   best-first search tries to at least solve the room; if the level is no
   set of rooms, a whole-level search runs. An unsolved level still gets a
   valid (empty) answer file, so the other instances keep their points.

Deterministic by construction: fixed iteration orders, work budgets counted
in expanded states (never the wall clock), no randomness, no environment
reads apart from the input/output directories the harness specifies. Two runs
on the same input produce byte-identical outputs.

## Run it

```sh
node main.ts
# reads  /input/<id>/level.txt   (or $MAKEFUN_INPUT_DIR)
# writes /output/<id>/solution.txt (or $MAKEFUN_OUTPUT_DIR)
```

Local check against the kit's practice set:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Test results

| Set | Levels | Solved at P\* | Score |
| --- | ------ | ------------- | ----- |
| Kit practice set (P\* = 13/16/29/47/60) | 5 | 5 / 5 | **1,000,000 / 1,000,000** |
| 10 freshly drawn sets from the kit's own generator | 50 | 50 / 50 | 1,000,000 mean |
| House baseline `plain-astar` on the practice set | 5 | 1 / 5 | 200,000 |

Whole practice set solves in ~0.35 s on one CPU (limit is 60 s for the set);
a fresh 5-level set takes ~0.5 s. Every solution was replayed with the kit's
own checker (`program/scorer/checker/check.mjs`) and verified legal and
push-optimal against each level's key.

## Files

- `main.ts` — the whole solver (the entrypoint the grader runs).
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entrant's wallet, proving repository ownership.
