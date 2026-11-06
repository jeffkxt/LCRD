/** Synthetic plugin surface for the example benchmark; not the shipped implementation. */
export const name = 'lcrd-hard-isolation'

export const configDefaults = {
  maxRetries: 10,
  evolveHoldoutSize: 5,
  evolveMaxSkills: 8,
  evolveGateMaxWallMs: 3_600_000,
}
