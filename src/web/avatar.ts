/**
 * A stable, local identicon seeded by an employee's immutable id.
 *
 * FNV-1a consumes Unicode code points (rather than UTF-16 code units), and the
 * resulting hash seeds a small xorshift32 stream for the mirrored 5×5 grid.
 */
export function generateEmployeeAvatar(
  seed: string,
): { palette: number; cells: readonly { x: number; y: number; tone: 0 | 1 }[] } {
  let hash = 0x811c9dc5;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193) >>> 0;
  }

  let randomState = hash === 0 ? 0x9e3779b9 : hash;
  const next = (): number => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    randomState >>>= 0;
    return randomState;
  };

  const cells: { x: number; y: number; tone: 0 | 1 }[] = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const filled = (next() & 1) === 1 || (x === 2 && y === 2);
      const tone = (next() & 1) as 0 | 1;
      if (!filled) continue;
      cells.push({ x, y, tone });
      if (x !== 2) cells.push({ x: 4 - x, y, tone });
    }
  }

  return { palette: hash % 6, cells };
}
