'use client';

/**
 * Shared bucket picker. Renders every expense_buckets row for the org
 * as a tree-indented dropdown. Used everywhere entries + rules need to
 * choose a bucket.
 *
 * Caches the tree per-mount to avoid a fetch storm when many editors
 * mount at once (recurring panel, one-time panel, etc.).
 */

import { useEffect, useState } from 'react';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { railway } from '@/lib/railway';
import type { ExpenseBucketTreeNode } from '@fleetcal/types';

let cachedTree: ExpenseBucketTreeNode[] | null = null;
let inflight: Promise<ExpenseBucketTreeNode[]> | null = null;

async function loadTree(force = false): Promise<ExpenseBucketTreeNode[]> {
  if (!force && cachedTree) return cachedTree;
  if (!force && inflight) return inflight;
  inflight = railway.listExpenseBuckets().then(r => {
    cachedTree = r.tree;
    inflight = null;
    return r.tree;
  }).catch(err => {
    inflight = null;
    throw err;
  });
  return inflight;
}

/** Invalidate the module cache so the next mount refetches. Call this
 *  after mutations in the bucket editor. */
export function invalidateBucketCache() {
  cachedTree = null;
  inflight = null;
}

interface Props {
  value:    string;
  onChange: (bucketId: string) => void;
  /** Set to true to include a leading "— Uncategorized —" option (used
   *  by CardSpendTabContent's row-level bucket picker). Value is
   *  the empty string for that choice. */
  includeUncategorized?: boolean;
  disabled?: boolean;
  style?:    React.CSSProperties;
  /** Filter to only top-level buckets. Useful for the bucket-manager
   *  "parent" picker. */
  topLevelOnly?: boolean;
}

export default function BucketSelect({
  value, onChange, includeUncategorized = false, disabled = false, style, topLevelOnly = false,
}: Props) {
  const [tree, setTree]     = useState<ExpenseBucketTreeNode[]>(cachedTree ?? []);
  const [loading, setLoading] = useState(!cachedTree);

  useEffect(() => {
    let cancelled = false;
    if (cachedTree) return;
    setLoading(true);
    loadTree()
      .then(t => { if (!cancelled) { setTree(t); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <StyledSelect
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled || loading}
      style={style}
    >
      {includeUncategorized && <option value="">— Uncategorized —</option>}
      {tree.map(node => (
        <optgroup key={node.bucket.id} label={node.bucket.name}>
          <option value={node.bucket.id}>{node.bucket.name}</option>
          {!topLevelOnly && node.children.map(child => (
            <option key={child.id} value={child.id}>
              {'  '}↳ {child.name}
            </option>
          ))}
        </optgroup>
      ))}
      {tree.length === 0 && !loading && (
        <option value="">No buckets configured</option>
      )}
    </StyledSelect>
  );
}
