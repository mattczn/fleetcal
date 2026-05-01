'use client';

import { useState } from 'react';

export default function CopyChip({
  value,
  style,
}: {
  value: string;
  style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span
      onClick={handleClick}
      title="Click to copy"
      style={{
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'opacity 120ms',
        opacity: copied ? 0.7 : 1,
        ...style,
      }}
    >
      {copied ? '✓ Copied' : `#${value}`}
    </span>
  );
}
