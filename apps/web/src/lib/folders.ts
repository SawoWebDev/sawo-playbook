export interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  sopCount: number;
}

export interface FolderNode extends FolderRow {
  children: FolderNode[];
  depth: number;
}

export function buildTree(rows: FolderRow[]): FolderNode[] {
  const byId = new Map<string, FolderNode>(rows.map((r) => [r.id, { ...r, children: [], depth: 0 }]));
  const roots: FolderNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const setDepth = (nodes: FolderNode[], d: number) =>
    nodes
      .sort((x, y) => x.name.localeCompare(y.name))
      .forEach((n) => {
        n.depth = d;
        setDepth(n.children, d + 1);
      });
  setDepth(roots, 0);
  return roots;
}

/** Depth-first flattening for <select> options with indentation. */
export function flatten(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

export function folderPath(rows: FolderRow[], id: string | null | undefined): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parts: string[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur && parts.length < 20) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}
