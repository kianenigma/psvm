import { parse as parseYaml } from 'yaml';

/** A crate entry of a prdoc's `crates:` list. */
export interface PrdocCrate {
  name: string;
  /** `major`, `minor`, `patch` or `none`. */
  bump?: string;
}

/** The `crates:` list of a prdoc (YAML); empty if it has none or does not parse. */
export function parsePrdocCrates(prdoc: string): PrdocCrate[] {
  let doc: { crates?: { name?: unknown; bump?: unknown }[] } | null;
  try {
    doc = parseYaml(prdoc);
  } catch {
    return [];
  }
  return (Array.isArray(doc?.crates) ? doc.crates : [])
    .filter((c) => typeof c?.name === 'string' && c.name)
    .map((c) => ({ name: c.name as string, bump: typeof c.bump === 'string' ? c.bump : undefined }));
}
