"use client";
import React from "react";

export type ImageVariant = { url: string; width: number };

export function ResponsiveImage({
  variants,
  alt,
  className,
  sizes = "100vw",
  loading = "lazy",
}: {
  variants: ImageVariant[];
  alt: string;
  className?: string;
  sizes?: string;
  loading?: "lazy" | "eager";
}) {
  const sorted = React.useMemo(
    () => [...variants].sort((a, b) => a.width - b.width),
    [variants]
  );
  const srcSet = sorted.map((v) => `${v.url} ${v.width}w`).join(", ");
  const src = sorted[sorted.length - 1]?.url || sorted[0]?.url || "";

  return (
    <img
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      alt={alt}
      loading={loading}
      decoding="async"
      className={className}
    />
  );
}

