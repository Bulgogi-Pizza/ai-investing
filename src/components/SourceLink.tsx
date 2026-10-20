import type { CSSProperties, ReactNode } from 'react';

/** External links from server data render only for https URLs; anything else is plain text. */
export const isHttpsUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('https://');

export function SourceLink({
  url,
  children,
  title,
  style,
}: {
  url: unknown;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
}) {
  return isHttpsUrl(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer" title={title} style={style}>
      {children}
    </a>
  ) : (
    <span title={title} style={style}>
      {children}
    </span>
  );
}
