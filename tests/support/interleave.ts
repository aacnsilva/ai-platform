export interface Actor<World> {
  name: string;
  steps: readonly ((world: World) => World)[];
  mayStop: boolean;
}

export interface Visit<World> {
  world: World;
  trace: readonly string[];
  finished: boolean;
}

interface Node<World> {
  world: World;
  positions: readonly number[];
  trace: readonly string[];
}

const moved = (positions: readonly number[], index: number, to: number): number[] =>
  positions.map((position, at) => (at === index ? to : position));

const nextNodes = <World>(node: Node<World>, actors: readonly Actor<World>[]): Node<World>[] =>
  actors.flatMap((actor, index) => {
    const position = node.positions[index] ?? 0;
    const step = actor.steps[position];
    if (step === undefined) {
      return [];
    }
    const taken = {
      world: step(node.world),
      positions: moved(node.positions, index, position + 1),
      trace: [...node.trace, `${actor.name}:${String(position)}`],
    };
    const stopped = {
      world: node.world,
      positions: moved(node.positions, index, actor.steps.length),
      trace: [...node.trace, `${actor.name}:stops`],
    };
    return actor.mayStop && position > 0 ? [taken, stopped] : [taken];
  });

export const explore = <World>(
  start: World,
  actors: readonly Actor<World>[],
  visit: (visit: Visit<World>) => void,
): number => {
  const pending: Node<World>[] = [{ world: start, positions: actors.map(() => 0), trace: [] }];
  let finished = 0;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const following = nextNodes(node, actors);
    visit({ world: node.world, trace: node.trace, finished: following.length === 0 });
    finished += following.length === 0 ? 1 : 0;
    pending.push(...following);
  }
  return finished;
};
