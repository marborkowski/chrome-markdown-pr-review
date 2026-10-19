import { useMemo } from 'react';
import { diffWordsWithSpace } from 'diff';

export function WordDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => diffWordsWithSpace(oldText, newText), [oldText, newText]);
  return (
    <span className="mdr-worddiff">
      {parts.map((p, i) =>
        p.added ? (
          <ins key={i}>{p.value}</ins>
        ) : p.removed ? (
          <del key={i}>{p.value}</del>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </span>
  );
}
