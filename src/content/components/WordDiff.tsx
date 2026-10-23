import { useMemo } from 'react';
import { diffWordsWithSpace } from 'diff';
import { joinChanges } from '../lib/inlineDiff';

export function WordDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = useMemo(() => joinChanges(diffWordsWithSpace(oldText, newText)), [oldText, newText]);
  return (
    <span className="mdr-worddiff">
      {parts.map((p, i) =>
        p.added ? (
          <ins key={i} className="mdr-d-ins">{p.value}</ins>
        ) : p.removed ? (
          <del key={i} className="mdr-d-del">{p.value}</del>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </span>
  );
}
